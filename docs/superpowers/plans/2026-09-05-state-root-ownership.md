# State Root Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make uninstall purge only receipt-recorded, installation-owned state subtrees while Doctor reports runtime location, receipt record, and ownership independently.

**Architecture:** Replace the single discovered state root with a per-server resolver and a receipt-owned state ledger. Installation acquires ownership only for derived namespaces or newly created, identity-marked explicit roots; uninstall validates receipt evidence before recursive deletion, and the generated installer mirrors the same rules.

**Tech Stack:** TypeScript, Node.js filesystem/path/crypto APIs, Effect-based installer flow, Rstest, generated self-contained ESM.

## Global Constraints

- Generated plugin output remains self-contained and imports only Node built-ins.
- The optional `@agent-bundle/runtime` peer must not load eagerly from install or CLI code.
- Purge never derives deletion authority from the uninstall process environment.
- Pre-existing, shared, marker-less, foreign-marker, or symlink-retargeted roots are retained.
- Public behavior changes update English and Chinese docs and exactly one patch changeset.

---

### Task 1: Receipt-owned state schema

**Files:**
- Modify: `packages/agent-bundle/src/install/receipt.ts`
- Test: `packages/agent-bundle/tests/receipt.test.ts`

**Interfaces:**
- Produces: `InstallReceiptStateOwner`, `InstallReceiptStateRoot`, `InstallReceiptState`
- Extends: `InstallReceipt.state?: InstallReceiptState`
- Extends: `createInstallReceipt({ state?: InstallReceiptState })`

- [ ] **Step 1: Write failing round-trip and rejection tests**

```ts
const state = {
  owner: { host: 'cursor', id: 'owner-1', mode: 'local', plugin: 'fixture', scope: 'user' },
  roots: [{
    canonicalRoot: '/state/fixture-a',
    ownership: { kind: 'derived' },
    root: '/state/fixture-a',
    servers: ['alpha'],
    source: 'derived',
  }],
} as const;
expect(await roundTripReceipt(createInstallReceipt({ ...identity, inventory, state })))
  .toMatchObject({ state });
```

Also reject malformed owner ids, duplicate/unsorted server lists, relative
roots, invalid ownership discriminants, and marker ownership without an
absolute marker path.

- [ ] **Step 2: Run the receipt test**

Run: `pnpm build && pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/receipt.test.ts`

Expected: FAIL because the receipt does not preserve `state`.

- [ ] **Step 3: Implement and freeze the schema**

```ts
export interface InstallReceiptStateRoot {
  readonly canonicalRoot: string;
  readonly ownership:
    | { readonly kind: 'derived' }
    | { readonly kind: 'marker'; readonly marker: string }
    | { readonly kind: 'unowned'; readonly reason: 'foreign-marker' | 'pre-existing' | 'unproven' };
  readonly root: string;
  readonly servers: readonly string[];
  readonly source: 'declared' | 'derived';
}
```

Validate every nested field in `receiptFromDocument`, freeze arrays and
objects, and preserve backward compatibility when `state` is absent.

- [ ] **Step 4: Re-run the receipt test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/install/receipt.ts packages/agent-bundle/tests/receipt.test.ts
git commit -m "feat: record state ownership in receipts"
```

### Task 2: Per-server runtime state resolution

**Files:**
- Modify: `packages/agent-bundle/src/install/state-root.ts`
- Test: `packages/agent-bundle/tests/state-root.test.ts`

**Interfaces:**
- Produces: `resolveInstalledStateRoots(pluginRoot, host, environment, home): Promise<readonly InstalledStateLocation[]>`
- `InstalledStateLocation`: `{ cwd, root, server, source, status }`
- Removes the singular `resolveInstalledStateRoot`

- [ ] **Step 1: Write failing resolver tests**

```ts
expect(await resolveInstalledStateRoots(root, 'cursor', {}, home)).toEqual([
  expect.objectContaining({ root: first, server: 'alpha', source: 'declared' }),
  expect.objectContaining({ root: second, server: 'beta', source: 'declared' }),
]);
```

Cover two different roots, deduplication metadata, relative overrides resolved
against declared server cwd, unresolved relative overrides without a provable
cwd, root-token expansion, and no manifest override falling back to the
derived root.

- [ ] **Step 2: Run the resolver test**

Run: `pnpm build && pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/state-root.test.ts`

Expected: FAIL because only the first override is returned.

- [ ] **Step 3: Implement the resolver**

Parse all `mcpServers` entries in deterministic name order. Resolve each
server cwd before resolving its state env. Use the packaging-safe local
equivalent of runtime `resolvePluginRoot`, pinned in tests against
`userDataStateRoot` for derived roots and a spawned Node process for relative
`resolve()` semantics.

- [ ] **Step 4: Re-run the resolver test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/install/state-root.ts packages/agent-bundle/tests/state-root.test.ts
git commit -m "feat: resolve every server state root"
```

