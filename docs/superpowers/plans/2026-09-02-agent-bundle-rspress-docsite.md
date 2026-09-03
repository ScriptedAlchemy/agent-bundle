# Agent Bundle Rspress Docsite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a bilingual Rspress documentation site for agent-bundle with generated TypeScript API docs, type-aware examples, built-in validation, and AI-readable outputs.

**Architecture:** A private `website` pnpm workspace owns Rspress configuration, theme code, English and Chinese authored docs, and shared generated TypeDoc pages. The repository exposes isolated docs scripts, while a dedicated GitHub Pages workflow validates pull requests and deploys `website/doc_build` only from `main`.

**Tech Stack:** Rspress 2.0.21, React 19.2.8, TypeScript 6.0.3, `@rspress/plugin-llms`, `@rspress/plugin-twoslash`, `@rspress/plugin-typedoc`, `@rspress/plugin-sitemap`, pnpm 11.23.0, GitHub Pages Actions.

## Global Constraints

- Node.js remains `>=22.19.0`; CI uses Node 22.19.0.
- The production URL is `https://scriptedalchemy.github.io/agent-bundle/`.
- The Rspress `siteOrigin` is `https://scriptedalchemy.github.io` and `base` is `/agent-bundle/`.
- Hand-authored documentation has complete English and Simplified Chinese route parity.
- Shared generated TypeDoc pages document every public package export entry module.
- Use built-in local search; do not add Algolia.
- Enable dead-link, dead-anchor, dead-image, and language-parity checks.
- Enable locale-aware `llms.txt`, `llms-full.txt`, route Markdown, Twoslash, and sitemap generation.
- Keep docs builds separate from the npm package-release `build` command.
- Links from website pages to repository files outside the Rspress docs root use absolute `https://github.com/ScriptedAlchemy/agent-bundle/blob/main/...` URLs; relative links are reserved for intra-site navigation.
- Do not edit `repos/**`.
- Do not create commits unless the user explicitly requests them.
- Delegate straightforward scaffolding and mechanical work to Grok 4.6, difficult plugin/content/i18n work to Claude Opus 5, and reserve final integration and polish for GPT-5.6 Sol.

---

## File Map

### Workspace and build contract

- Modify `package.json`: add root docs scripts only.
- Modify `pnpm-workspace.yaml`: include `website`.
- Modify `pnpm-lock.yaml`: record the new workspace and dependencies through pnpm.
- Modify `.gitignore`: ignore Rspress output and generated TypeDoc Markdown.
- Create `website/package.json`: private docs package and scripts.
- Create `website/tsconfig.json`: isolated TypeScript 6 config for Rspress and theme code.
- Create `website/scripts/verify-build.mjs`: verify required static artifacts.

### Rspress application

- Create `website/rspress.config.ts`: site, locale, validation, plugin, search, and Pages configuration.
- Create `website/typedoc.json`: exactly one key pointing TypeDoc at the package build tsconfig.
- Create `website/plugins/mirror-api-locale.ts`: copy generated English API Markdown into the Chinese locale after TypeDoc runs.
- Create `website/theme/index.tsx`: import the theme stylesheet and re-export Rspress's original theme.
- Create `website/theme/index.css`: bounded agent-bundle brand tokens and homepage styling.
- Create `website/docs/public/logo.svg`: local light/dark-compatible site mark.
- Create `website/docs/en/api/_meta.json`: committed English API sidebar order.
- Create `website/docs/zh/api/_meta.json`: committed Chinese API sidebar order with localized labels.

### English and Chinese authored content

