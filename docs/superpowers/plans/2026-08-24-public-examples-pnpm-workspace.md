# Public Examples and pnpm Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repository to one pinned pnpm workspace and ship three public, independently runnable Agent Bundle examples whose populated and diagnostic Workbench states are verified in real desktop Chrome.

**Architecture:** The root owns one `pnpm-workspace.yaml`, one frozen lockfile, and all contributor commands. Each private example consumes `agent-bundle` through `workspace:*` but otherwise uses only public package exports and the public CLI; existing integration fixtures remain test-only. Release verification keeps npm only at the external installed-tarball boundary, while a dedicated real-Chrome test drives the checked-in examples at 1440×900 and records acceptance evidence.

**Tech Stack:** pnpm 11.23.0, Node.js 22.19+, TypeScript 7, Agent Bundle public API/CLI, MCP SDK 2.0.0, MCP Apps 1.7.5, Rstest, Playwright with Google Chrome, GitHub Actions, pkg.pr.new, publint, attw.

**Spec:** `docs/superpowers/specs/2026-08-24-examples-pnpm-workspace-design.md`

## Global Constraints

- Use exactly `pnpm@11.23.0`, pinned in the root `packageManager` field.
- Keep one workspace and one lockfile: `packages/*`, `examples/*`, and `pnpm-lock.yaml`; remove `package-lock.json`.
- Do not add Turbo, Nx, another task graph, a nested workspace, or a compatibility layer for npm contributor commands.
- Keep all example packages `private: true` and depend on `agent-bundle` with `workspace:*`.
- Examples may import only public package entrypoints; never import repository source, fixture helpers, or test helpers.
- Keep package consumers package-manager-neutral. npm is allowed only inside clean external-consumer tarball audits and user-facing install examples.
- Preserve Node 22.19, 24, and 26 CI coverage and keep package preview limited to `packages/agent-bundle`.
- Default example walkthroughs must require no API keys, native-host credentials, or signed-in Claude/Codex session.
- Browser acceptance is desktop-only at 1440×900; do not add mobile-specific work.
- Do not capture a route while its loading indicator is present. Every screenshot must represent a settled populated, diagnostic, stale, repaired, or completed state.
- Commit each task independently and leave the workspace buildable after every commit.

---

## File and Responsibility Map

### Workspace and delivery boundary

- `package.json`: canonical pnpm scripts, package-manager pin, example launch/check commands.
- `pnpm-workspace.yaml`: product and example workspace membership.
- `pnpm-lock.yaml`: sole dependency lockfile.
- `package-lock.json`: removed during migration.
- `.github/workflows/ci.yml`: Corepack/frozen pnpm install, product gates, and example gate.
- `.github/workflows/package-preview.yml`: pnpm build with pkg.pr.new publishing only the product package.
- `.github/workflows/native-host-smoke.yml`: pnpm setup and unchanged opt-in native-host commands.
- `scripts/audit-packed-release.mjs`: create one external npm consumer, install the packed tarball, then run npm dependency, audit, signature, and CycloneDX checks.
- `scripts/audit-packed-sbom.mjs`: removed after its behavior is folded into `audit-packed-release.mjs`.
- `packages/agent-bundle/tests/release-audit.test.ts`: prove the package tarball installs outside the workspace and excludes examples/workspace dependencies.
- `packages/agent-bundle/tests/workspace-contract.test.ts`: prove pnpm selects both product packages and all private examples.

### Public examples

- `examples/skills-starter/**`: minimal Skill, reference, asset, config, scripts, and standalone README.
- `examples/hooks-and-scripts/**`: session-start Hook, successful and failing scripts, config, scripts, and diagnostic walkthrough.
- `examples/mcp-app/**`: MCP server, official App UI, deterministic eval, config, scripts, and standalone README.
- `packages/agent-bundle/tests/examples-contract.test.ts`: public-API black-box validation of all three examples.

### Browser acceptance and documentation

- `packages/workbench/tests/examples-real.e2e.test.ts`: real Chrome, actual checked-in examples, all required interactions and state assertions.
- `packages/workbench/tests/support/example-acceptance.ts`: small shared helpers for temporary copies, settled-state waits, error ledgers, and optional screenshot output.
- `README.md`: contributor pnpm flow and examples progression table.
- `packages/agent-bundle/README.md`: pnpm contributor commands, public example links, unchanged consumer install guidance.
- `AGENTS.md`: desktop-only example acceptance rules and no-fixture/no-loading-screenshot constraint.

---

