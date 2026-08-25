# RSC Runtime and Audiobook Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the reusable RSC protocol primitives and prove them with a safe Claude/Codex Audiobook Curator example backed by the existing curator CLI.

**Architecture:** `@agent-bundle/rsc-runtime` owns only JSX protocol elements, strict lowerers, and generic request context. The audiobook example owns its Skill, CLI subprocess adapter, four MCP tools, and host-target configuration; it treats the Python CLI as an external executable capability.

**Tech Stack:** TypeScript 7, React 19, Rslib, Rstest, MCP Server 2, Zod 4, Agent Bundle, Node 22 child processes.

**Spec:** `docs/superpowers/specs/2026-08-25-rsc-runtime-audiobook-curator-design.md`

## Global Constraints

- Node.js is `>=22.19.0`; output is ESM.
- The runtime package is publishable and contains no demo provider, host packaging, or JSONL state implementation.
- The audiobook example targets `codex` and `claude`, contains one Skill and one MCP server, and contains no hooks.
- Child processes never use a shell and never inherit an unbounded environment or output stream.
- `--apply` and `--overwrite` may not be supplied through free-form arguments; only explicit typed inputs can enable them.
- Real audiobook-volume acceptance is read-only unless the user separately authorizes mutation.

---

### Task 1: Publishable RSC runtime package

**Files:**
- Create: `packages/rsc-runtime/package.json`
- Create: `packages/rsc-runtime/rslib.config.ts`
- Create: `packages/rsc-runtime/tsconfig.build.json`
- Create: `packages/rsc-runtime/src/index.ts`
- Create: `packages/rsc-runtime/src/elements.ts`
- Create: `packages/rsc-runtime/src/lower-hook.ts`
- Create: `packages/rsc-runtime/src/lower-mcp.ts`
- Create: `packages/rsc-runtime/src/request-context.ts`
- Create: `packages/rsc-runtime/tests/runtime.test.tsx`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `Hook`, `Mcp`, `lowerHookResult(node)`, `lowerMcpResult(node)`, and `createRscRequestContext<T>(label)` from `@agent-bundle/rsc-runtime`.
- `createRscRequestContext<T>` returns frozen `{ run<TResult>(value, operation): TResult; use(): T }`.

- [ ] **Step 1: Write the failing public API tests**

```tsx
import { Hook, Mcp, createRscRequestContext, lowerHookResult, lowerMcpResult } from '../src/index.js';

it('lowers one Hook result', () => {
  expect(lowerHookResult(<Hook.Result><Hook.AdditionalContext>ready</Hook.AdditionalContext></Hook.Result>))
    .toEqual({ hookSpecificOutput: { additionalContext: 'ready', hookEventName: 'PostToolUse' } });
});

it('lowers one MCP result without sharing mutable structured content', () => {
  const structuredContent = { status: 'ready' };
  const result = lowerMcpResult(<Mcp.Result structuredContent={structuredContent}><Mcp.Text>ready</Mcp.Text></Mcp.Result>);
  structuredContent.status = 'changed';
  expect(result.structuredContent).toEqual({ status: 'ready' });
});

it('isolates request context across concurrent work', async () => {
  const context = createRscRequestContext<string>('test request');
  expect(await Promise.all([
    context.run('a', async () => context.use()),
    context.run('b', async () => context.use()),
  ])).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run the package tests and verify RED**

Run: `pnpm exec rstest packages/rsc-runtime/tests/runtime.test.tsx`

Expected: FAIL because `packages/rsc-runtime/src/index.ts` does not exist.

- [ ] **Step 3: Implement the minimal package**

Move the proven element and lowerer behavior from the RSC example without changing its validation messages. Implement request context as:

```ts
export const createRscRequestContext = <T>(label: string) => {
  const storage = new AsyncLocalStorage<T>();
  return Object.freeze({
    run<TResult>(value: T, operation: () => TResult): TResult {
      return storage.run(value, operation);
    },
    use(): T {
      const value = storage.getStore();
      if (value === undefined) throw new Error(`${label} used outside a render request`);
      return value;
    },
  });
};
```

Export only the five named public values and their direct public types. Configure Rslib to bundle ESM, emit declarations, target Node, and externalize React.

- [ ] **Step 4: Run package tests, typecheck, and build**

Run: `pnpm exec rstest packages/rsc-runtime/tests/runtime.test.tsx && pnpm --filter @agent-bundle/rsc-runtime typecheck && pnpm --filter @agent-bundle/rsc-runtime build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml packages/rsc-runtime
git commit -m "feat(rsc): publish protocol runtime package"
```

### Task 2: Migrate the existing RSC runtime example

**Files:**
- Modify: `examples/rsc-agent-runtime/package.json`
- Modify: `examples/rsc-agent-runtime/src/hook/cli.ts`
- Modify: `examples/rsc-agent-runtime/src/mcp/handlers.ts`
- Modify: `examples/rsc-agent-runtime/src/dev/invocation-worker.ts`
- Modify: `examples/rsc-agent-runtime/src/runtime/request-context.ts`
- Modify: `examples/rsc-agent-runtime/tests/mcp-lowering.test.tsx`
- Delete: `examples/rsc-agent-runtime/src/runtime/elements.ts`
- Delete: `examples/rsc-agent-runtime/src/runtime/lower-hook.ts`
- Delete: `examples/rsc-agent-runtime/src/runtime/lower-mcp.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `@agent-bundle/rsc-runtime` public exports from Task 1.
- Preserves: the example's `withRenderContext`, `useEdit`, and `useRuntimeSnapshot` API for its demo components.