### Task 3: Install-time ownership acquisition

**Files:**
- Modify: `packages/agent-bundle/src/install/state-root.ts`
- Modify: `packages/agent-bundle/src/install/install.ts`
- Modify: `packages/agent-bundle/src/install/receipt.ts`
- Test: `packages/agent-bundle/tests/install.test.ts`
- Test: `packages/agent-bundle/tests/uninstall.test.ts`

**Interfaces:**
- Produces: `recordInstalledState(options): Promise<{ state, rollback }>`
- Produces marker: `.agent-bundle-state-owner.json`
- Consumes the per-server resolver from Task 2

- [ ] **Step 1: Write failing install tests**

Create two absent explicit roots and one pre-existing shared root containing
`sentinel.txt`. Assert the receipt owns the absent roots by marker, records the
shared root as `unowned: pre-existing`, and each marker contains the receipt
owner id and install identity.

- [ ] **Step 2: Run install tests**

Expected: FAIL because install writes no state ledger or markers.

- [ ] **Step 3: Implement acquisition and rollback**

```ts
export interface StateOwnershipAcquisition {
  readonly state: InstallReceiptState;
  readonly rollback: () => Promise<void>;
}
```

Generate or retain one owner UUID. Record derived roots without creating them.
For explicit absent roots, create the directory and marker with exclusive
filesystem operations. For existing roots, inspect markers without replacing
anything. On downstream failure, remove only markers created by this attempt
and remove only directories that become empty.

- [ ] **Step 4: Thread state through every receipt writer**

Cover Cursor local install/adopt/replace, Claude/Codex store receipts, and
receipt refresh. Replacement carries the existing owner id and reacquires
only newly declared roots.

- [ ] **Step 5: Re-run install and uninstall tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bundle/src/install packages/agent-bundle/tests/install.test.ts packages/agent-bundle/tests/uninstall.test.ts
git commit -m "feat: acquire installation state ownership"
```

### Task 4: Receipt-only purge planning and deletion

**Files:**
- Modify: `packages/agent-bundle/src/install/state-root.ts`
- Modify: `packages/agent-bundle/src/install/uninstall.ts`
- Test: `packages/agent-bundle/tests/uninstall.test.ts`

**Interfaces:**
- Produces: `inspectRecordedStateOwnership(record): Promise<StatePurgeDecision>`
- `StatePurgeDecision`: `{ action: 'purge' | 'retain' | 'absent', reason, root }`

- [ ] **Step 1: Write destructive-safety regression tests**

Cover changed uninstall env, two installs sharing a base, foreign marker,
marker-less root, unrelated sentinels outside owned roots, symlinked leaf,
unchanged symlink ancestor, retargeted ancestor, and keep-data followed by
later purge.

```ts
await uninstallBundle({ ...options, environment: changedEnv, purgeData: true, confirmPurge: true });
expect(await exists(recordedOwnedRoot)).toBe(false);
expect(await readFile(sharedSentinel, 'utf8')).toBe('keep\n');
```

- [ ] **Step 2: Run uninstall tests**

Expected: FAIL because uninstall still discovers roots from current env and
recursively removes every discovered directory.

- [ ] **Step 3: Implement evidence validation**

Read candidates only from `receipt.state.roots`. Require absolute lexical and
canonical roots, a real directory leaf, unchanged canonical resolution, and
an exact marker identity for marker-owned roots. Return retained decisions
instead of throwing for failed ownership evidence.

- [ ] **Step 4: Update typed and human reports**

List purged paths separately from retained state roots and include the reason
for each retained root. `--plan` reports the same decisions without writes.

- [ ] **Step 5: Re-run uninstall tests**

Expected: PASS and every sentinel survives.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bundle/src/install/state-root.ts packages/agent-bundle/src/install/uninstall.ts packages/agent-bundle/tests/uninstall.test.ts
git commit -m "fix: purge only receipted state roots"
```

### Task 5: Doctor ownership inventory

**Files:**
- Modify: `packages/agent-bundle/src/install/doctor.ts`
- Modify: `packages/agent-bundle/src/cli.ts`
- Test: `packages/agent-bundle/tests/doctor.test.ts`

