# Playground Decomposition and Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Playground selectors, effects, persistence, and decoding in their canonical owners; reduce `playground-service.ts` below 1,000 lines without adding pass-through layers.

**Architecture:** Pure selection moves to the model, transport/effect orchestration moves to a controller, and persisted session/index/owner operations move to one persistence module. A small decoder combinator is introduced only after these boundaries settle and only where it deletes meaningful code.

**Tech Stack:** TypeScript, React 19, Rstest, `@rstest/playwright`.

## Global Constraints

- Preserve Playground HTTP contracts, event ordering, persisted documents, and recovery behavior.
- Keep `PlaygroundService` as the session lifecycle and operation-admission authority.
- Do not move React rendering into model/controller modules.
- Do not create identity wrappers around persistence methods.
- Preserve domain error codes and causes.
- Every decoder migration must reduce code and keep exact-key validation.

---

### Task 1: Move pure Playground selectors to the model

**Files:**
- Modify: `packages/workbench/src/playground/playground-model.ts`
- Modify: `packages/workbench/src/playground/playground-page.tsx`
- Test: `packages/workbench/tests/playground-model.test.ts`
- Test: `packages/workbench/tests/playground-page.test.ts`

**Interfaces:**
- Model owns:
  - `playgroundScriptsForEpoch`
  - `playgroundScriptsForTarget`
  - `playgroundSelectedScriptId`
  - `nativeSelections`
  - `availableNativeHosts`
  - `availableNativeCases`
  - `availableNativeFixtures`
  - `availableNativeModelPins`

- [ ] **Step 1: Move selector tests to the model test and verify RED**

Import selectors from `playground-model.ts` before moving them:

```ts
expect(playgroundScriptsForTarget(epoch, 'claude')).toEqual(expectedScripts);
expect(playgroundSelectedScriptId(scripts, missingSelection)).toBe(scripts[0]?.id);
expect(availableNativeHosts(catalog)).toEqual(['claude', 'codex']);
```

Expected: compile failure because selectors are still exported from the page.

- [ ] **Step 2: Move implementations without changing bodies**

Put all imports at the top of `playground-model.ts`; update page and main imports
to consume selectors from the model. The page should retain JSX-only helpers.

- [ ] **Step 3: Run tests**

```sh
npx rstest --config rstest.config.ts \
  packages/workbench/tests/playground-model.test.ts \
  packages/workbench/tests/playground-page.test.ts
```

- [ ] **Step 4: Commit**

```sh
git add packages/workbench/src/playground \
  packages/workbench/tests/playground-model.test.ts \
  packages/workbench/tests/playground-page.test.ts
git commit -m "refactor(workbench): move Playground selection into the model"
```

### Task 2: Extract Playground controller effects

**Files:**
- Create: `packages/workbench/src/playground/playground-controller.ts`
- Create: `packages/workbench/tests/playground-controller.test.ts`
- Modify: `packages/workbench/src/playground/playground-page.tsx`
- Modify: `packages/workbench/src/main.tsx`

**Interfaces:**
- Produces:

```ts
export interface ObservePlaygroundRunOptions {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: PlaygroundTraceEvent) => void;
  readonly onComplete: (run: PlaygroundRun) => void;
  readonly onError: (error: unknown) => void;
}

export const observePlaygroundRun: (
  client: PlaygroundClient,
  options: ObservePlaygroundRunOptions,
) => Promise<void>;

export interface PlaygroundCatalogController {
  readonly snapshot: () => NativePlaygroundCatalog | undefined;
  readonly refresh: (signal?: AbortSignal) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
}
```

- [ ] **Step 1: Write failing controller tests**

Test event forwarding, terminal completion, abort without error presentation,
catalog refresh replacement, stale response rejection, and unsubscribe.

```ts
await observePlaygroundRun(client, {
  runId: 'run-1',
  signal: controller.signal,
  onEvent: (event) => events.push(event),
  onComplete: (run) => completions.push(run),
  onError: (error) => errors.push(error),
});
expect(events).toEqual(expectedEvents);
expect(completions).toEqual([expectedRun]);
expect(errors).toEqual([]);
```

- [ ] **Step 2: Verify RED**

Expected: controller module does not exist.

- [ ] **Step 3: Move effects and transport lifecycle**

The controller may import client and contract modules but no React. Components
use `useEffect` only to subscribe, refresh, and dispose the controller.

- [ ] **Step 4: Run tests and browser checks**