- [ ] **Step 1: Change the lowering test imports first**

```ts
import { Mcp, lowerMcpResult } from '@agent-bundle/rsc-runtime';
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @agent-bundle/rsc-agent-runtime-demo test -- tests/mcp-lowering.test.tsx`

Expected: FAIL until the workspace dependency is declared and the example imports are migrated.

- [ ] **Step 3: Migrate the example**

Add `"@agent-bundle/rsc-runtime": "workspace:*"`. Replace internal element/lowerer imports with package imports. Keep example request hooks using:

```ts
const context = createRscRequestContext<RenderContext>('RSC runtime hook');
export const withRenderContext = context.run;
export const useEdit = () => context.use().edit;
export const useRuntimeSnapshot = () => context.use().snapshot;
```

Delete only the three duplicated implementation files.

- [ ] **Step 4: Run the complete example gate**

Run: `pnpm --filter @agent-bundle/rsc-agent-runtime-demo check`

Expected: build, 177-test suite, and typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/rsc-agent-runtime pnpm-lock.yaml
git commit -m "refactor(example): consume public RSC runtime"
```

### Task 3: Safe audiobook CLI adapter

**Files:**
- Create: `examples/audiobook-curator/package.json`
- Create: `examples/audiobook-curator/rstest.config.ts`
- Create: `examples/audiobook-curator/src/curator-process.ts`
- Create: `examples/audiobook-curator/tests/fixtures/fake-curator.mjs`
- Create: `examples/audiobook-curator/tests/curator-process.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `runCurator(input, options): Promise<CuratorExecution>`.
- `CuratorExecution` is `{ command, exitCode: 0 | 2, receipt: Record<string, JsonValue>, reviewRequired: boolean, summary: string }`.
- `CuratorRunInput` contains `{ command: CuratorCommand; args: readonly string[]; receiptPath: string; apply?: boolean; overwrite?: boolean }`.

- [ ] **Step 1: Write failing process-boundary tests**

Tests must use a real executable fixture and assert:

```ts
await expect(runCurator({ command: 'inventory', args: ['source'], receiptPath }, { binary: fake }))
  .resolves.toMatchObject({ exitCode: 0, reviewRequired: false });

await expect(runCurator({ command: 'convert', args: ['--apply'], receiptPath }, { binary: fake }))
  .rejects.toThrow('Free-form curator arguments may not contain --apply or --overwrite.');
```