**Interfaces:**
- Extends: `DoctorDurableStateReport`
- Reports current locations, receipt matches, ownership, purgeability, reason,
  existence, writability, and servers

- [ ] **Step 1: Write failing Doctor tests**

Assert rows for derived-owned, marker-owned, shared-unowned, foreign-marker,
missing, and current-location-different-from-receipt cases.

- [ ] **Step 2: Run Doctor tests**

Expected: FAIL because Doctor exposes only one effective root and legacy root.

- [ ] **Step 3: Implement Doctor reports**

Inventory all current and recorded roots without opening state databases.
Deduplicate by path, retain server names, validate marker/canonical evidence
read-only, and add a diagnostic for retained unowned or invalidated ownership.

- [ ] **Step 4: Re-run Doctor tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/install/doctor.ts packages/agent-bundle/src/cli.ts packages/agent-bundle/tests/doctor.test.ts
git commit -m "feat: report state ownership in doctor"
```

### Task 6: Generated installer parity

**Files:**
- Modify: `packages/agent-bundle/src/install/surface.ts`
- Test: `packages/agent-bundle/tests/install-surface.test.ts`
- Test: `packages/agent-bundle/tests/packed-readonly-state-root.test.ts`

**Interfaces:**
- Generated `install.mjs` writes/reads the Task 1 receipt state shape and uses
  the Task 2–4 ownership rules with Node built-ins only

- [ ] **Step 1: Add failing generated-installer tests**

Exercise two roots, shared sentinel retention, relative cwd, symlink ancestor,
keep then later purge, and marker ownership.

- [ ] **Step 2: Run generated and packed tests**

Run:

```bash
pnpm build
pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/install-surface.test.ts
pnpm exec rstest --config rstest.config.ts packages/agent-bundle/tests/packed-readonly-state-root.test.ts
```

Expected: FAIL until emitted source mirrors the core behavior.

- [ ] **Step 3: Implement emitted parity**

Keep marker, resolver, receipt parser/writer, and purge decision code in the
generated installer self-contained. Do not introduce package imports.

- [ ] **Step 4: Re-run generated and packed tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/install/surface.ts packages/agent-bundle/tests/install-surface.test.ts packages/agent-bundle/tests/packed-readonly-state-root.test.ts
git commit -m "fix: generate ownership-safe state purge"
```

### Task 7: Documentation, changeset, and release gates

**Files:**
- Modify: `website/docs/en/reference/cli.mdx`
- Modify: `website/docs/zh/reference/cli.mdx`
- Modify: `docs/diagnostics.md`
- Create: `.changeset/<slug>.md`

**Interfaces:**
- Documents the three-fact model and any new diagnostic code

- [ ] **Step 1: Update English and Chinese CLI references**

State that runtime location does not imply ownership, explain marker-owned
explicit roots, list retained reasons, and describe Doctor ownership rows.

- [ ] **Step 2: Add diagnostics and one patch changeset**

The changeset summary names `uninstall --purge-data`, `doctor`, and any new
diagnostic codes, is imperative, and ends with `(#<PR>)` once the PR exists.

- [ ] **Step 3: Run deslop**

Read the full diff against `origin/main`; remove redundant comments, defensive
checks on trusted paths, duplicate helpers, casts that only silence types, and
unnecessary nesting without changing behavior.

- [ ] **Step 4: Run all gates**

```bash
pnpm build &&
pnpm typecheck &&
pnpm lint &&
pnpm test:unit &&
pnpm docs:site:build
```

Also run the targeted packed regression and any affected host-install tests.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add website/docs docs/diagnostics.md .changeset
git commit -m "docs: explain state root ownership"
```

### Task 8: Review and merge

**Files:**
- No source files unless review finds a defect

**Interfaces:**
- Produces a squash-merged PR closing #644 and linking #592

- [ ] **Step 1: Push and open the PR**

Include `Closes #644`, `Related: #592`, validation, and deslop sections.

- [ ] **Step 2: Run Claude review**

Use `claude-fable-5-1-thinking-high`; request concrete merge risks only.
Resolve every finding and rerun the reviewer after fixes.

- [ ] **Step 3: Record self-review and wait for CI**

Update the PR body with reviewer model, findings, dispositions, and final
result. Address every review thread and require all checks green.

- [ ] **Step 4: Arm squash auto-merge**

```bash
gh pr merge <PR> --squash --auto
```

- [ ] **Step 5: Report result**

Report PR URL, merge SHA, closed issue, and the ownership model in exactly
three concise lines.
