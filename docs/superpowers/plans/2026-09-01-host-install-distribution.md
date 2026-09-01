# Host Install and Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit and validate exact per-host install surfaces and add a safe `agent-bundle install` command.

**Architecture:** Pinned target capability tables own host install facts. A
focused install module renders artifact files and implements Effect-native
host delegation/direct placement behind the existing Promise CLI boundary.
Adapters and artifact validation consume the same immutable contracts.

**Tech Stack:** TypeScript 7, Node.js 22, Effect 4 RC, Commander, Rstest.

## Global Constraints

- Claude and Codex installation delegates to their public CLIs without a shell.
- Cursor placement never uses sudo, changes PATH, or overwrites a collision.
- Cursor copy is staged, atomic, symlink-free, and idempotent.
- Every built-in target emits `INSTALL.md`; only Cursor-compatible fallback profiles require `install.mjs`.
- New orchestration is Effect-native and crosses through `src/effect/boundary.ts`.

---

### Task 1: Pin host install contracts

**Files:**
- Modify: `packages/agent-bundle/src/adapters/capabilities/*.json`
- Modify: `packages/agent-bundle/src/adapters/{claude,codex,cursor,portable,plugin}.ts`
- Test: `packages/agent-bundle/tests/adapter-capability-states.test.ts`

**Interfaces:**
- Produces: adapter capability `install` with evidence or an unavailable reason.

- [ ] Write assertions for the five target install states and exact public commands.
- [ ] Run the focused adapter test and verify it fails because `install` is absent.
- [ ] Add pinned `install` table rows, update capability hashes/revisions, and expose the states.
- [ ] Re-run the focused adapter test.

### Task 2: Emit deterministic install surfaces

**Files:**
- Create: `packages/agent-bundle/src/install/contracts.ts`
- Create: `packages/agent-bundle/src/install/surface.ts`
- Modify: `packages/agent-bundle/src/adapters/types.ts`
- Modify: `packages/agent-bundle/src/adapters/{claude,codex,cursor,portable,plugin}.ts`
- Test: `packages/agent-bundle/tests/install-surface.test.ts`

**Interfaces:**
- Produces: `installSurfaceEntries(target, model, contract): readonly TargetArtifactEntry[]`.

- [ ] Test exact `INSTALL.md`, real names, marketplace availability, and fallback script inclusion for all targets.
- [ ] Run the test and verify the install files are missing.
- [ ] Implement immutable contract snapshots and deterministic Markdown/script rendering.
- [ ] Always emit Claude/Codex local marketplaces and append install entries to each built-in plan.
- [ ] Re-run the install-surface test.

### Task 3: Implement native host installation

**Files:**
- Create: `packages/agent-bundle/src/install/install.ts`
- Modify: `packages/agent-bundle/src/api.ts`
- Modify: `packages/agent-bundle/src/cli.ts`
- Test: `packages/agent-bundle/tests/install.test.ts`
- Test: `packages/agent-bundle/tests/cli.test.ts`

**Interfaces:**
- Produces: `installBundle(options): Promise<InstallResult>`.
- Consumes: a direct bundle root or an artifact root containing a target root.

- [ ] Test Claude/Codex argv delegation, unsupported scopes, missing binaries, direct/artifact roots, Cursor copy/idempotency, unsafe entries, and collisions.
- [ ] Run the focused tests and verify missing API/command failures.
- [ ] Implement Effect orchestration with injected command runner and filesystem/home dependencies.
- [ ] Add the lazy-loaded Commander command and human/JSON output.
- [ ] Re-run focused install and CLI tests.

### Task 4: Enforce artifact install surfaces

**Files:**
- Modify: `packages/agent-bundle/src/build/artifact-diagnostics.ts`
- Modify: `packages/agent-bundle/src/build/validate-artifact.ts`
- Test: `packages/agent-bundle/tests/artifact-validator.test.ts`

**Interfaces:**
- Consumes: manifest target names and immutable install requirements.
- Produces: stable diagnostics for missing or invalid install files.

- [ ] Test missing `INSTALL.md`, missing required fallback script, and valid non-fallback targets.
- [ ] Run the focused validator test and verify it accepts the broken fixtures.
- [ ] Validate required names and reject non-regular install surface entries through existing ownership checks.
- [ ] Re-run the focused validator test.

### Task 5: Document, verify, and land

**Files:**
- Modify: `packages/agent-bundle/README.md`
- Modify: `docs/framework-mode.md`
- Create: `.changeset/<generated-name>.md`

- [ ] Document target distribution and `agent-bundle install`.
- [ ] Add a minor `agent-bundle` changeset.
- [ ] Run scoped tests, package build, typecheck, and lint.
- [ ] Rebase on the latest `origin/main`, resolve only additive conflicts, rerun verification, and commit.
- [ ] Push, open the PR, comment the design on issue #100, merge when checks are green, and report the merge SHA.
