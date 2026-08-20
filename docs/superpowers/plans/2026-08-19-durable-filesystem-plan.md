# Durable Filesystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five embedded durable-filesystem implementations with one tested mechanism layer while preserving each domain's serialization, lock schema, recovery policy, and errors.

**Architecture:** `core/durable-fs.ts` owns low-level filesystem ordering and identity verification. Dev lock, epoch store, eval run store, Playground, and native Playground retain all domain decisions and call the shared primitives.

**Tech Stack:** Node.js `fs/promises`, TypeScript, Rstest, Windows/POSIX capability handling.

## Global Constraints

- Preserve file names, bytes, permissions, rename/link ordering, and directory sync behavior.
- Reuse `core/errors.ts:isTolerableWin32SyncError`.
- Do not move owner parsing, PID liveness, stale recovery, JSON encoding, or domain errors into core.
- Preserve original caught errors through `cause`.
- Never follow symlinks for mutable pinned files.
- Keep test hooks at the domain boundary unless they represent filesystem mechanisms.

---

### Task 1: Introduce tested durable-filesystem primitives

**Files:**
- Create: `packages/agent-bundle/src/core/durable-fs.ts`
- Create: `packages/agent-bundle/tests/durable-fs.test.ts`

**Interfaces:**
- Produces:

```ts
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface PinnedRegularFile {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

export const syncDirectory: (path: string) => Promise<void>;
export const syncDirectorySync: (path: string) => void;
export const writeFileExclusiveDurably: (
  path: string,
  bytes: string | Uint8Array,
  options?: Readonly<{ mode?: number }>,
) => Promise<void>;
export const replaceFileDurably: (
  path: string,
  bytes: string | Uint8Array,
  options?: Readonly<{ mode?: number; temporarySuffix?: string }>,
) => Promise<void>;
export const publishFileNoReplaceDurably: (
  stagedPath: string,
  destinationPath: string,
) => Promise<void>;
export const openPinnedRegularFile: (
  path: string,
  flags: number,
) => Promise<PinnedRegularFile>;
export const unlinkIfIdentityMatches: (
  path: string,
  expected: FileIdentity,
) => Promise<boolean>;
```

- [ ] **Step 1: Write failing primitive tests**

Test:

```ts
test('replaceFileDurably publishes bytes and removes its stage file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-'));
  const path = join(root, 'record.json');
  await writeFile(path, 'old');
  await replaceFileDurably(path, 'new');
  expect(await readFile(path, 'utf8')).toBe('new');
  expect((await readdir(root)).filter((name) => name !== 'record.json')).toEqual([]);
});

test('openPinnedRegularFile rejects a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-pinned-'));
  await writeFile(join(root, 'target'), 'x');
  await symlink('target', join(root, 'link'));
  await expect(openPinnedRegularFile(join(root, 'link'), constants.O_RDWR))
    .rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/u) });
});

test('unlinkIfIdentityMatches preserves a replacement owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-owner-'));
  const path = join(root, 'owner');
  await writeFile(path, 'first');
  const first = await lstat(path, { bigint: true });
  await rm(path);
  await writeFile(path, 'second');
  expect(await unlinkIfIdentityMatches(path, { dev: first.dev, ino: first.ino })).toBe(false);
  expect(await readFile(path, 'utf8')).toBe('second');
});
```

Add injected filesystem-operation tests for sync ordering:

```ts
expect(events).toEqual([
  'open-stage', 'write-stage', 'sync-stage', 'close-stage',
  'rename-stage', 'sync-parent',
]);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
npx rstest --config rstest.config.ts packages/agent-bundle/tests/durable-fs.test.ts
```

Expected: FAIL because `core/durable-fs.ts` does not exist.

- [ ] **Step 3: Implement the mechanism layer**

Implementation rules:

```ts
const identityOf = (stats: BigIntStats): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
```

- `syncDirectory` opens the directory read-only, calls `sync`, tolerates only
  `isTolerableWin32SyncError`, and always closes the handle.
- `replaceFileDurably` creates a same-directory unique stage with `wx`, writes,
  syncs, closes, renames, syncs the parent, and removes the stage on failure.
- `publishFileNoReplaceDurably` links staged to destination, syncs the parent,
  and never replaces an existing destination.
- `openPinnedRegularFile` uses `O_NOFOLLOW` when available; requires regular
  file and `nlink === 1`; compares handle `stat({ bigint: true })` with pathname
  `lstat({ bigint: true })`; closes before throwing.
- `unlinkIfIdentityMatches` uses `lstat({ bigint: true })` immediately before
  unlink and returns false for missing or replaced paths.

- [ ] **Step 4: Run tests and verify GREEN**

Run the durable-fs test on Linux. Keep platform-specific tests capability-based
so they pass on Windows without weakening checks.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/core/durable-fs.ts \
  packages/agent-bundle/tests/durable-fs.test.ts
