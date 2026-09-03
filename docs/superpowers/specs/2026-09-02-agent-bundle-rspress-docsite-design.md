# Agent Bundle Rspress Documentation Site Design

## Goal

Add a production-ready Rspress documentation website for agent-bundle that
turns the existing repository and package READMEs into navigable English and
Chinese documentation, publishes to GitHub Pages, exposes the public
TypeScript API, and emits AI-readable documentation artifacts.

## Upstream Conventions

The site follows the current Rspress and Rslib repository conventions:

- A private `website` pnpm workspace owns the documentation application.
- `website/rspress.config.ts` contains site, build, plugin, and theme
  configuration.
- Authored content lives below `website/docs`.
- Locale roots use `_nav.json` for top-level navigation.
- Section directories use `_meta.json` for sidebar grouping and ordering.
- The theme re-exports the Rspress original theme and adds only bounded
  product-specific presentation.
- `rspress dev`, `rspress build`, and `rspress preview` remain the primary
  package commands.

The design deliberately does not copy upstream analytics, hosted Algolia
search, component preview infrastructure, or blog feeds. Agent-bundle does
not currently need those services.

## Workspace Architecture

Create a private workspace at `website/` named `@agent-bundle/docs`.
`pnpm-workspace.yaml` will include `website`, and the repository root will
expose:

- `docs:site:dev` to run the Rspress development server.
- `docs:site:build` to typecheck the website and perform the production build
  (the check gate; there is no separate build-only root script).
- `docs:site:preview` to preview the production output.

The documentation build remains separate from the package-release `build`
script. Publishing npm packages must not become dependent on documentation
generation or GitHub Pages.

The website package contains:

- `rspress.config.ts` for the site contract.
- `tsconfig.json` for config and theme typechecking.
- `theme/index.tsx` and a small stylesheet for agent-bundle branding.
- `docs/en` and `docs/zh` for hand-authored localized content.
- `docs/en/api` for TypeDoc-generated public API documentation, mirrored into
  `docs/zh/api` by a small local plugin (Rspress i18n requires all content to
  live under a locale root).
- `docs/public` for logos and other static assets.

The theme remains close to Rspress defaults. It may adjust brand colors,
homepage presentation, and the navigation mark, but it does not replace core
layout, search, sidebar, outline, or accessibility behavior.

## Site and Route Configuration

The production site is hosted at:

`https://scriptedalchemy.github.io/agent-bundle/`

Rspress configuration uses:

- `siteOrigin: "https://scriptedalchemy.github.io"`
- `base: "/agent-bundle/"`
- `root` pointing to `website/docs`
- English as the default language
- English and Simplified Chinese locale metadata
- clean URLs
- built-in local search with code-block indexing
- edit links targeting the corresponding source under `website/docs`

The configuration enables Rspress's built-in checks for:

- dead internal links
- dead internal anchors
- missing local images
- English and Chinese route parity

Relative source-file links are preferred inside Markdown and MDX so links
remain useful in editors and GitHub and are independent of the deployment
base path.

## Plugin Selection

The website installs and enables:

### `@rspress/plugin-llms`

Generate:

- root English `llms.txt`
- root English `llms-full.txt`
- `zh/llms.txt`
- `zh/llms-full.txt`
- Markdown representations for documentation routes

The default theme's LLM UI is enabled in the page outline so readers can copy
or open the Markdown representation of a page.

### `@rspress/plugin-twoslash`

Opted-in TypeScript examples use Twoslash for IDE-style type hovers, inferred
type queries, completions, and diagnostics. Explicit triggering remains
enabled so ordinary code blocks do not incur unnecessary type analysis or
fail because they intentionally show incomplete fragments.

### `@rspress/plugin-typedoc`

Generate browsable API documentation from every public `agent-bundle`
TypeScript entry module represented by the package export map. The generated
reference includes modules, functions, interfaces, parameters, return types,
and source API comments.

TypeDoc content is generated once and mirrored across locales because symbols,
signatures, and source comments are one package-level contract. Hand-authored
API orientation pages in both locales link into that generated reference.

Generated TypeDoc Markdown is ignored by Git in both locale API directories.
Curated per-locale API `_meta.json` files are source-controlled so navigation
order and localized section labels are stable. Because the TypeDoc plugin
skips output silently when conversion fails, a post-build verification script
asserts the generated API pages exist; that script, not the plugin, is the
build-failure guarantee for API generation.

### `@rspress/plugin-sitemap`

Generate `sitemap.xml` from `siteOrigin` and `base` for the GitHub Pages site.

### Excluded Plugins

- Algolia is excluded because built-in search meets the initial requirements
  without external credentials or crawler infrastructure.