Also cover exit `2`, malformed/missing receipt, output over 256 KiB, timeout, and caller abort.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @agent-bundle-example/audiobook-curator test -- tests/curator-process.test.ts`

Expected: FAIL because `runCurator` does not exist.

- [ ] **Step 3: Implement the bounded runner**

Use `spawn(binary, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })`. Construct `argv` as:

```ts
const argv = [input.command, ...input.args, '--receipt', input.receiptPath];
if (input.apply === true) argv.push('--apply');
if (input.overwrite === true) {
  if (input.apply !== true || input.command !== 'convert') throw new Error('Overwrite requires an applied conversion.');
  argv.push('--overwrite');
}
```

Reject free-form `--apply`, `--overwrite`, and `--receipt`. Bound stdout and stderr independently to 256 KiB, default timeout to 10 minutes, terminate on abort/timeout, accept only exit `0` or `2`, and parse a plain JSON object from the exact receipt path.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @agent-bundle-example/audiobook-curator test -- tests/curator-process.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/audiobook-curator pnpm-lock.yaml
git commit -m "feat(example): add bounded audiobook curator adapter"
```

### Task 4: Audiobook MCP tools and Skill

**Files:**
- Create: `examples/audiobook-curator/agent-bundle.config.ts`
- Create: `examples/audiobook-curator/src/result.tsx`
- Create: `examples/audiobook-curator/src/mcp-server.tsx`
- Create: `examples/audiobook-curator/skills/curate-audiobooks/SKILL.md`
- Create: `examples/audiobook-curator/skills/curate-audiobooks/references/receipt-gates.md`
- Create: `examples/audiobook-curator/tests/mcp-tools.test.tsx`

**Interfaces:**
- Consumes: `Mcp` and `lowerMcpResult` from Task 1; `runCurator` from Task 3.
- Produces MCP tools: `inspect_sources`, `identify_edition`, `prepare_audiobook`, and `audit_audiobook`.

- [ ] **Step 1: Write failing tool contract tests**

Register tools through an exported `createAudiobookCuratorServer(options)` so tests can inject the fake binary. Assert the tool catalog has exactly four tools, the generated result contains both text and structured receipt content, exit `2` sets `isError: false` with `reviewRequired: true`, and `prepare_audiobook` forwards `apply` only from the typed field.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @agent-bundle-example/audiobook-curator test -- tests/mcp-tools.test.tsx`

Expected: FAIL because the server and result component do not exist.

- [ ] **Step 3: Implement RSC result rendering and four tools**

Render every execution with:

```tsx
export const CuratorResult = ({ execution }: { execution: CuratorExecution }) => (
  <Mcp.Result structuredContent={{
    command: execution.command,
    receipt: execution.receipt,
    reviewRequired: execution.reviewRequired,
  }}>
    <Mcp.Text>{execution.summary}</Mcp.Text>
  </Mcp.Result>
);
```

Each tool schema exposes a strict operation enum, `args: string[]`, `receiptPath`, and only the applicable `apply`/`overwrite` booleans. Tool handlers call `lowerMcpResult(<CuratorResult execution={await runCurator(...)} />)`.

- [ ] **Step 4: Add the native Skill and Agent Bundle configuration**

The Skill must require inspect/select before identity, explicit candidate review, dry-run before apply, immutable sources, and final full audit. Configure:

```ts
export default defineConfig({
  mcp: { servers: { curator: { entry: './src/mcp-server.tsx' } } },
  plugin: { name: 'audiobook-curator', version: '1.0.0', description: 'Receipt-backed audiobook curation.' },
  skills: ['skills/curate-audiobooks'],
  targets: ['codex', 'claude'],
});
```

- [ ] **Step 5: Run tests, validation, and build**

Run: `pnpm --filter @agent-bundle-example/audiobook-curator test && pnpm --filter @agent-bundle-example/audiobook-curator validate && pnpm --filter @agent-bundle-example/audiobook-curator build`

Expected: PASS and generated Claude/Codex artifacts contain the Skill and MCP server with no hooks.

- [ ] **Step 6: Commit**

```bash
git add examples/audiobook-curator
git commit -m "feat(example): build audiobook curator plugin"
```

### Task 5: Package and example release verification

**Files:**
- Create: `packages/rsc-runtime/README.md`
- Create: `packages/rsc-runtime/tests/packed-consumer.test.ts`
- Create: `examples/audiobook-curator/README.md`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces documented install/import commands and root gates for both new workspace products.

- [ ] **Step 1: Write the failing packed-consumer test**

Pack `packages/rsc-runtime`, install the tarball in a temporary ESM consumer, and execute:

```js
import { Hook, Mcp, createRscRequestContext, lowerHookResult, lowerMcpResult } from '@agent-bundle/rsc-runtime';
if (![Hook, Mcp, createRscRequestContext, lowerHookResult, lowerMcpResult].every(Boolean)) process.exit(1);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec rstest packages/rsc-runtime/tests/packed-consumer.test.ts`

Expected: FAIL until package files, exports, and build order are complete.

- [ ] **Step 3: Complete release metadata and docs**

Document the stable public boundary, peer dependency, JSX examples, curator executable preflight, dry-run safety, and Claude/Codex build/install commands. Update root build and preview-publish scripts to include `@agent-bundle/rsc-runtime` without changing the `agent-bundle` package contents.

- [ ] **Step 4: Run broad repository gates**

Run:

```bash
pnpm build
pnpm test:unit
pnpm lint
pnpm typecheck
pnpm examples:check
pnpm check:runtime-topology
```

Expected: PASS; only documented skips remain.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json packages/rsc-runtime examples/audiobook-curator
git commit -m "docs: ship RSC runtime and curator example"
```