### Task 1: Establish the canonical pnpm workspace and preserve the release boundary

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml`
- Create: `scripts/audit-packed-release.mjs`
- Create: `packages/agent-bundle/tests/workspace-contract.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/package-preview.yml`
- Modify: `.github/workflows/native-host-smoke.yml`
- Modify: `packages/agent-bundle/tests/release-audit.test.ts`
- Delete: `package-lock.json`
- Delete: `scripts/audit-packed-sbom.mjs`

**Interfaces:**
- Consumes: current root npm scripts, existing package workspaces, and the installed-tarball assertions in `release-audit.test.ts`.
- Produces: canonical root commands `pnpm build`, `pnpm test`, `pnpm check`, `pnpm check:release`, and a workspace containing `packages/*` plus future `examples/*`.
- Produces: `scripts/audit-packed-release.mjs` that exits nonzero if any external npm production check fails and prints the validated CycloneDX document as JSON on stdout.

- [ ] **Step 1: Add the failing workspace membership test**

Create `packages/agent-bundle/tests/workspace-contract.test.ts` with an exact pnpm query and canonical expectations:

```ts
import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);

it('selects product packages through the pinned pnpm workspace', async () => {
  const { stdout } = await execFile('corepack', [
    'pnpm', '--recursive', '--depth', '-1', 'list', '--json',
  ], { cwd: process.cwd() });
  const packages = JSON.parse(stdout) as readonly { name: string; path: string; private?: boolean }[];
  expect(packages.map(({ name }) => name).sort()).toEqual([
    'agent-bundle',
    'agent-bundle-workbench',
    'agent-bundle-workspace',
  ]);
});
```

- [ ] **Step 2: Run the test and record the expected RED**

Run: `npx rstest --config rstest.config.ts packages/agent-bundle/tests/workspace-contract.test.ts`

Expected: FAIL because the root has no pinned pnpm workspace/lockfile and Corepack cannot enumerate the intended workspace contract.

- [ ] **Step 3: Declare the workspace and migrate scripts**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - examples/*
```

In `package.json`, remove `workspaces`, add `"packageManager": "pnpm@11.23.0"`, and translate root-to-root and workspace calls without changing the underlying tools:

```json
{
  "scripts": {
    "build": "pnpm build:workbench && rslib build",
    "build:workbench": "pnpm --filter agent-bundle-workbench build",
    "test": "pnpm test:unit && pnpm test:integration",
    "check": "pnpm build && pnpm test && pnpm lint && pnpm typecheck",
    "test:packed:native:claude": "pnpm build && AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE=1 pnpm test:packed:native",
    "test:packed:native:codex": "pnpm build && AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE=1 pnpm test:packed:native",
    "pack:dry-run": "pnpm build && npm pack ./packages/agent-bundle --dry-run --json",
    "audit:release": "pnpm lint:package && attw --pack --profile esm-only packages/agent-bundle && node scripts/audit-packed-release.mjs",
    "check:release": "pnpm pack:dry-run && pnpm audit:release && pnpm test:packed"
  }
}
```

- [ ] **Step 4: Move every npm production check into one external consumer**

Implement `scripts/audit-packed-release.mjs` by retaining the current temporary-directory, pack, install, and SBOM validation logic from `audit-packed-sbom.mjs`, then run these commands with `cwd` set to the temporary consumer:

```js
await execFile('npm', ['ls', '--omit=dev', '--json'], { cwd: consumerRoot });
await execFile('npm', ['audit', '--omit=dev', '--json'], { cwd: consumerRoot });
await execFile('npm', ['audit', 'signatures', '--json'], { cwd: consumerRoot });
const { stdout } = await execFile(
  'npm',
  ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx'],
  { cwd: consumerRoot, maxBuffer: 32 * 1024 * 1024 },
);
```

Keep the existing checks for CycloneDX format, root component, installed `agent-bundle` dependency closure, and absence of workspace/`.pnpm` paths. Always remove the temp root in `finally`. Print only the validated SBOM JSON so the existing test can parse stdout deterministically.

- [ ] **Step 5: Tighten the tarball regression**

In `packages/agent-bundle/tests/release-audit.test.ts`, change repository-owned root commands to `corepack pnpm ...`, keep `npm pack` and the temporary consumer's `npm install`, and add:

```ts
expect(files.some(({ path }) => path.startsWith('examples/'))).toBe(false);
expect(packageManifest.dependencies?.['agent-bundle']).toBeUndefined();
expect(JSON.stringify(packageManifest)).not.toContain('workspace:');
```

- [ ] **Step 6: Migrate GitHub Actions to the pinned manager**

In all three workflows, add `corepack enable` before install and replace `npm ci` with:

```yaml
- run: corepack enable
- run: pnpm install --frozen-lockfile
```

Replace repository script invocations with `pnpm <script>`. Keep the native matrix environment variables, Node versions, self-hosted/manual restrictions, and `pkg-pr-new publish ... './packages/agent-bundle'` scope unchanged.

- [ ] **Step 7: Generate the sole lockfile and verify GREEN**

Run:

```bash
corepack pnpm install
corepack pnpm install --frozen-lockfile
pnpm build
npx rstest --config rstest.config.ts packages/agent-bundle/tests/workspace-contract.test.ts packages/agent-bundle/tests/release-audit.test.ts
pnpm audit:release
```

Expected: all commands PASS; the workspace test lists only the root and two product packages at this boundary; the external consumer checks pass; `git status --short` shows `package-lock.json` deleted and exactly one new `pnpm-lock.yaml`.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .github/workflows scripts packages/agent-bundle/tests/workspace-contract.test.ts packages/agent-bundle/tests/release-audit.test.ts package-lock.json
git commit -m "build: adopt canonical pnpm workspace"
```

---

### Task 2: Add the Skills Starter public example

**Files:**
- Create: `examples/skills-starter/package.json`
- Create: `examples/skills-starter/agent-bundle.config.ts`
- Create: `examples/skills-starter/skills/release-review/SKILL.md`
- Create: `examples/skills-starter/skills/release-review/references/checklist.md`
- Create: `examples/skills-starter/skills/release-review/assets/report-template.md`
- Create: `examples/skills-starter/README.md`
- Create: `packages/agent-bundle/tests/examples-contract.test.ts`
- Modify: `package.json`
- Modify: `packages/agent-bundle/tests/workspace-contract.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: pnpm workspace from Task 1 and public `inspect`, `build`, and `validate` exports from `packages/agent-bundle/src/api.ts`.
- Produces: private workspace `@agent-bundle-example/skills-starter` and root command `pnpm example:skills`.

- [ ] **Step 1: Add the failing example contract**

Create `packages/agent-bundle/tests/examples-contract.test.ts`:

```ts
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { build, inspect, validate } from '../src/api.ts';

const examplesRoot = join(process.cwd(), 'examples');

it('builds the Skills Starter through public Agent Bundle APIs', async () => {
  const root = join(examplesRoot, 'skills-starter');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });
  try {
    await expect(inspect({ root })).resolves.toMatchObject({
      state: 'ready',
      model: {
        metadata: { name: 'skills-starter' },
        scripts: [],
        targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
      },
    });
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Release review');
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'references', 'checklist.md'), 'utf8'))
      .resolves.toContain('Confirm the release artifact');
    await expect(readFile(join(output, 'portable', 'skills', 'release-review', 'assets', 'report-template.md'), 'utf8'))
      .resolves.toContain('# Release report');
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test and record the expected RED**

Run: `pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts`

Expected: FAIL because `examples/skills-starter/agent-bundle.config.ts` does not exist.

- [ ] **Step 3: Create the private example package and scripts**

Create `examples/skills-starter/package.json`:

```json
{
  "name": "@agent-bundle-example/skills-starter",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "agent-bundle build --root . --json",
    "check": "pnpm validate && pnpm build",
    "dev": "agent-bundle dev --root .",
    "validate": "agent-bundle validate --root . --json"
  },
  "devDependencies": {
    "agent-bundle": "workspace:*"
  }
}
```

Create the typed `agent-bundle.config.ts`:

```ts
import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: {
    description: 'A minimal public example for authoring portable skills.',
    name: 'skills-starter',
    version: '1.0.0',
  },
  skills: ['skills/release-review'],
  targets: ['portable', 'codex', 'claude'],
});
```

- [ ] **Step 4: Author the Skill, reference, asset, and README**

The Skill frontmatter must be exact:

```markdown
---
name: release-review
description: Reviews a release artifact against a repeatable checklist.
---
# Release review

Read [the checklist](references/checklist.md), then write findings using
[the report template](assets/report-template.md).
```

The README's first command must be:

```bash
pnpm example:skills
```

It must explain the authored Skill, generated target output, editing `SKILL.md`, pressing Rebuild, and inspecting Overview, Skills, and Artifacts.

- [ ] **Step 5: Expose the root command and update workspace expectations**

Add to root `package.json`:

```json
"example:skills": "pnpm --filter @agent-bundle-example/skills-starter dev"
```

Extend the workspace test's expected names with `@agent-bundle-example/skills-starter`, then assert every name beginning with `@agent-bundle-example/` has `private === true` and a package manifest dependency of `"agent-bundle": "workspace:*"`.

- [ ] **Step 6: Install and verify GREEN**

Run:

```bash
pnpm install
pnpm --filter @agent-bundle-example/skills-starter check
pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
```

Expected: all commands PASS and the contract deletes its generated output.

- [ ] **Step 7: Commit**

```bash
git add examples/skills-starter package.json pnpm-lock.yaml packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
git commit -m "feat(examples): add skills starter"
```

---

### Task 3: Add Hooks and Scripts with executable contract coverage

**Files:**
- Create: `examples/hooks-and-scripts/package.json`
- Create: `examples/hooks-and-scripts/agent-bundle.config.ts`
- Create: `examples/hooks-and-scripts/src/hooks/session-start.ts`
- Create: `examples/hooks-and-scripts/src/scripts/succeed.ts`
- Create: `examples/hooks-and-scripts/src/scripts/fail.ts`
- Create: `examples/hooks-and-scripts/README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/agent-bundle/tests/examples-contract.test.ts`
- Modify: `packages/agent-bundle/tests/workspace-contract.test.ts`

**Interfaces:**
- Consumes: public `build`, `listHooks`, `simulateHook`, and `validate` APIs.
- Produces: private workspace `@agent-bundle-example/hooks-and-scripts`, root command `pnpm example:hooks`, canonical hook result `{ additionalContext, outcome: 'continue' }`, and two runnable artifact scripts.

- [ ] **Step 1: Add failing Hook and script tests**

Append a test that builds into a temporary output, validates it, discovers the Hook, simulates it, and executes both emitted scripts:

```ts
it('simulates the Hooks example and executes both scripts', async () => {
  const root = join(examplesRoot, 'hooks-and-scripts');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });
  try {
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    const hooks = await listHooks({ artifact: output, root });
    expect(hooks).toHaveLength(2);
    const hook = hooks.find(({ target }) => target === 'portable');
    expect(hook).toBeDefined();
    await expect(simulateHook({
      artifact: output,
      hook: hook!.id,
      input: { cwd: root, sessionId: 'example', source: 'workbench', transcriptPath: join(root, 'transcript.json') },
      root,
      target: hook!.target,
    })).resolves.toEqual({ additionalContext: 'example session from workbench', outcome: 'continue' });
    await expect(execFile(process.execPath, [join(output, 'portable', 'scripts', 'succeed.mjs')], { cwd: root }))
      .resolves.toMatchObject({ stderr: 'example warning\n', stdout: 'example success\n' });
    await expect(execFile(process.execPath, [join(output, 'portable', 'scripts', 'fail.mjs')], { cwd: root }))
      .rejects.toMatchObject({ code: 2, stderr: 'example failure\n' });
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
```

Add the `execFile` promisified import used in Task 1.

- [ ] **Step 2: Run the test and record the expected RED**

Run: `pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts -t 'Hooks example'`

Expected: FAIL because the example is absent.

- [ ] **Step 3: Create the config and implementation**

Use this typed config:

```ts
import { defineConfig } from 'agent-bundle';

export default defineConfig({
  hooks: { sessionStart: { handler: './src/hooks/session-start.ts' } },
  plugin: {
    description: 'Hook simulation, script traces, logs, and recovery.',
    name: 'hooks-and-scripts',
    version: '1.0.0',
  },
  scripts: {
    fail: './src/scripts/fail.ts',
    succeed: './src/scripts/succeed.ts',
  },
  targets: ['portable', 'codex'],
});
```

Use these canonical implementations:

```ts
// src/hooks/session-start.ts
export default (event: { readonly source?: string }) => ({
  additionalContext: `example session from ${event.source ?? 'unknown'}`,
  outcome: 'continue' as const,
});

// src/scripts/succeed.ts
process.stdout.write('example success\n');
process.stderr.write('example warning\n');

// src/scripts/fail.ts
process.stderr.write('example failure\n');
process.exitCode = 2;
```

- [ ] **Step 4: Document the reversible diagnostic walkthrough**

The README must begin with `pnpm example:hooks`, explain Hook simulation, both script outcomes, Logs filters/details, and give this exact reversible edit:

```ts
export default () => ({ outcome: 'not-a-canonical-outcome' });
```

It must instruct the user to rebuild, inspect the visible diagnostic while the previous epoch remains active, restore the checked-in handler, and rebuild to clear the stale state.

- [ ] **Step 5: Add workspace and root command entries**

Use the same private package scripts as Skills Starter, add `"example:hooks": "pnpm --filter @agent-bundle-example/hooks-and-scripts dev"`, and extend the workspace test with the new package name.

- [ ] **Step 6: Install and verify GREEN**

Run:

```bash
pnpm install
pnpm --filter @agent-bundle-example/hooks-and-scripts check
pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
```

Expected: Hook simulation and both script exit contracts PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/hooks-and-scripts package.json pnpm-lock.yaml packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
git commit -m "feat(examples): add hooks and scripts"
```

---

### Task 4: Add the MCP App and deterministic eval example

**Files:**
- Create: `examples/mcp-app/package.json`
- Create: `examples/mcp-app/agent-bundle.config.ts`
- Create: `examples/mcp-app/src/mcp-server.ts`
- Create: `examples/mcp-app/views/status-panel.html`
- Create: `examples/mcp-app/views/status-panel.ts`
- Create: `examples/mcp-app/evals/status.eval.ts`
- Create: `examples/mcp-app/evals/fixtures/status/result.json`
- Create: `examples/mcp-app/evals/graders/status-result.ts`
- Create: `examples/mcp-app/README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/agent-bundle/tests/examples-contract.test.ts`
- Modify: `packages/agent-bundle/tests/workspace-contract.test.ts`

**Interfaces:**
- Consumes: `agent-bundle/mcp-apps`, `agent-bundle/eval`, public `build`, `invokeMcp`, `listMcp`, and `validate`, MCP SDK server 2.0.0, and MCP Apps 1.7.5.
- Produces: private workspace `@agent-bundle-example/mcp-app`, tool `show-status`, App URI `ui://mcp-app-example/status.html`, root command `pnpm example:mcp-app`, and deterministic suite `mcp-app-status`.

- [ ] **Step 1: Add the failing MCP contract**

Append a test that builds and invokes the real server:

```ts
it('invokes the MCP App example and exposes its official App resource', async () => {
  const root = join(examplesRoot, 'mcp-app');
  const output = join(root, '.agent-bundle', 'example-contract');
  await rm(output, { force: true, recursive: true });
  try {
    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });
    await expect(listMcp({ artifact: output, root, server: 'status', target: 'portable' }))
      .resolves.toMatchObject({ tools: [{ name: 'show-status' }] });
    await expect(invokeMcp({
      artifact: output,
      input: { service: 'compiler' },
      root,
      server: 'status',
      target: 'portable',
      tool: 'show-status',
    })).resolves.toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://mcp-app-example/status.html' } },
        content: [{ text: 'compiler is healthy', type: 'text' }],
        structuredContent: { service: 'compiler', status: 'healthy' },
      },
    });
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test and record the expected RED**

Run: `pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts -t 'MCP App example'`

Expected: FAIL because the example server is absent.

- [ ] **Step 3: Create the package and Agent Bundle config**

Use dev dependencies:

```json
{
  "@modelcontextprotocol/ext-apps": "1.7.5",
  "@modelcontextprotocol/server": "2.0.0",
  "agent-bundle": "workspace:*",
  "zod": "4.4.3"
}
```

Use this MCP binding:

```ts
import { defineConfig } from 'agent-bundle';

export default defineConfig({
  mcp: {
    servers: {
      status: {
        apps: {
          status: {
            entry: './views/status-panel.ts',
            resourceUri: 'ui://mcp-app-example/status.html',
            targets: ['portable'],
            template: './views/status-panel.html',
          },
        },
        entry: './src/mcp-server.ts',
      },
    },
  },
  plugin: {
    description: 'An interactive MCP App plus deterministic evaluation.',
    name: 'mcp-app-example',
    version: '1.0.0',
  },
  targets: ['portable'],
});
```

- [ ] **Step 4: Implement the MCP server through generated App metadata**

Follow the public generated-app contract exactly:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import apps from 'agent-bundle/mcp-apps';
import { z } from 'zod';

const app = apps[0];
if (app === undefined) throw new Error('Expected the status MCP App.');
const server = new McpServer({ name: 'mcp-app-example', version: '1.0.0' });
server.registerResource(app.name, app.resourceUri, {
  _meta: { ui: { resourceUri: app.resourceUri } },
  mimeType: app.mimeType,
}, async (uri) => ({ contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }] }));
server.registerTool('show-status', {
  _meta: { ui: { resourceUri: app.resourceUri } },
  description: 'Show the health of one example service.',
  inputSchema: z.object({ service: z.string() }),
}, async ({ service }) => ({
  _meta: { ui: { resourceUri: app.resourceUri } },
  content: [{ text: `${service} is healthy`, type: 'text' }],
  structuredContent: { service, status: 'healthy' },
}));
await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Implement the App bridge and interactive panel**

The HTML must contain `#service`, `#status`, and a `#toggle-details` button. The TypeScript must use the supported bridge rather than direct fixture DOM-only behavior:

```ts
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'mcp-app-status-panel', version: '1.0.0' }, {});
app.addEventListener('toolresult', (result) => {
  const content = result.structuredContent as { service?: string; status?: string } | undefined;
  document.querySelector('#service')!.textContent = content?.service ?? 'No service selected';
  document.querySelector('#status')!.textContent = content?.status ?? 'unknown';
});
document.querySelector('#toggle-details')!.addEventListener('click', () => {
  document.querySelector('#details')!.toggleAttribute('hidden');
});
await app.connect(new PostMessageTransport(window.parent, window.parent));
```

- [ ] **Step 6: Add the credential-free deterministic eval**

Use the same stable portable host pattern as the packed fixture:

```ts
import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/status-result.ts' })],
    fixture: './fixtures/status',
    hosts: { portable: { model: 'deterministic' } },
    id: 'status-is-healthy',
    invocation: { mode: 'automatic' },
    prompt: 'Verify the example service status.',
    trials: 1,
  }],
  name: 'mcp-app-status',
});
```

The fixture is `{ "service": "compiler", "status": "healthy" }`; the grader reads `result.json` and returns pass only for that exact pair.

- [ ] **Step 7: Document and expose the example**

The README begins with `pnpm example:mcp-app` and covers Open session, Refresh catalogs, `show-status` invocation, App preview interaction, protocol trace, Inspector export, Close session, and deterministic eval run. Add the root command and workspace expectation.

- [ ] **Step 8: Install and verify GREEN**

Run:

```bash
pnpm install
pnpm --filter @agent-bundle-example/mcp-app check
pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
```

Expected: build, validation, tool discovery, tool invocation, and App metadata assertions PASS without credentials.

- [ ] **Step 9: Commit**

```bash
git add examples/mcp-app package.json pnpm-lock.yaml packages/agent-bundle/tests/examples-contract.test.ts packages/agent-bundle/tests/workspace-contract.test.ts
git commit -m "feat(examples): add interactive MCP app"
```

---

### Task 5: Complete the public command surface and contributor documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `packages/agent-bundle/README.md`
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`
- Test: `packages/agent-bundle/tests/workspace-contract.test.ts`

**Interfaces:**
- Consumes: all three workspace package names and their local `check`/`dev` scripts.
- Produces: root `pnpm examples:check`, one discoverable examples guide, and durable desktop acceptance rules for future agents.

- [ ] **Step 1: Add the failing aggregate-command assertion**

Extend the workspace contract test:

```ts
const rootManifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
expect(rootManifest.scripts).toMatchObject({
  'example:hooks': 'pnpm --filter @agent-bundle-example/hooks-and-scripts dev',
  'example:mcp-app': 'pnpm --filter @agent-bundle-example/mcp-app dev',
  'example:skills': 'pnpm --filter @agent-bundle-example/skills-starter dev',
  'examples:check': "pnpm --filter './examples/*' --workspace-concurrency=1 check",
});
```

- [ ] **Step 2: Run the test and record the expected RED**

Run: `pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/workspace-contract.test.ts`

Expected: FAIL because `examples:check` is not yet present.

- [ ] **Step 3: Add the aggregate command and CI step**

Add exactly:

```json
"examples:check": "pnpm --filter './examples/*' --workspace-concurrency=1 check"
```

Add `pnpm examples:check` to the fast CI job after the frozen install and before the micro-eval spot-check.

- [ ] **Step 4: Update contributor documentation without changing consumer install guidance**

In both READMEs, change repository clone/build/test commands to pnpm. Keep `npm install agent-bundle` or equivalent package-consumer text intact. Add a root progression table:

```markdown
| Example | Start here when you want to… | Command |
| --- | --- | --- |
| [Skills Starter](examples/skills-starter) | author a portable Skill | `pnpm example:skills` |
| [Hooks and Scripts](examples/hooks-and-scripts) | simulate hooks and inspect script traces | `pnpm example:hooks` |
| [MCP App](examples/mcp-app) | build a tool with an interactive App and eval | `pnpm example:mcp-app` |
```

State that all three are credential-free and open the Workbench in a desktop browser.

- [ ] **Step 5: Add the durable AGENTS.md rule**

Add a scoped examples section:

```markdown
### Public examples

- Treat `examples/*` as user-facing products, not test fixtures.
- Use only public `agent-bundle` package exports and `workspace:*` dependencies.
- Validate examples at 1440×900 desktop viewport; mobile support is not required.
- Never accept or capture a Workbench route while its loading state is still visible.
- Browser acceptance must cover populated state plus the documented stale-diagnostic and repair flow.
```

- [ ] **Step 6: Verify GREEN**

Run:

```bash
pnpm examples:check
pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/workspace-contract.test.ts packages/agent-bundle/tests/examples-contract.test.ts
pnpm exec rslint README.md packages/agent-bundle/README.md AGENTS.md package.json .github/workflows/ci.yml
```

Expected: all examples build and all workspace/example contract tests PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json README.md packages/agent-bundle/README.md AGENTS.md .github/workflows/ci.yml packages/agent-bundle/tests/workspace-contract.test.ts
git commit -m "docs: publish example workspace guide"
```

---

### Task 6: Drive every example in real desktop Chrome and capture settled states

**Files:**
- Create: `packages/workbench/tests/support/example-acceptance.ts`
- Create: `packages/workbench/tests/examples-real.e2e.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: checked-in example roots, `startDevServer({ open: false, root })`, Rstest Playwright `page`, and optional `AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR`.
- Produces: `pnpm test:examples:browser`, a machine-readable `report.json`, and PNGs for every required settled desktop state.

- [ ] **Step 1: Add a failing real-browser Skills acceptance test**

Create an Rstest browser suite with the established 1440×900 context and helper:

```ts
export const waitForSettledWorkbench = async (page: Page) => {
  await expect(page.getByText(/Foreground server connected/u)).toBeVisible();
  await expect(page.locator('.loading-state')).toHaveCount(0);
  await expect(page.getByText(/Loading/u)).toHaveCount(0);
};
```

The first test starts `examples/skills-starter`, visits `#skills`, waits for the `release-review` row and source Markdown, visits `#artifacts`, asserts portable/Codex/Claude targets, and records console/page/request failures.

- [ ] **Step 2: Run the test and record the expected RED**

Run: `pnpm exec rstest --config rstest.config.ts packages/workbench/tests/examples-real.e2e.test.ts -t 'Skills Starter'`

Expected: FAIL because the example-specific acceptance helpers/screenshots do not yet exist or the real UI selectors reveal the first unsettled state.

- [ ] **Step 3: Implement deterministic evidence capture**

The helper must create the optional output directory, write screenshots only after `waitForSettledWorkbench`, and append records of this exact type:

```ts
export interface ExampleCapture {
  readonly example: 'hooks-and-scripts' | 'mcp-app' | 'skills-starter';
  readonly file: string;
  readonly hash: string;
  readonly state: string;
  readonly viewport: { readonly height: 900; readonly width: 1440 };
}
```

Write `report.json` only when `AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR` is defined. Tests must still run normally without that variable.

- [ ] **Step 4: Cover Hooks, scripts, logs, diagnostics, and repair**

Copy the Hooks example to a temporary directory before mutation. Drive these settled states in order:

1. `#hooks`: select `sessionStart`, fill canonical input with `source: "browser"`, simulate, assert `additionalContext` equals `example session from browser`.
2. `#playground`: run `succeed`, assert stdout, stderr, exit 0, and `script.completed`; run `fail`, assert stderr and exit 2.
3. `#logs`: assert records exist; exercise producer, level, kind, and context filters; open one detail panel.
4. Replace the copied Hook with `export default () => ({ outcome: 'not-a-canonical-outcome' });`, press Rebuild, assert a visible diagnostic and stale/last-good artifact indicator.
5. Restore the original bytes, press Rebuild, assert the diagnostic clears and a new ready epoch appears.

Capture `hooks-populated.png`, `script-success.png`, `script-failure.png`, `logs-populated.png`, `diagnostic-stale.png`, and `diagnostic-repaired.png`.

- [ ] **Step 5: Cover the MCP App and eval**

Drive these states against `examples/mcp-app`:

1. Open the MCP page and session, refresh catalog, select `show-status`, enter `{ "service": "compiler" }`, invoke, and assert `compiler is healthy` plus structured status.
2. Assert the App iframe renders `compiler` and `healthy`; click its details toggle and assert the details region is visible.
3. Assert protocol trace rows exist and exercise Inspector configuration export.
4. Close the session and assert the closed state, then reopen to prove the server is restartable.
5. Open Evals, run `mcp-app-status`, wait for completion, and assert one passing case/trial.

Capture `mcp-session-ready.png`, `mcp-tool-result.png`, `mcp-app-preview.png`, `mcp-trace.png`, and `eval-completed.png`.

- [ ] **Step 6: Make the error ledger exhaustive**

For each server/browser lifecycle, require:

```ts
expect(pageErrors).toEqual([]);
expect(unmatchedConsoleErrors).toEqual([]);
expect(failedApplicationRequests).toEqual([]);
```

Classify only the repository's established same-origin `net::ERR_ABORTED` stream cancellation during route unmount; match exact request objects, route classes, and navigation window. Do not use substring ignore lists.

- [ ] **Step 7: Add and run the browser command**

Add:

```json
"test:examples:browser": "rstest --config rstest.config.ts packages/workbench/tests/examples-real.e2e.test.ts"
```

Run:

```bash
pnpm test:examples:browser
pnpm typecheck
pnpm exec rslint packages/workbench/tests/examples-real.e2e.test.ts packages/workbench/tests/support/example-acceptance.ts
```

Expected: all example browser scenarios PASS in Google Chrome at 1440×900 with zero unmatched errors.

- [ ] **Step 8: Commit**

```bash
git add package.json packages/workbench/tests/examples-real.e2e.test.ts packages/workbench/tests/support/example-acceptance.ts
git commit -m "test(workbench): exercise public examples in Chrome"
```

---

### Task 7: Run acceptance evidence, launch the user-facing X11 experience, and finish delivery

**Files:**
- Modify only if a fresh gate exposes a concrete defect.
- Generate outside the repository: `/home/zack/.codex/visualizations/2026/08/13/019ffd83-9893-7d60-9a33-206282f26f82/examples-pr2/**`

**Interfaces:**
- Consumes: every task above and the existing X11 desktop on `DISPLAY=:1`.
- Produces: final screenshots/report, a live example server, a visible Chrome window, a visible Cursor workspace, fresh gates, and a pushed branch.

- [ ] **Step 1: Capture fresh browser evidence outside the repository**

Run:

```bash
AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR=/home/zack/.codex/visualizations/2026/08/13/019ffd83-9893-7d60-9a33-206282f26f82/examples-pr2 \
  pnpm test:examples:browser
```

Expected: all tests PASS and `report.json` lists every PNG required by the spec at `{ width: 1440, height: 900 }`. Inspect every PNG and rerun only after fixing a reproduced defect; never accept a loading screenshot.

- [ ] **Step 2: Run the complete clean-tree gate**

Run sequentially, with no concurrent build/test process sharing output directories:

```bash
pnpm check
pnpm examples:check
pnpm check:release
pnpm test:packed:native
npx actionlint
node -e "import('yaml').then(async ({ parse }) => { const { readFile } = await import('node:fs/promises'); for (const file of ['.github/workflows/ci.yml', '.github/workflows/package-preview.yml', '.github/workflows/native-host-smoke.yml']) parse(await readFile(file, 'utf8')); })"
git diff --check
git status --short
```

Expected: all commands PASS; the non-opt-in native suite skips only authenticated host execution; status is empty.

- [ ] **Step 3: Launch a real example for the user on X11**

Start the MCP App example without using a test fixture:

```bash
pnpm example:mcp-app
```

Read the printed foreground URL, then launch the real checked-in folder and server URL on the existing desktop:

```bash
DISPLAY=:1 /home/zack/.local/bin/cursor /fast/projects/agent-bundle/examples/mcp-app
DISPLAY=:1 /home/zack/.local/bin/google-chrome --new-window '<printed-foreground-url>/#mcp'
```

Expected: Cursor opens the public example source; Chrome opens the populated MCP page. Leave both open for the user and report the exact URL and process ownership.

- [ ] **Step 4: Commit only concrete gate fixes, if any**

For each defect reproduced in Step 1 or 2, use its focused failing test first, make the minimal correction, rerun the focused test, and commit the coherent fix separately. If no defect appears, create no empty cleanup commit.

- [ ] **Step 5: Push and confirm accounting**

```bash
git status --short
git log --oneline origin/codex/agent-bundle-implementation..HEAD
git push origin codex/agent-bundle-implementation
git status --short
git rev-parse HEAD
git rev-parse origin/codex/agent-bundle-implementation
```

Expected: the pre-push log lists only reviewed incremental commits; after push both revisions are identical and the worktree is clean.

---

## Plan Self-Review

- Spec coverage: Tasks 1 and 5 cover the canonical pnpm workspace, contributor commands, CI, pkg.pr.new scope, and package-manager-neutral external consumer. Tasks 2–4 cover all three public examples and their exact educational contracts. Task 6 covers every required populated, diagnostic, stale, repaired, App, trace, and eval browser state. Task 7 covers evidence, final gates, X11 Chrome/Cursor launch, push, and accounting.
- Placeholder scan: the plan contains no deferred implementation markers, generic “handle errors” steps, or references to an undefined later helper. Every behavior change has a concrete RED, implementation contract, GREEN command, and commit.
- Type consistency: workspace names, root script names, MCP server/tool/App URI, deterministic eval name, capture record fields, and 1440×900 viewport are identical across producer, tests, docs, and final commands.
- Scope: mobile acceptance, native credentials, API keys, task-graph tooling, fixture reuse, and publishing examples remain explicitly excluded.