- API Docgen is excluded because TypeDoc better represents a multi-entry
  TypeScript library; API Docgen primarily serves React prop tables or
  isolated utility JSDoc.
- Preview and Playground are excluded because agent-bundle is not a component
  library and its Workbench cannot run meaningfully as an isolated browser
  code block.
- RSS is excluded because the initial site has no blog or release feed.
- Client Redirects is excluded because the new site has no legacy routes.

## Documentation Information Architecture

Both locales have the same hand-authored route structure.

### Home

The homepage presents the product, installation and quick-start actions, and
feature cards for:

- one typed configuration across supported hosts
- Skills, hooks, MCP servers/apps, scripts, and package entries
- local Workbench development
- evidence-driven route, protocol, CLI, package, and host testing

### Guide

`Start` contains:

- Introduction
- Installation
- Quick start
- Project structure

`Authoring` contains:

- Configuration model
- Skills
- Hooks
- MCP servers and MCP Apps
- Scripts and assets
- CLI and library package entries

`Development` contains:

- Developer Workbench
- Route testing
- MCP and CLI proof levels
- Evaluations

`Distribution` contains:

- Building artifacts
- Artifact validation
- Installing into Claude Code, Codex, and Cursor
- Preview packages

### Reference

Reference pages cover:

- CLI commands and flags
- configuration semantics
- targets and artifact layouts
- runtime and environment contracts
- authentication and security constraints
- current limitations
- generated TypeDoc API entry point

### Examples

The examples section contains an overview and focused pages for:

- Skills Starter
- Hooks and Scripts
- MCP App
- Audiobook Curator

Each page explains the product behavior demonstrated by the example and links
to its source and local run command.

### Contributing

Contributor documentation covers:

- repository development workflow
- local checks
- release gates
- links to deeper repository architecture documents

## Content Migration Boundary

The English documentation is assembled from the current root README and
`packages/agent-bundle/README.md`, split by user task rather than copied as
two long pages. Existing focused files under repository `docs/` remain the
source for contributor-level contracts when they are too detailed for the
initial user guide; the website links to them where appropriate.

Chinese pages provide complete translations of every hand-authored English
route. They are not empty mirrors or placeholder pages.

The root README remains a concise repository landing page. The package README
remains useful as the npm package landing page. Both should point readers to
the hosted documentation, while the website becomes the canonical navigable
long-form guide.

## Build and Failure Behavior

The documentation package exposes `dev`, `build`, `preview`, and `typecheck`.
The repository-level `docs:site:build` runs typechecking and then a production
Rspress build.

The production build is the validation boundary. It fails on:

- invalid Rspress configuration
- TypeScript errors in config or theme code
- invalid Markdown or MDX
- dead internal links
- dead internal anchors
- missing local images
- missing English or Chinese hand-authored route counterparts
- TypeDoc generation failures
- static-site rendering failures

A successful build produces the static site, generated TypeDoc reference,
English and Chinese LLM files, per-route Markdown, local search index, and
sitemap.

## GitHub Pages Delivery

Add `.github/workflows/docs.yml`.

The workflow:

- runs unconditionally for all pull requests and pushes to `main` (no path
  filters, because package-source changes can break TypeDoc generation and
  path-filtered workflows cannot be required checks)
- supports manual dispatch
- installs the repository-pinned Node and pnpm versions
- installs dependencies with the frozen lockfile
- runs `pnpm docs:site:build`
- uploads `website/doc_build` as the Pages artifact
- deploys only for a push to `main`
- uses the official Pages configure, upload, and deploy actions
- grants `contents: read` at the top level plus Pages write and OIDC
  permissions on the deploy job only
- cancels superseded pull-request builds, but never cancels an in-flight
  Pages deployment (`group: pages`, `cancel-in-progress: false`)
- requires the repository's Pages source to be set to "GitHub Actions" once,
  manually, before the first deployment

Pull requests receive the complete typecheck and build validation without
deploying.

## Acceptance

Implementation is accepted when:

1. A frozen-lockfile install succeeds.
2. `pnpm docs:site:build` succeeds with link, anchor, image, and language-parity
   checks enabled.
3. The output contains the English and Chinese homepages.
4. The output contains English and Chinese `llms.txt` and `llms-full.txt`
   artifacts.
5. The output contains `sitemap.xml`.
6. The shared generated TypeDoc reference exposes all package export entry
   modules.
7. At a 1440 by 900 desktop viewport, both locale homepages render without a
   loading state or broken assets.
8. Locale navigation, sidebars, built-in search, and language switching work.
9. A Twoslash-enabled example exposes type information.
10. The TypeDoc reference is reachable from both locales.
11. LLM page actions resolve to generated Markdown artifacts under the
    `/agent-bundle/` base path.

Mobile-specific layout and acceptance are outside this repository's desktop
application scope.