- Create `website/docs/{en,zh}/index.md`.
- Create `website/docs/{en,zh}/_nav.json`.
- Create `website/docs/{en,zh}/guide/_meta.json`.
- Create `website/docs/{en,zh}/guide/start/{_meta.json,index.mdx,installation.mdx,quick-start.mdx,project-structure.mdx}`.
- Create `website/docs/{en,zh}/guide/authoring/{_meta.json,index.mdx,skills.mdx,hooks.mdx,mcp.mdx,scripts-assets.mdx,package-entries.mdx}`.
- Create `website/docs/{en,zh}/guide/development/{_meta.json,index.mdx,workbench.mdx,testing.mdx,evaluations.mdx}`.
- Create `website/docs/{en,zh}/guide/distribution/{_meta.json,index.mdx,validation.mdx,installation.mdx,preview-packages.mdx}`.
- Create `website/docs/{en,zh}/reference/{_meta.json,index.mdx,cli.mdx,configuration.mdx,targets-artifacts.mdx,runtime-environment.mdx,security.mdx,limitations.mdx,api.mdx}`.
- Create `website/docs/{en,zh}/examples/{_meta.json,index.mdx,skills-starter.mdx,hooks-and-scripts.mdx,mcp-app.mdx,audiobook-curator.mdx}`.
- Create `website/docs/{en,zh}/contributing/{_meta.json,index.mdx}`.

### Delivery and discoverability

- Create `.github/workflows/docs.yml`: validate PRs and deploy main to Pages.
- Modify `README.md`: link to the hosted docs near the introduction.
- Modify `packages/agent-bundle/README.md`: link to the hosted docs.
- Modify `packages/agent-bundle/package.json`: set the package homepage to the hosted docs.

---

### Task 1: Scaffold the docs workspace and artifact contract

**Owner/model:** Grok 4.6 — mechanical workspace and package setup.

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Create: `website/package.json`
- Create: `website/tsconfig.json`
- Create: `website/scripts/verify-build.mjs`

**Interfaces:**
- Produces: root `docs:dev`, `docs:build`, `docs:preview`, and `docs:check` commands.
- Produces: `@agent-bundle/docs` workspace with local TypeScript 6 despite the repository's root TypeScript 7.
- Produces: a persistent output assertion used after every production build.

- [ ] **Step 1: Add the failing static-output verifier**

Create `website/scripts/verify-build.mjs` with Node built-ins only. It must check these paths relative to `website/doc_build` and report every missing artifact in one failure:

```js
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(websiteRoot, 'doc_build');
const requiredArtifacts = [
  'index.html',
  'zh/index.html',
  'api/index.html',
  'zh/api/index.html',
  'llms.txt',
  'llms-full.txt',
  'zh/llms.txt',
  'zh/llms-full.txt',
  'sitemap.xml',
];

const missing = [];
for (const artifact of requiredArtifacts) {
  try {
    await access(path.join(outputRoot, artifact));
  } catch {
    missing.push(artifact);
  }
}

if (missing.length > 0) {
  throw new Error(`Missing documentation build artifacts:\n- ${missing.join('\n- ')}`);
}

console.log(`Verified ${requiredArtifacts.length} documentation build artifacts.`);
```

- [ ] **Step 2: Verify the output contract fails before the site exists**

Run:

```bash
node website/scripts/verify-build.mjs
```

Expected: non-zero exit with all nine required artifacts listed as missing.

This script is the mandatory backstop for a known upstream behavior:
`@rspress/plugin-typedoc@2.0.21` calls `app.convert()` and simply skips output
when conversion fails, so a broken TypeDoc run otherwise produces a green
build with no API reference. Task 2 extends this script with one generated
module page per public package export.

> **Deviation (Task 7):** the verifier was removed in favor of checks Rspress
> already runs. A TypeDoc run that produces no output fails `rspress build`
> during sidebar resolution, because the hand-authored
> `website/docs/{en,zh}/api/_meta.json` name the generated directories; a
> partial run fails the dead-link check, because the Reference pages link to
> specific generated module and interface pages, and the Reference overview
> links every generated reference page. Both were verified by breaking the
> TypeDoc entry points and building.

- [ ] **Step 3: Create the private website package**

Create `website/package.json` with:

```json
{
  "name": "@agent-bundle/docs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.19.0"
  },
  "scripts": {
    "build": "rspress build",
    "check": "pnpm typecheck && pnpm build && pnpm verify:build",
    "dev": "rspress dev",
    "preview": "rspress preview",
    "typecheck": "tsc --project tsconfig.json",
    "verify:build": "node scripts/verify-build.mjs"
  },
  "devDependencies": {
    "@rspress/core": "2.0.21",
    "@rspress/plugin-llms": "2.0.21",
    "@rspress/plugin-sitemap": "2.0.21",
    "@rspress/plugin-twoslash": "2.0.21",
    "@rspress/plugin-typedoc": "2.0.21",
    "@types/node": "26.4.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "agent-bundle": "workspace:*",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "typescript": "6.0.3"
  }
}
```

TypeScript 6.0.3 is package-local and intentional: `@rspress/plugin-twoslash@2.0.21` declares `typescript: ^6.0.3`, while the repository root currently uses TypeScript 7.

- [ ] **Step 4: Create the isolated website TypeScript config**

Create `website/tsconfig.json`:

```json
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2024",
    "types": ["node", "react"]
  },
  "include": ["rspress.config.ts", "theme/**/*.ts", "theme/**/*.tsx"]
}
```

- [ ] **Step 5: Register the workspace and root scripts**

Add `website` to `pnpm-workspace.yaml`.

Add to root `package.json`:

```json
{
  "scripts": {
    "docs:build": "pnpm --filter @agent-bundle/docs build",
    "docs:check": "pnpm --filter @agent-bundle/docs check",
    "docs:dev": "pnpm --filter @agent-bundle/docs dev",
    "docs:preview": "pnpm --filter @agent-bundle/docs preview"
  }
}
```

Do not modify the existing root `build` or `check` command composition.

- [ ] **Step 6: Ignore generated outputs**

Append:

```gitignore
website/doc_build/
website/docs/en/api/**/*.md
website/docs/zh/api/**/*.md
```

The `**/*.md` scoping is deliberate: the committed
`website/docs/en/api/_meta.json` and `website/docs/zh/api/_meta.json` files
must stay tracked.