```sh
npx rstest --config rstest.config.ts \
  packages/workbench/tests/playground-controller.test.ts \
  packages/workbench/tests/playground-page.test.ts \
  packages/workbench/tests/playground-real.e2e.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add packages/workbench/src/playground packages/workbench/src/main.tsx \
  packages/workbench/tests/playground-controller.test.ts \
  packages/workbench/tests/playground-page.test.ts
git commit -m "refactor(workbench): isolate Playground transport lifecycle"
```

### Task 3: Extract persisted Playground codecs

**Files:**
- Create: `packages/agent-bundle/src/services/playground-persistence.ts`
- Create: `packages/agent-bundle/tests/playground-persistence.test.ts`
- Modify: `packages/agent-bundle/src/services/playground-service.ts`
- Test: `packages/agent-bundle/tests/playground-service.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PlaygroundPersistence {
  createSession(document: PersistedPlaygroundSession): Promise<void>;
  readSession(sessionId: string): Promise<PersistedPlaygroundSession | undefined>;
  updateSession(document: PersistedPlaygroundSession): Promise<void>;
  appendEvent(sessionId: string, event: PlaygroundTraceEvent): Promise<void>;
  readEvents(sessionId: string): Promise<readonly PlaygroundTraceEvent[]>;
  listSessionIds(): Promise<readonly string[]>;
}

export const createPlaygroundPersistence: (
  options: PlaygroundPersistenceOptions,
) => PlaygroundPersistence;
```

The persisted types remain internal and preserve their exact JSON shapes.

- [ ] **Step 1: Add failing persistence contract tests**

Cover create/read/update, append order, malformed documents, missing sessions,
restart recovery, and index consistency:

```ts
await persistence.createSession(document);
await persistence.appendEvent(document.id, first);
await persistence.appendEvent(document.id, second);
expect(await persistence.readSession(document.id)).toEqual(document);
expect(await persistence.readEvents(document.id)).toEqual([first, second]);
expect(await persistence.listSessionIds()).toEqual([document.id]);
```

- [ ] **Step 2: Verify RED**

Expected: persistence module does not exist.

- [ ] **Step 3: Move codecs and storage operations**

Move exact-key checks, persisted identity/outcome parsing, event/index parsing,
and file layout into the persistence owner. Consume durable-fs primitives from
the earlier plan. `PlaygroundService` calls persistence at lifecycle
boundaries; it must not forward every persistence method through a private
identity wrapper.

- [ ] **Step 4: Run tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/playground-persistence.test.ts \
  packages/agent-bundle/tests/playground-service.test.ts
```

- [ ] **Step 5: Check decomposition**

Run:

```sh
wc -l packages/agent-bundle/src/services/playground-service.ts \
  packages/agent-bundle/src/services/playground-persistence.ts
```

Expected: `playground-service.ts` is below 1,000 lines and the persistence
module has one clear responsibility.

- [ ] **Step 6: Commit**

```sh
git add packages/agent-bundle/src/services/playground-persistence.ts \
  packages/agent-bundle/src/services/playground-service.ts \
  packages/agent-bundle/tests/playground-persistence.test.ts \
  packages/agent-bundle/tests/playground-service.test.ts
git commit -m "refactor(playground): extract persisted session storage"
```

### Task 4: Move owner-lock persistence and coordination

**Files:**
- Modify: `packages/agent-bundle/src/services/playground-persistence.ts`
- Modify: `packages/agent-bundle/src/services/playground-service.ts`
- Test: `packages/agent-bundle/tests/playground-persistence.test.ts`
- Test: `packages/agent-bundle/tests/playground-service.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PlaygroundOwnerLease {
  readonly identity: PlaygroundSessionIdentity;
  release(): Promise<void>;
}

export interface PlaygroundOwnerLeaseManager {
  acquire(identity: PlaygroundSessionIdentity): Promise<PlaygroundOwnerLease>;
}
```

- [ ] **Step 1: Add failing owner-race tests**

Cover simultaneous acquisition, stale owner recovery, replacement-owner
preservation, failed release retry, and coordination-map cleanup.

```ts
const first = await manager.acquire(identity);
await expect(manager.acquire(identity)).rejects.toMatchObject({
  code: 'playground.owner.conflict',
});
await first.release();
await expect(manager.acquire(identity)).resolves.toBeDefined();
```

- [ ] **Step 2: Verify RED**

Expected: owner lease manager does not exist.

- [ ] **Step 3: Move ownership persistence, not policy**

The persistence module owns owner-file bytes, file identity, durable creation,
conditional unlink, and per-root mutation tails. The service supplies the
current process identity and decides whether a parsed owner is stale. Document
when coordination-map entries are created and removed.

- [ ] **Step 4: Run tests and line-count check**

Run the two Playground suites. Confirm service remains below 1,000 lines.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/services/playground-persistence.ts \
  packages/agent-bundle/src/services/playground-service.ts \
  packages/agent-bundle/tests/playground-persistence.test.ts \
  packages/agent-bundle/tests/playground-service.test.ts
git commit -m "refactor(playground): isolate owner lease persistence"
```

