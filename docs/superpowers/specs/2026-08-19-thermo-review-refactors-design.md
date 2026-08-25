# Thermo-review refactor design

## Context

PR #2 adds the Agent Bundle compiler, developer workbench, host adapters, and
evaluation runtime. A strict maintainability review found that the behavior is
well tested and the main architecture is sound, but several implementation
details duplicate security-sensitive filesystem logic, expose backend source
layout to the workbench, and leave one service above 1,000 lines.

The already-committed workbench build fix (`8cbc037`) is independent of this
design. This document covers the remaining structural findings.

## Goals

- Give the workbench one supported contracts import surface.
- Centralize shared strict-JSON structural guards without changing UI error
  presentation.
- Centralize durable filesystem mechanisms while preserving domain-specific
  lock and recovery policy.
- Remove unsafe type escapes at Agent API and normalized-config boundaries.
- Consolidate repeated shutdown-failure collection without changing public
  error classes or failure ordering.
- Move project routing and Playground model/controller logic to their
  canonical layers.
- Decompose `PlaygroundService` below 1,000 lines.
- Reduce repeated handwritten object decoding after the ownership boundaries
  are stable.
- Preserve behavior and keep every intermediate commit releasable.

## Non-goals

- No protocol, manifest, artifact, or persisted-data format changes.
- No public CLI or HTTP route changes.
- No unification of domain-specific close-error classes.
- No generic filesystem framework or generic schema library.
- No changes to stale-owner policy, lock schemas, or process-liveness checks.
- No rewrite of the epoch, run-store, or Playground state models.

## Design

### 1. Public workbench contracts subpath

Add an exported `agent-bundle/workbench-contracts` package subpath containing
browser-safe wire contracts, discriminated unions, identifiers, and structural
JSON guards used by both packages. It must not import Node built-ins or backend
services.

The workbench will import backend-facing types and runtime validation constants
only through this subpath. UI-specific parsing errors remain local to the
workbench so its presentation contract does not leak into the compiler package.
The canonical strict-JSON snapshot implementation will live behind this
browser-safe boundary; duplicate workbench snapshot code will be removed.

Package exports and build entries will make the subpath available to installed
consumers and to the workbench build. A package-boundary test will reject
workbench imports from `packages/agent-bundle/src` outside the contracts entry.

### 2. Canonical backend primitives

Move `hasExactOwnKeys` into the canonical strict-JSON module and replace the
remaining backend-local copies.

Add `core/durable-fs.ts` with narrowly scoped mechanisms:

- `syncDirectory` and `syncDirectorySync`
- durable exclusive file creation
- durable same-directory file replacement
- durable no-replace publication
- pinned regular-file opening with no-follow and pathname/handle identity
  verification
- conditional unlink by expected file identity

Callers retain serialization, owner document parsing, process-liveness checks,
recovery decisions, domain error construction, and test hooks. This prevents a
generic abstraction from erasing meaningful policy differences between dev
locks, Playground locks, epoch publication, and eval storage.

### 3. Typed registration and lifecycle cleanup

Replace the thirteen Agent API handler `as never` casts with a typed tool
definition table or one generic registration helper that couples each schema
to its handler input. Remove `agentApiEnabledFromConfig`'s cast by reading the
already-normalized config type.

Add a small helper that converts labeled `Promise.allSettled` results into an
ordered list of close failures. Existing lifecycle methods continue wrapping
that list in their existing domain-specific error classes. This consolidates
mechanics without changing observable error identity.

### 4. Routing and workbench model ownership

Extract project status, rebuild, and project-event streaming from
`ForegroundServer` into a dedicated project-routes module matching the other
route groups.

Move pure Playground selectors from `playground-page.tsx` to
`playground-model.ts`. Move run observation and catalog-fetch lifecycle code to
a controller module. React components retain rendering and user interaction;
the model retains pure selection; the controller owns effects and transport.

### 5. Playground service decomposition

After durable filesystem primitives exist, extract persisted-session codecs,
index operations, and owner-lock persistence from `PlaygroundService` into a
focused persistence module. `PlaygroundService` remains the orchestration
authority for session lifecycle, subscriptions, operation admission, and
shutdown.

Module-global coordination maps move with the persistence/lease owner and gain
explicit lifecycle documentation. The extraction must bring
`playground-service.ts` below 1,000 lines without introducing pass-through
wrappers.

### 6. Decoder consolidation

Introduce a small internal decoder combinator only after the preceding
ownership changes settle. It will cover exact objects, strings, safe integers,
arrays, optional fields, and literal unions while accepting a caller-provided
error factory. Migrate one decoder family per commit, starting with the most
duplicated persisted-document decoders.

The helper must make each decoder shorter and preserve its domain-specific
error code. If a migration does not remove meaningful code, it will not be
performed.

## Error handling and compatibility

All persisted formats and error codes remain unchanged. Filesystem helpers
return or throw low-level errors with their original causes; callers translate
them at the existing domain boundary. Close operations preserve failure
ordering and domain error classes. Contract exports are additive.

Every migration is behavior-preserving and lands in a focused commit. No
consumer switches to a new abstraction until its existing behavior is covered
by a failing characterization or boundary test.

## Test strategy

Use test-driven development per slice:

1. Add a failing boundary or characterization test.
2. Verify it fails for the intended structural gap.
3. Apply the smallest extraction or type fix.
4. Run the affected tests and keep output clean.

Required coverage:

- package export and browser-safety tests for `workbench-contracts`
- strict-JSON hostile-input parity tests
- durability ordering, no-follow, identity, no-replace, cleanup, and Windows
  directory-fsync capability tests
- Agent API registration and schema tests without casts
- close-failure ordering and aggregate identity tests
- project route and SSE lifecycle tests
- Playground model/controller tests
- persisted Playground recovery and owner-race tests
- a final real-browser walkthrough of Overview, Skills, Hooks, MCP, Artifacts,
  Playground, Logs, Evals, and Comparisons

After each slice, run TraceDecay-selected affected tests. At completion, run
`npm run check && npm run check:release`, then native spot-check smokes where
the local host CLIs are available and authenticated.

## Incremental sequence

1. Contracts subpath and strict-JSON boundary.
2. Backend exact-key consolidation.
3. Durable filesystem primitives, one caller family at a time.
4. Agent API and normalized-config typing.
5. Close-failure collection.
6. Project routes.
7. Playground model/controller ownership.
8. Playground persistence decomposition.
9. Decoder consolidation.
10. Full verification and final browser walkthrough.

Already-resolved findings, such as the shared streaming writer and workbench
exact-key helper, receive verification only and no duplicate refactor.