### Task 6: Read-only installed-bundle acceptance

**Files:**
- Create: `examples/audiobook-curator/scripts/read-only-smoke.mjs`
- Create: `examples/audiobook-curator/tests/read-only-smoke.test.ts`
- Modify: `examples/audiobook-curator/package.json`
- Modify: `examples/audiobook-curator/README.md`

**Interfaces:**
- Produces: `pnpm --filter @agent-bundle-example/audiobook-curator smoke:readonly -- --root <mounted-directory>`.

- [ ] **Step 1: Write a failing synthetic smoke test**

Assert the smoke script rejects missing/non-directory roots, selects at most one bounded subdirectory, invokes only `inventory` and `audit` without `--apply`, and writes receipts beneath an owned temporary directory rather than the mounted volume.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @agent-bundle-example/audiobook-curator test -- tests/read-only-smoke.test.ts`

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the read-only smoke**

Resolve and validate the supplied root, choose one direct child containing supported audio without printing unrelated names, create a temporary receipt directory, invoke the generated bundle's MCP adapter in inventory/audit modes, and always remove only the owned receipt directory. Reject every apply/overwrite option at argument parsing.

- [ ] **Step 4: Run synthetic and mounted acceptance**

Run the synthetic test first. Then locate the mounted ZeroFS audiobook root read-only, install the generated Claude and Codex bundles in isolated test-owned host homes, and invoke inventory/audit against one bounded directory. Do not invoke conversion or metadata/chapter operations.

- [ ] **Step 5: Commit**

```bash
git add examples/audiobook-curator
git commit -m "test(example): verify curator bundle read only"
```

### Task 7: Final integration and push

**Files:** None expected beyond fixes proven necessary by verification.

- [ ] **Step 1: Fetch and merge PR2 if it advanced**

Run: `git fetch origin codex/agent-bundle-implementation && git rev-list --left-right --count HEAD...origin/codex/agent-bundle-implementation`.

If the right count is nonzero, merge with `--no-ff --no-commit`, preserve RSC runtime ownership and PR2 behavior, run affected tests, and commit the merge separately.

- [ ] **Step 2: Verify final state**

Run: `git diff --check && git status --short`, then re-run every gate affected by any final merge.

- [ ] **Step 3: Push and verify**

Push `codex/rsc-agent-runtime-demo`, fetch it, and require local and remote SHAs to match.