### Task 5: Introduce a minimal decoder combinator

**Files:**
- Create: `packages/agent-bundle/src/core/decode.ts`
- Create: `packages/agent-bundle/tests/decode.test.ts`
- Modify first: `packages/agent-bundle/src/eval/run-store-codec.ts`
- Test: `packages/agent-bundle/tests/eval-run-store.test.ts`

**Interfaces:**
- Produces only:

```ts
export type Decoder<T> = (value: unknown, path: string) => T;
export const stringValue: Decoder<string>;
export const safeInteger: Decoder<number>;
export const literalUnion: <const Values extends readonly string[]>(
  values: Values,
  error: DecodeErrorFactory,
) => Decoder<Values[number]>;
export const arrayOf: <T>(
  item: Decoder<T>,
  error: DecodeErrorFactory,
) => Decoder<readonly T[]>;
export const exactObject: <Shape extends DecoderShape>(
  shape: Shape,
  error: DecodeErrorFactory,
) => Decoder<DecodedShape<Shape>>;
export const optional: <T>(decoder: Decoder<T>) => Decoder<T | undefined>;
```

The error factory receives path, expected shape, and actual value and returns
the caller's existing domain error.

- [ ] **Step 1: Add failing core decoder tests**

Cover exact keys, missing keys, optional fields, nested paths, arrays, safe
integers, and literal unions:

```ts
const decode = exactObject({
  id: stringValue,
  attempts: safeInteger,
  label: optional(stringValue),
}, errorFactory);
expect(decode({ id: 'x', attempts: 1 }, '$')).toEqual({
  id: 'x',
  attempts: 1,
  label: undefined,
});
expect(() => decode({ id: 'x', attempts: 1, extra: true }, '$'))
  .toThrowObject({ code: 'test.decode', path: '$.extra' });
```

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement the minimal combinators**

Use `isRecord` and `hasExactOwnKeys` from strict-json. No schema registry,
coercion, transforms, unions beyond literal strings, or async decoding.

- [ ] **Step 4: Migrate one run-store codec family**

Replace one cohesive `parse*` cluster in `run-store-codec.ts`. Preserve its
error class/code and compare line count before/after. If the migration does not
remove at least the repeated exact-key/type boilerplate, revert that migration
but retain the independently useful tested core only if another immediate
consumer exists.

- [ ] **Step 5: Run tests and commit**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/decode.test.ts \
  packages/agent-bundle/tests/eval-run-store.test.ts
git add packages/agent-bundle/src/core/decode.ts \
  packages/agent-bundle/src/eval/run-store-codec.ts \
  packages/agent-bundle/tests/decode.test.ts \
  packages/agent-bundle/tests/eval-run-store.test.ts
git commit -m "refactor(core): reduce persisted object decoding boilerplate"
```

### Task 6: Evaluate and migrate remaining decoder families

**Files:**
- Candidate: `packages/agent-bundle/src/config/validate.ts`
- Candidate: `packages/agent-bundle/src/build/validate-artifact.ts`
- Candidate: `packages/agent-bundle/src/dev/mcp-app-protocol.ts`
- Candidate: `packages/agent-bundle/src/dev/epoch-store.ts`
- Candidate: `packages/agent-bundle/src/services/playground-persistence.ts`
- Tests: each candidate's existing focused suite

**Interfaces:**
- Consumes: `core/decode.ts`
- Produces: fewer concepts and fewer lines per migrated decoder family

- [ ] **Step 1: Measure each candidate**

For each family, count repeated exact-key/type checks and identify its existing
error factory. Migrate only families that can use the exact existing
combinators without adding a new combinator.

- [ ] **Step 2: Add one failing characterization per selected family**

Assert exact error code, path, and message for an unknown key and wrong scalar
type before editing.

- [ ] **Step 3: Migrate one family per commit**

Run its focused tests after each migration. Do not batch config validation,
artifact validation, epoch decoding, and Playground persistence in one commit.

- [ ] **Step 4: Reject non-simplifying migrations**

If a migrated family has equal or greater line count, more generic parameters,
or additional branching, restore it and record that the bespoke decoder is the
simpler design. The goal is deleted complexity, not framework adoption.

- [ ] **Step 5: Final Playground and workbench verification**

Run:

```sh
npm run check
npm run check:release
```

Then start the packaged workbench and manually exercise every top-level page.