- [ ] **Step 7: Install and lock dependencies**

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` records the `website` importer and all five Rspress packages at 2.0.21 without peer-dependency warnings.

If installation is blocked by the workspace minimum-release-age policy for a
freshly published `@rspress/*` patch, add the exact blocked versions to
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` rather than downgrading.

- [ ] **Step 8: Verify workspace command wiring**

Run:

```bash
pnpm --filter @agent-bundle/docs typecheck
```

Expected: fail because `website/rspress.config.ts` does not exist yet. This confirms the workspace resolves and the next task owns the missing application.

---

### Task 2: Configure Rspress, plugins, shared API generation, and the lean theme

**Owner/model:** Claude Opus 5 — plugin compatibility, i18n, and TypeDoc are the highest-risk configuration work.

**Files:**
- Create: `website/rspress.config.ts`
- Create: `website/typedoc.json`
- Create: `website/plugins/mirror-api-locale.ts`
- Create: `website/theme/index.tsx`
- Create: `website/theme/index.css`
- Create: `website/docs/public/logo.svg`
- Create: `website/docs/en/api/_meta.json`
- Create: `website/docs/zh/api/_meta.json`
- Modify: `website/scripts/verify-build.mjs`
- Create: `website/docs/en/index.md`
- Create: `website/docs/zh/index.md`
- Create: `website/docs/en/_nav.json`
- Create: `website/docs/zh/_nav.json`
- Create: initial locale section `_meta.json` files from the File Map

**Interfaces:**
- Consumes: the `@agent-bundle/docs` package and TypeScript 6 toolchain from Task 1.
- Produces: `rspress build` output under `website/doc_build`.
- Produces: shared `/api/` TypeDoc routes and locale-aware LLM outputs.

- [ ] **Step 1: Add minimal paired locale routes and navigation metadata**

Create English and Chinese homepages with `pageType: home`, matching hero actions, and matching feature-card links. Create `_nav.json` files with locale-appropriate labels and identical route targets for Guide, Reference, Examples, Contributing, and shared Type API.

Create every section directory and `_meta.json` listed in the File Map before enabling language parity. Page-order arrays must name only pages that exist by the end of the owning content task.

- [ ] **Step 2: Add the per-locale generated API sidebars**

Rspress i18n requires every content directory to live under a locale root, so
the generated reference lives at `docs/en/api` (route `/api/`) and is mirrored
to `docs/zh/api` (route `/zh/api/`). Create `website/docs/en/api/_meta.json`:

```json
[
  "index",
  {
    "type": "dir",
    "name": "modules",
    "label": "Modules"
  },
  {
    "type": "dir",
    "name": "functions",
    "label": "Functions"
  },
  {
    "type": "dir",
    "name": "interfaces",
    "label": "Interfaces"
  },
  {
    "type": "dir",
    "name": "type-aliases",
    "label": "Type aliases"
  }
]
```

Create `website/docs/zh/api/_meta.json` with the same entries and localized
`label` values. `pluginTypeDoc` writes `_meta.json` only when absent, so both
committed files are stable — but that also means a newly added package export
never appears in the sidebar until both files are hand-updated; the verify
script's per-export assertion is what makes that failure loud.

After the first TypeDoc run, reconcile both lists with directories TypeDoc actually generated; remove nonexistent directory entries rather than suppressing dead-link checks.

- [ ] **Step 3: Configure Rspress and all approved plugins**

Create `website/rspress.config.ts` with top-level imports only and:

- `root: path.join(import.meta.dirname, 'docs')`
- `siteOrigin: 'https://scriptedalchemy.github.io'`
- `base: '/agent-bundle/'`
- English default locale and Simplified Chinese locale
- local logo and `logoText: 'agent-bundle'`
- `search: { codeBlocks: true }`
- `route: { cleanUrls: true, localeRedirect: 'never' }`
- `markdown.link.checkDeadLinks` excluding generated LLM text targets (dead-link and dead-image checks default on; the excludes list and `checkAnchors` are the real opt-ins)
- `markdown.link.checkAnchors: true`
- `markdown.image.checkDeadImages: true`
- `languageParity.enabled: true` (the published type is `enabled`; `enable` is silently ignored)
- `languageParity.include` covering `index.md`, `guide`, `reference`, `examples`, and `contributing`
- `languageParity.exclude: ['api']` — generated pages are identical by design and only `_meta.json` is tracked
- GitHub edit link and social link
- `themeConfig.llmsUI: { placement: 'outline' }`
- keep the core `llms` option at its default `false`; enabling it alongside `pluginLlms` double-generates

Register plugins in generation order:

1. `pluginTypeDoc`
2. the local `mirrorApiLocale` plugin
3. `pluginTwoslash`
4. `pluginLlms`
5. `pluginSitemap`

TypeDoc entry points are exactly:

```ts
const packageSource = path.join(
  import.meta.dirname,
  '..',
  'packages',
  'agent-bundle',
  'src',
);

const publicApiEntryPoints = [
  'index.ts',
  'api.ts',
  'cli-entry.ts',
  'config/index.ts',
  'eval/index.ts',
  'mcp-apps.ts',
  'meta.ts',
  'mcp-entry.ts',
  'rstest/index.ts',
  'test/index.ts',
  'test/browser.ts',
].map(entry => path.join(packageSource, entry));
```

Configure `pluginTypeDoc` with `outDir: 'en/api'`. Do not include Rslib
entries that are absent from the package export map.

Create `website/typedoc.json` containing exactly:

```json
{
  "tsconfig": "../packages/agent-bundle/tsconfig.build.json"
}
```

This single key is load-bearing twice over. Without it, TypeDoc discovers
`website/tsconfig.json` from the working directory and compiles the package
sources under the wrong compiler settings. And it must stay a single key:
TypeDoc's config file wins over the plugin's inlined options, so any extra key
risks clobbering the plugin's markdown router settings. Verify explicitly
after the first build that markdown output is still generated with
`typedoc.json` present.

Create `website/plugins/mirror-api-locale.ts`, an Rspress plugin registered
immediately after `pluginTypeDoc`. In its `config` hook (after TypeDoc has
written `docs/en/api`), it copies every generated `.md` file from
`docs/en/api` into `docs/zh/api`, skipping `_meta.json` so the localized
Chinese sidebar stays authoritative. It first deletes previously mirrored
`.md` files under `docs/zh/api` (and stale generated `.md` under
`docs/en/api` is removed before regeneration by TypeDoc's own run plus this
cleanup), so removed package exports cannot leave phantom local routes.
Mirroring is preferred over a second `pluginTypeDoc` instance because a second
instance would run the whole TypeScript program twice per build.

Because generation runs in the `config` hook before route scanning, generated
pages exist before dead-link checking, so authored pages may safely link into
`/api/…` even though nothing generated is committed. The same placement means
every `rspress dev` startup pays a full TypeScript program build over the
package source graph; if that becomes painful for authoring, an optional
`DOCS_SKIP_API=1` gate around `pluginTypeDoc` plus the mirror is acceptable —
dev-only, never in `docs:check`. Generated API pages will also render an
"Edit this page" link pointing at generated paths that do not exist in the
repository; accept that knowingly for this iteration rather than patching the
theme.

Configure Twoslash as `pluginTwoslash()` with defaults (`explicitTrigger`
already defaults to `true`) plus source-mapped resolution so examples import
real public APIs without a prebuilt `dist`:

```ts
pluginTwoslash({
  twoslashOptions: {
    compilerOptions: {
      paths: {
        'agent-bundle': [path.join(packageSource, 'index.ts')],
        'agent-bundle/config': [path.join(packageSource, 'config/index.ts')],
        'agent-bundle/test': [path.join(packageSource, 'test/index.ts')],
        'agent-bundle/eval': [path.join(packageSource, 'eval/index.ts')],
      },
    },
  },
})
```

Do not add the package-release build to `docs:check`.

Use `pluginLlms` explicitly with its locale defaults (English root files,
Chinese files under `zh/`), excluding the generated reference so eleven entry
modules of API text do not dominate `llms-full.txt`:

```ts
pluginLlms({
  exclude: ({ page }) => page.routePath.includes('/api/'),
})
```

Use `pluginSitemap()` without duplicating the site URL because
`siteOrigin + base` already provides it.

- [ ] **Step 4: Add the lean theme and local logo**

`website/theme/index.tsx` contains only:

```tsx
import './index.css';

export * from '@rspress/core/theme-original';
```

The stylesheet defines agent-bundle brand variables for light and dark modes,
keeps readable contrast, and applies bounded homepage accent styling. The SVG
logo must use current color or provide light/dark-safe fills; it must not reuse
test-fixture artwork.

- [ ] **Step 5: Extend the verify script with per-export API assertions**

After observing the generated layout under `website/docs/en/api`, extend
`website/scripts/verify-build.mjs` so it asserts one generated module page in
`doc_build` for each of the eleven public export entry modules, in both
`api/` and `zh/api/`. This is the hard gate against `pluginTypeDoc`'s
silent-skip behavior and against sidebar drift when exports change.

- [ ] **Step 6: Typecheck and build**

Run:

```bash
pnpm --filter @agent-bundle/docs typecheck
pnpm --filter @agent-bundle/docs build
pnpm --filter @agent-bundle/docs verify:build
```

Expected: all pass, with the typecheck resolving the workspace-local
TypeScript 6.0.3 rather than the root TypeScript 7. Inspect
`website/docs/en/api` on disk and confirm TypeDoc actually produced module
pages. If TypeDoc's generated directory names differ from the curated API
`_meta.json` files, reconcile metadata and rerun; never weaken dead-link
checking. The likeliest real failure here is the package source graph
(including the `effect` 4 RC type surface) type-checking differently under
TypeScript 6 than under the repo's TypeScript 7 — if that happens, fix by
narrowing TypeDoc entry points or adjusting `typedoc.json`'s tsconfig target,
and surface the divergence rather than masking it.

---

### Task 3: Migrate bilingual Start and Authoring documentation

**Owner/model:** Claude Opus 5 — preserve technical meaning while producing complete Chinese parity.

**Files:**
- Create/modify: `website/docs/{en,zh}/guide/_meta.json`
- Create: all `website/docs/{en,zh}/guide/start/*` files from the File Map
- Create: all `website/docs/{en,zh}/guide/authoring/*` files from the File Map

Links to repository files outside the docs root (for example
`docs/entry-conventions.md`) must use absolute GitHub URLs — relative
filesystem links to them have no route and fail `checkDeadLinks`.

**Source material:**
- `README.md:1-76`
- `packages/agent-bundle/README.md:1-79`
- `docs/framework-mode.md`
- `docs/entry-conventions.md`

**Content contract:**
- Introduction explains one typed config compiled to Claude Code, Codex, Cursor, and portable artifacts.
- Installation clearly distinguishes pkg.pr.new preview installation from future npm commands.
- Quick start includes scaffolder and manual `defineConfig` paths.
- Project structure explains config, Skills, hooks, MCP, scripts, assets, routes, and output.
- Authoring pages cover the exact README contracts for Skills, hooks, MCP servers/apps, assets, scripts, `bin`, `lib`, framework stdio lifecycle, and the single bundler escape hatch.
- Every runnable TypeScript example that imports a public package entry uses an explicit `twoslash` code fence and resolves under the docs build.
- Chinese pages translate explanations while preserving commands, identifiers, paths, JSON keys, and host product names exactly.

- [ ] **Step 1: Write each English/Chinese page pair together**

Never land an English route without its Chinese counterpart. Keep heading
structure aligned so cross-locale anchors remain predictable.

- [ ] **Step 2: Update page-order metadata only after files exist**

Use filename arrays inside `start/_meta.json` and `authoring/_meta.json`.
Use `dir-section-header` records in `guide/_meta.json`. Task 2 shipped
`_nav.json` with only the Type API entry because no other routes existed;
this task must add the Guide entry to both locale `_nav.json` files — nav
links are not dead-link-checked, so nothing else will catch the omission.

- [ ] **Step 3: Validate the section**

Run:

```bash
pnpm docs:check
```

Expected: pass with Twoslash, links, anchors, images, and locale parity enabled.

---

### Task 4: Migrate bilingual Development, Distribution, and Reference documentation

**Owner/model:** Claude Opus 5 — this section contains the densest runtime, evidence, and security contracts.

**Files:**
- Create: all `website/docs/{en,zh}/guide/development/*` files from the File Map
- Create: all `website/docs/{en,zh}/guide/distribution/*` files from the File Map
- Create: all `website/docs/{en,zh}/reference/*` files from the File Map

**Source material:**
- `packages/agent-bundle/README.md:65-438`
- `docs/entry-conventions.md`
- `docs/framework-mode.md`
- `docs/preview-packages.md`
- `docs/diagnostics.md`

**Content contract:**
- Workbench documentation preserves loopback-only, foreground, epoch, MCP session, Playground trace, and Agent API boundaries.
- Testing documentation keeps route-unit, mcp-in-memory, cli-dispatch, packed-stdio, packed-deleted-source, and host-install proof levels distinct.
- Evaluation documentation preserves pass/fail/inconclusive semantics and authenticated native harness constraints.
- Distribution documentation covers build, artifact validation, strict Claude validation, generated installation docs, and host-specific install behavior.
- Reference pages capture CLI purpose, config semantics, target layouts, `AGENT_BUNDLE_PLUGIN_ROOT`, runtime floors, credential refusal, and current limitations.
- Both locale API landing pages link to the shared generated `/api/` reference and explain that source symbol comments remain in their authored language.

- [ ] **Step 1: Write paired Development pages and validate**

Run `pnpm docs:check`; expected pass.

- [ ] **Step 2: Write paired Distribution pages and validate**

Run `pnpm docs:check`; expected pass.

- [ ] **Step 3: Write paired Reference pages and validate**

Add the Reference entry to both locale `_nav.json` files (nav links are not
dead-link-checked). Run `pnpm docs:check`; expected pass.

---

### Task 5: Finish bilingual Examples, Contributing, and homepage polish

**Owner/model:** Claude Opus 5 for content accuracy; Grok 4.6 may perform metadata-only ordering after content exists.

**Files:**
- Create: all `website/docs/{en,zh}/examples/*` files from the File Map
- Create: all `website/docs/{en,zh}/contributing/*` files from the File Map
- Modify: `website/docs/{en,zh}/index.md`
- Modify: locale `_nav.json` and section `_meta.json`

**Source material:**
- `README.md:77-99`
- `examples/skills-starter/README.md`
- `examples/hooks-and-scripts/README.md`
- `examples/mcp-app/README.md`
- `examples/audiobook-curator/README.md`
- `docs/local-ci.md`

**Content contract:**
- Each example page states what it proves, its public package dependencies, its root run command, and its source link.
- Contributing pages document `pnpm check`, `pnpm check:release`, `pnpm check:local-ci`, Changesets, and the native-smoke boundary without presenting internal workflows as end-user requirements.
- Homepages use matching actions and feature links, polished English/Chinese copy, and no untranslated labels.

- [ ] **Step 1: Write paired example pages**

- [ ] **Step 2: Write paired contributing pages**

- [ ] **Step 3: Finalize both homepages and navigation metadata**

Family-parity requirements (rspress.rs / rslib.rs / rsbuild.rs conventions):
hero actions become Introduction (brand) and Quick start (alt) into the Guide,
GitHub moves out of the hero (social link already covers it); every feature
card gains a `link`; both locale `_nav.json` files carry Guide, Reference,
Examples, Contributing, and Type API entries.

- [ ] **Step 4: Run the complete docs gate**

Run:

```bash
pnpm docs:check
```

Expected: pass and verify all nine required build artifacts plus the
per-export API assertions.

---

### Task 6: Add GitHub Pages delivery and documentation entry links

**Owner/model:** Grok 4.6 — workflow and link updates are bounded, mechanical changes.

**Files:**
- Create: `.github/workflows/docs.yml`
- Modify: `scripts/classify-docs-only.mjs`
- Modify: `packages/agent-bundle/tests/classify-docs-only.test.ts`
- Modify: `README.md`
- Modify: `packages/agent-bundle/README.md`
- Modify: `packages/agent-bundle/package.json`

**Interfaces:**
- Consumes: `pnpm docs:check` and `website/doc_build`.
- Produces: PR validation and main-only Pages deployment.

- [ ] **Step 1: Add the Pages workflow**

Use:

- `actions/checkout@v7`
- `pnpm/setup@v2` with cache, `install: false`, and `runtime: node@22.19.0`
- `actions/configure-pages@v6`
- `actions/upload-pages-artifact@v5`
- `actions/deploy-pages@v5`

Run the workflow unconditionally on every pull request, every push to `main`,
and `workflow_dispatch` — no `paths:` filters. Path filtering would fail in
both directions: a `packages/agent-bundle/src/**` change can break TypeDoc
generation without touching `website/**`, and a path-filtered workflow can
never safely become a required status check.

The build job runs:

```bash
pnpm install --frozen-lockfile
pnpm docs:check
```

Upload the Pages artifact only for pushes to `main`. A dependent deploy job
runs only for `push` on `refs/heads/main`, uses the `github-pages`
environment with `url: ${{ steps.deployment.outputs.page_url }}`, and runs
configure/deploy Pages actions.

Permissions and concurrency:

- top level: `contents: read` (checkout needs it)
- deploy job additionally: `pages: write`, `id-token: write`
- build job concurrency: PR-keyed group with `cancel-in-progress` for pull
  requests, matching `ci.yml`'s existing pattern
- deploy job concurrency: `group: pages` with `cancel-in-progress: false` —
  never cancel an in-flight Pages deployment

Record one manual prerequisite in the workflow header comment: repository
Settings → Pages must be set to the "GitHub Actions" source before the first
deploy, or `deploy-pages` fails.

- [ ] **Step 2: Classify website-only PRs as docs-only in CI**

Add `website/` to the docs-only allowlist in `scripts/classify-docs-only.mjs`
so website-only PRs skip the heavy `verify`/`examples-check`/`release-gates`
jobs, which `docs.yml` now independently covers. Update
`packages/agent-bundle/tests/classify-docs-only.test.ts` in the same change —
the classifier is unit-tested and must stay green:

```bash
pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/classify-docs-only.test.ts
```

Expected: pass with new cases asserting `website/**` is docs-only and that
mixed website+source PRs remain non-docs-only.

- [ ] **Step 3: Link repository and package readers to the site**

Add `https://scriptedalchemy.github.io/agent-bundle/` near the introductions
of both READMEs. Set `packages/agent-bundle/package.json` `homepage` to that
URL. Do not remove useful install or command information from either README.
While editing the root README, drop the deprecated `version` field from its
quick-start `defineConfig` example (`plugin.version` is `@deprecated` in
source and the website docs intentionally omit it).

- [ ] **Step 4: Validate workflow syntax and docs**

Run:

```bash
pnpm docs:check
pnpm lint
```

Expected: both pass.

---

### Task 7: Final integration, browser acceptance, and polish

**Owner/model:** GPT-5.6 Sol — resolve integration failures, audit generated output, and perform final polish.

**Files:**
- Modify only files introduced or intentionally changed by Tasks 1-6.

- [ ] **Step 1: Inspect the full working-tree diff**

Confirm no files under `repos/**` changed, no generated TypeDoc Markdown or
`doc_build` output is tracked, and package-release scripts are unchanged.

- [ ] **Step 2: Run fresh repository-level verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm docs:check
pnpm lint
```

Expected: all pass with no peer warnings or Rspress validation warnings.

- [ ] **Step 3: Audit generated outputs**

Verify:

- English and Chinese LLM indexes contain the expected localized route groups.
- LLM links include `https://scriptedalchemy.github.io/agent-bundle/`.
- `sitemap.xml` uses the same origin and base.
- TypeDoc's API index represents all eleven package export entry modules.
- no generated page contains a source-machine absolute path.

- [ ] **Step 4: Run desktop browser acceptance at 1440×900**

Start `pnpm docs:dev` once, then verify:

1. English and Chinese homepages render with no loading state or missing asset.
2. Locale switching preserves the corresponding route.
3. Top navigation and section sidebars reach every authored section.
4. Built-in search returns prose and code-block matches without Algolia.
5. A Twoslash-enabled TypeScript example exposes type information.
6. The shared TypeDoc API reference is reachable from both locale API pages.
7. LLM actions resolve to generated Markdown under `/agent-bundle/`.

- [ ] **Step 5: Check diagnostics for edited TypeScript and TSX files**

Read editor diagnostics for:

- `website/rspress.config.ts`
- `website/theme/index.tsx`

Fix only diagnostics introduced by this work.

- [ ] **Step 6: Report completion without merging**

Summarize created structure, plugin decisions, content coverage, deployment
workflow, and exact verification evidence. Task work is committed on the
isolated `docs/rspress-website` branch as part of the subagent workflow;
leave the branch unmerged and open no PR unless the user separately asks.