git commit -m "refactor(core): centralize durable filesystem primitives"
```

### Task 2: Migrate dev-lock

**Files:**
- Modify: `packages/agent-bundle/src/dev/dev-lock.ts`
- Test: `packages/agent-bundle/tests/dev-lock.test.ts`

**Interfaces:**
- Consumes: `syncDirectory`, `writeFileExclusiveDurably`, `unlinkIfIdentityMatches`
- Removes local: `syncDirectory`, `writeCompleteExclusive`, `removeIfOwned`

- [ ] **Step 1: Add a failing ownership-race characterization**

Add a test that replaces the lock between owner verification and close, then
asserts `DevLock.close()` preserves the replacement lock and still reports the
original close outcome.

- [ ] **Step 2: Verify RED**

Temporarily assert the shared helper is called through an injected operation
seam; expected failure is that dev-lock still owns local primitives.

- [ ] **Step 3: Replace only mechanisms**

Keep owner serialization, PID checks, stale-owner retries, and `DevLockError`
construction in `dev-lock.ts`. Pass the captured file identity to
`unlinkIfIdentityMatches` on close.

- [ ] **Step 4: Run tests**

```sh
npx rstest --config rstest.config.ts packages/agent-bundle/tests/dev-lock.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/dev/dev-lock.ts \
  packages/agent-bundle/tests/dev-lock.test.ts
git commit -m "refactor(dev): use shared durable lock primitives"
```

### Task 3: Migrate epoch and eval stores

**Files:**
- Modify: `packages/agent-bundle/src/dev/epoch-store.ts`
- Modify: `packages/agent-bundle/src/eval/run-store.ts`
- Test: `packages/agent-bundle/tests/epoch-store.test.ts`
- Test: `packages/agent-bundle/tests/eval-run-store.test.ts`

**Interfaces:**
- Consumes: `syncDirectory`, `replaceFileDurably`
- Keeps: recursive epoch tree sync and all manifest/run JSON encoding

- [ ] **Step 1: Add failing operation-order tests**

For epoch activation and eval-run JSON replacement, assert stage write and file
sync precede rename, and parent sync follows rename. Preserve existing
injection hooks to observe order.

- [ ] **Step 2: Verify RED against local implementations**

Expected: test identifies the local path rather than the shared primitive seam.

- [ ] **Step 3: Migrate `#writeJsonAtomically` and `writeJsonAtomically`**

Serialize in each caller:

```ts
const bytes = `${stableJson(value)}\n`;
await replaceFileDurably(path, bytes, { mode: 0o600 });
```

Keep epoch `#syncTree` because recursive artifact-tree traversal is domain
behavior; replace only its directory-sync leaf with `syncDirectory`.

- [ ] **Step 4: Run tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/epoch-store.test.ts \
  packages/agent-bundle/tests/eval-run-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/dev/epoch-store.ts \
  packages/agent-bundle/src/eval/run-store.ts \
  packages/agent-bundle/tests/epoch-store.test.ts \
  packages/agent-bundle/tests/eval-run-store.test.ts
git commit -m "refactor(storage): share durable JSON publication"
```

### Task 4: Migrate native Playground catalog publication

**Files:**
- Modify: `packages/agent-bundle/src/dev/native-playground-service.ts`
- Test: `packages/agent-bundle/tests/native-playground-service.test.ts`

**Interfaces:**
- Consumes: `publishFileNoReplaceDurably`, `syncDirectory`
- Keeps: catalog naming, JSON encoding, collision policy, and domain errors

- [ ] **Step 1: Add a failing no-replace race test**

Create a staged catalog and concurrently create the destination. Assert the
existing destination remains byte-identical and the staged file is cleaned
according to existing policy.

- [ ] **Step 2: Verify RED against the shared helper seam**

- [ ] **Step 3: Replace the hard-link publication block**

Use:

```ts
await publishFileNoReplaceDurably(stagedPath, destinationPath);
```

Translate `EEXIST` at the existing domain boundary and preserve its cause.

- [ ] **Step 4: Run tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/native-playground-service.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/dev/native-playground-service.ts \
  packages/agent-bundle/tests/native-playground-service.test.ts
git commit -m "refactor(playground): share durable catalog publication"
```

### Task 5: Migrate Playground pinned files and owner unlink

**Files:**
- Modify: `packages/agent-bundle/src/services/playground-service.ts`
- Test: `packages/agent-bundle/tests/playground-service.test.ts`
- Test: affected eval-service tests that exercise pinned-file rejection

**Interfaces:**
- Consumes: `openPinnedRegularFile`, `writeFileExclusiveDurably`, `syncDirectory`, `unlinkIfIdentityMatches`
- Removes local: `#syncDirectory`, `#writeNewFile`, `#openPinnedMutableFile`, `#assertMutableFile`, `#unlinkExpectedOwner`
- Keeps: persisted codecs, owner parsing, session policy, and `PlaygroundServiceError`

- [ ] **Step 1: Add failing helper-boundary tests**

Cover:

```ts
await expect(openSessionThroughSymlink()).rejects.toMatchObject({
  code: 'playground.storage.unsafe',
});
await closeAfterOwnerReplacement();
expect(await readFile(ownerPath, 'utf8')).toBe(replacementBytes);
```

- [ ] **Step 2: Verify RED**

Expected: the new shared-operation seam is not yet used.

- [ ] **Step 3: Replace private filesystem mechanisms**

Adapt `PinnedRegularFile` identity to the existing persisted/session owner
identity type at one boundary. Do not cast; construct the explicit object.

- [ ] **Step 4: Run affected tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/playground-service.test.ts \
  packages/agent-bundle/tests/eval-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/services/playground-service.ts \
  packages/agent-bundle/tests/playground-service.test.ts \
  packages/agent-bundle/tests/eval-service.test.ts
git commit -m "refactor(playground): use shared pinned-file primitives"
```
