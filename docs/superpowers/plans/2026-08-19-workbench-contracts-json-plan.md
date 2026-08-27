# Workbench Contracts and Strict JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace production workbench imports from backend source internals with one browser-safe public contract subpath and one canonical strict-JSON snapshot implementation.

**Architecture:** Add `agent-bundle/workbench-contracts` as an Rslib entry and package export. It re-exports browser-safe wire types and pure helpers; UI-specific error-message mapping remains in the workbench, and server-only E2E helpers remain white-box test imports.

**Tech Stack:** TypeScript, Rslib, Rsbuild, Rstest, npm package exports.

## Global Constraints

- `workbench-contracts.ts` must not import Node built-ins, service classes, server starters, or asset sources.
- Contract exports are additive; no wire type or persisted format changes.
- Preserve duplicate-key rejection at every JSON object depth.
- Preserve reason-coded workbench JSON failures and `nullPrototype` snapshots.
- Production code under `packages/workbench/src` must not import `packages/agent-bundle/src` directly after migration.
- Test-only E2E server setup may retain explicit internal imports until a separate non-browser test-support API is justified.

---

### Task 1: Add a failing production-import boundary test

**Files:**
- Create: `packages/workbench/tests/contracts-boundary.test.ts`

**Interfaces:**
- Consumes: production sources under `packages/workbench/src`
- Produces: an invariant that no production source imports relative `agent-bundle/src` paths

- [ ] **Step 1: Write the failing test**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { expect, test } from '@rstest/core';

const sourceRoot = join(process.cwd(), 'packages', 'workbench', 'src');

const sourceFiles = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  }))).flat();
};

test('production workbench code imports backend contracts only through the public subpath', async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles(sourceRoot)) {
    const source = await readFile(path, 'utf8');
    if (source.includes('agent-bundle/src/')) offenders.push(path.slice(sourceRoot.length + 1));
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
npx rstest --config rstest.config.ts packages/workbench/tests/contracts-boundary.test.ts
```

Expected: FAIL listing the current production files that import `agent-bundle/src`.

- [ ] **Step 3: Commit the red test**

```sh
git add packages/workbench/tests/contracts-boundary.test.ts
git commit -m "test(workbench): enforce the public contracts boundary"
```

### Task 2: Publish the browser-safe contracts entry

**Files:**
- Create: `packages/agent-bundle/src/workbench-contracts.ts`
- Modify: `rslib.config.ts`
- Modify: `packages/agent-bundle/package.json`
- Modify: `packages/workbench/package.json`
- Modify: `packages/workbench/rsbuild.config.ts`
- Modify: `packages/workbench/tsconfig.json`
- Modify: `rstest.config.ts`
- Test: `packages/agent-bundle/tests/packed-consumer.test.ts`
- Test: `packages/agent-bundle/tests/package-lint-workflow.test.ts`
- Test: `packages/agent-bundle/tests/package-preview-workflow.test.ts`

**Interfaces:**
- Produces: package subpath `agent-bundle/workbench-contracts`
- Produces runtime exports: `parseJsonWithoutDuplicateKeys`, `snapshotStrictJsonValue`, `isJsonRecord`, `isCredentialKey`, `redactEvalCredentialText`
- Produces explicit browser-safe wire types listed below

- [ ] **Step 1: Add failing package-export assertions**

Extend packed/package workflow tests to require:

```ts
expect(manifest.exports).toMatchObject({
  './workbench-contracts': {
    types: './dist/workbench-contracts.d.ts',
    import: './dist/workbench-contracts.js',
  },
});
expect(packedFiles).toContain('dist/workbench-contracts.js');
expect(packedFiles).toContain('dist/workbench-contracts.d.ts');
```

- [ ] **Step 2: Run the package tests and verify RED**

Run:

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/packed-consumer.test.ts \
  packages/agent-bundle/tests/package-lint-workflow.test.ts \
  packages/agent-bundle/tests/package-preview-workflow.test.ts
```

Expected: FAIL because the export and emitted entry do not exist.

- [ ] **Step 3: Add the entry and package export**

Add to `rslib.config.ts`:

```ts
source: {
  entry: {
    // existing entries
    'workbench-contracts': './packages/agent-bundle/src/workbench-contracts.ts',
  },
},
```

Add to `packages/agent-bundle/package.json`:

```json
"./workbench-contracts": {
  "types": "./dist/workbench-contracts.d.ts",
  "import": "./dist/workbench-contracts.js"
}
```

Add `"agent-bundle": "0.1.0"` to the private workbench package dependencies.
Because the root build intentionally builds the workbench before Rslib copies
its output, resolve the public specifier to source during local compilation:

```ts
// packages/workbench/rsbuild.config.ts
resolve: {
  alias: {
    'agent-bundle/workbench-contracts': resolve(
      import.meta.dirname,
      '../agent-bundle/src/workbench-contracts.ts',
    ),
    // existing aliases
  },
},
```

Add the same exact alias to `packages/workbench/tsconfig.json` under
`compilerOptions.paths` and to `rstest.config.ts` under `resolve.alias`. This
keeps clean local builds and tests independent of stale `dist` output while
the source import itself remains the public package specifier.

Create `workbench-contracts.ts` with explicit exports:

```ts
export {
  isJsonRecord,
  parseJsonWithoutDuplicateKeys,
  snapshotStrictJsonValue,
  type JsonValue,
} from './core/strict-json.ts';
export type { Diagnostic } from './core/diagnostics.ts';
export type { SourceProvenance } from './core/types.ts';
export {
  isCredentialKey,
  redactEvalCredentialText,
} from './eval/credentials.ts';
export { provenanceIdentifierPattern } from './eval/provenance.ts';
export type { EvalComparison, EvalConditionMetrics } from './eval/compare.ts';
export type {
  EvalAssertionOutcome,
} from './eval/types.ts';
export type {
  EvalRunEvent,
  EvalRunRecord,
  EvalTrialRecord,
} from './eval/run-store.ts';
export type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionFile,
  ArtifactInspectionScript,
  ArtifactInspectionTarget,
  ProjectStatus,
} from './dev/types.ts';
export type {
  EvalRunResult,
  EvalSuiteListing,
} from './dev/eval-service.ts';
export type {
  DevLogRecord,
  DevLogReplayGap,
} from './dev/dev-log-service.ts';
export type {
  HookPlaygroundSimulation,
} from './dev/hook-playground-service.ts';
export type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
} from './dev/mcp-session-protocol.ts';
export type {
  NativePlaygroundCatalog,
  NativePlaygroundHost,
} from './dev/native-playground-service.ts';
export type {
  PlaygroundOperationRequest,
  PlaygroundRun,
} from './dev/playground-contract.ts';
export type {
  ServedSkillDocument,
  SkillDocumentBase,
  SkillDocumentTree,
} from './dev/skill-document-service.ts';
export type {
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTraceEvent,
} from './services/playground-service.ts';
```

If any listed name is not exported by its owner, export the existing type from
that owner; do not duplicate its shape in the barrel.

- [ ] **Step 4: Prove the runtime entry is browser-safe**

Add a build assertion that `dist/workbench-contracts.js` contains no
`node:` imports:

```ts
const contracts = await readFile(join(packageRoot, 'dist', 'workbench-contracts.js'), 'utf8');
expect(contracts).not.toMatch(/from ['"]node:/u);
expect(contracts).not.toMatch(/require\(['"]node:/u);
```

- [ ] **Step 5: Run tests and build**

Run:

```sh
npm run build
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/packed-consumer.test.ts \
  packages/agent-bundle/tests/package-lint-workflow.test.ts \
  packages/agent-bundle/tests/package-preview-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add rslib.config.ts rstest.config.ts packages/agent-bundle/package.json \
  packages/agent-bundle/src/workbench-contracts.ts packages/agent-bundle/tests \
  packages/workbench/package.json packages/workbench/rsbuild.config.ts \
  packages/workbench/tsconfig.json package-lock.json
git commit -m "feat: publish browser-safe workbench contracts"
```

### Task 3: Canonicalize strict-JSON snapshot behavior

**Files:**
- Modify: `packages/agent-bundle/src/core/strict-json.ts`
- Modify: `packages/workbench/src/strict-json.ts`
- Create: `packages/agent-bundle/tests/strict-json.test.ts`
- Create: `packages/workbench/tests/strict-json.test.ts`

**Interfaces:**
- Produces: `StrictJsonReason`, `StrictJsonError`, `SnapshotStrictJsonOptions`
- `StrictJsonError` extends `TypeError` to preserve backend error compatibility
- `snapshotStrictJsonValue(value, options?)` preserves reason codes and optional null-prototype output
- Workbench keeps `mapStrictJsonReason`

- [ ] **Step 1: Add failing parity tests**

Cover inherited Array prototypes, cyclic objects, accessors, sparse arrays,
extra array keys, symbol keys, nonfinite numbers, null-prototype objects, and
`__proto__` with `nullPrototype: true`.

```ts
expect(() => snapshotStrictJsonValue(Object.setPrototypeOf([], null)))
  .toThrowObject({ reason: 'array-shape' });
expect(Object.getPrototypeOf(snapshotStrictJsonValue(
  JSON.parse('{"__proto__":{"safe":true}}'),
  { nullPrototype: true },
))).toBeNull();
expect(() => snapshotStrictJsonValue({ get value() { return 1; } }))
  .toThrowObject({ reason: 'not-json' });
```

- [ ] **Step 2: Run parity tests and verify RED**

Expected: backend snapshot lacks the structured reason/options contract and
accepts a non-ordinary Array prototype.

- [ ] **Step 3: Move the structured failure contract to core**

Implement in `core/strict-json.ts`:

```ts
export type StrictJsonReason =
  | 'nonfinite'
  | 'not-json'
  | 'cyclic'
  | 'exotic-prototype'
  | 'array-shape';

export class StrictJsonError extends TypeError {
  readonly reason: StrictJsonReason;
  constructor(reason: StrictJsonReason, message: string) {
    super(message);
    this.name = 'StrictJsonError';
    this.reason = reason;
  }
}

export interface SnapshotStrictJsonOptions {
  readonly nullPrototype?: boolean;
}
```

Port the stricter workbench array-prototype check and null-prototype copy into
the canonical recursive implementation. Keep duplicate-key scanning unchanged.

- [ ] **Step 4: Reduce the workbench module to UI policy**

```ts
export {
  snapshotStrictJsonValue,
  StrictJsonError,
  type JsonValue,
  type SnapshotStrictJsonOptions,
  type StrictJsonReason,
} from 'agent-bundle/workbench-contracts';

import {
  StrictJsonError,
  type StrictJsonReason,
} from 'agent-bundle/workbench-contracts';

export const mapStrictJsonReason = <Result>(
  error: unknown,
  messages: Readonly<Record<StrictJsonReason, Result>>,
): Result => {
  if (error instanceof StrictJsonError) return messages[error.reason];
  throw error;
};
```

- [ ] **Step 5: Run strict-JSON tests**

Run:

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/strict-json.test.ts \
  packages/workbench/tests/strict-json.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/agent-bundle/src/core/strict-json.ts \
  packages/workbench/src/strict-json.ts \
  packages/agent-bundle/tests packages/workbench/tests
git commit -m "refactor: share strict JSON snapshots with the workbench"
```

### Task 4: Migrate production workbench imports

**Files:**
- Modify: every production file under `packages/workbench/src` reported by `contracts-boundary.test.ts`
- Test: `packages/workbench/tests/contracts-boundary.test.ts`
- Test: affected client/model/page tests

**Interfaces:**
- Consumes: `agent-bundle/workbench-contracts`
- Produces: zero production imports from relative `agent-bundle/src` paths

- [ ] **Step 1: Replace type and runtime imports**

Use top-level imports such as:

```ts
import {
  parseJsonWithoutDuplicateKeys,
  redactEvalCredentialText,
  type DevLogRecord,
  type JsonValue,
} from 'agent-bundle/workbench-contracts';
```

Keep each file's local names unchanged. Do not migrate E2E server starters or
service classes into the browser contract.

- [ ] **Step 2: Run the boundary test**

Run:

```sh
npx rstest --config rstest.config.ts packages/workbench/tests/contracts-boundary.test.ts
```

Expected: PASS with `[]` offenders.

- [ ] **Step 3: Run affected workbench tests**

Run:

```sh
npx rstest --config rstest.config.ts \
  packages/workbench/tests/project-client.test.ts \
  packages/workbench/tests/skill-client.test.ts \
  packages/workbench/tests/log-client.test.ts \
  packages/workbench/tests/eval-client.test.ts \
  packages/workbench/tests/artifact-client.test.ts \
  packages/workbench/tests/playground-client.test.ts \
  packages/workbench/tests/mcp-session-model.test.ts \
  packages/workbench/tests/hooks-model.test.ts \
  packages/workbench/tests/comparisons-model.test.ts
```

Expected: PASS.

- [ ] **Step 4: Build and browser-smoke**

Run:

```sh
npm run build
```

Start `agent-bundle dev` against `fixtures/integration/micro-eval`, open the
workbench, and assert the Overview navigation and “Foreground server connected”
text render.

- [ ] **Step 5: Commit**

```sh
git add packages/workbench/src packages/workbench/tests/contracts-boundary.test.ts
git commit -m "refactor(workbench): consume the public contracts subpath"
```
