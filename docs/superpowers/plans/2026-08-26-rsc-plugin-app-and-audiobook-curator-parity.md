# RSC Plugin App and Audiobook Curator Parity Implementation Plan

> **Execution:** Follow test-driven development for each task. Commit every green boundary before beginning the next. Do not narrow the parity ledger when an optional external dependency is absent; implement and test its adapter, then record real acceptance as unsupported when appropriate.

**Goal:** Deliver the public RSC plugin-app framework and 100% Audiobook Curator behavioral parity through one shared CLI/MCP/host definition.

**Spec:** `docs/superpowers/specs/2026-08-26-rsc-plugin-app-and-audiobook-curator-parity-design.md`

## Task 1: Freeze the parity oracle

**Files:**
- Create `examples/audiobook-curator/docs/parity-ledger.md`
- Add focused contract fixtures under `examples/audiobook-curator/tests/fixtures/original-contract/`

- [ ] Record every original command, option, exit status, receipt, integration, and safety invariant.
- [ ] Link each row to a TypeScript source owner and automated or real acceptance evidence.
- [ ] Add a test that fails while any required row lacks an implementation/evidence owner.
- [ ] Commit `test(example): define audiobook curator parity contract`.

## Task 2: Add the public RSC plugin-app definition

**Files:**
- Create `packages/rsc-runtime/src/plugin-elements.ts`
- Create `packages/rsc-runtime/src/plugin-definition.ts`
- Create `packages/rsc-runtime/src/operation.ts`
- Create `packages/rsc-runtime/src/cli.ts`
- Create `packages/rsc-runtime/src/mcp-server.ts`
- Modify `packages/rsc-runtime/src/index.ts`, package metadata, README, and tests

- [ ] RED: valid TSX app lowers to exact Agent Bundle config and frozen operation registry.
- [ ] RED: duplicates, invalid nesting, decorated arrays, unsafe command/tool names, and config mutation fail closed.
- [ ] RED: one operation produces identical CLI and MCP inputs/results and shares caller cancellation.
- [ ] GREEN: implement the smallest public declarative tree and adapters.
- [ ] Verify package build/type declarations and commit `feat(rsc): define complete plugin applications`.

## Task 3: Move the curator onto the single app definition

**Files:**
- Create `examples/audiobook-curator/src/application.tsx`
- Replace manual config, MCP registration, CLI switch, and duplicated schemas

- [ ] RED: config, MCP names, CLI names, annotations, and handlers derive from one registry.
- [ ] GREEN: migrate the three existing operations without changing their behavior.
- [ ] Add root/per-command help and bundled script output.
- [ ] Commit `refactor(example): author curator as one RSC plugin app`.

## Task 4: Port receipts, process, media, and filesystem foundations

**Files:**
- Create domain modules for receipts, filesystem containment, ffprobe models, hashes, chapters, process capabilities, HTTP capabilities, and atomic writes.

- [ ] Port strict finite receipts and safe output/report path policy.
- [ ] Port regular-file/no-symlink reads and immutable-source policy.
- [ ] Port multi-stream ffprobe normalization and per-stream hashing.
- [ ] Port no-shell process execution, output bounds, caller cancellation, and no local deadlines.
- [ ] Port staged write/sync/verify/atomic promotion helpers.
- [ ] Commit `feat(curator): harden media operation foundations`.

## Task 5: Port inventory, library audit, and source selection

- [ ] RED/GREEN inventory strict/non-strict behavior and natural ordering.
- [ ] RED/GREEN bounded library concurrency and all finding types.
- [ ] RED/GREEN collision keys, quality ranking, part handling, and duration review.
- [ ] Expose all three through CLI and MCP with canonical receipts.
- [ ] Commit `feat(curator): port library analysis and selection`.

## Task 6: Port conversion engines

- [ ] RED/GREEN single M4B stream-copy identity.
- [ ] RED/GREEN multipart AAC conversion and chapter mapping.
- [ ] RED/GREEN ALAC, PCM chunking, bit-depth/layout/sample-rate constraints, and parallel output uniformity.
- [ ] RED/GREEN optional Audiobook Forge invocation.
- [ ] Verify staging, post-conversion facts, atomic publication, overwrite policy, and immutable sources.
- [ ] Commit `feat(curator): port audiobook conversion engines`.

## Task 7: Port Audible discovery and cache

- [ ] RED/GREEN all regions, normalization, scoring, strict evidence, sorting, and retained region failures.
- [ ] RED/GREEN explicit selection receipt.
- [ ] RED/GREEN product, chapter, cover, and source URL cache with byte/attempt bounds and atomic publication.
- [ ] Expose CLI/MCP operations and review-required outcomes.
- [ ] Commit `feat(curator): port Audible evidence workflows`.

## Task 8: Port metadata, artwork, and chapters

- [ ] RED/GREEN product metadata normalization and HTML stripping.
- [ ] RED/GREEN artwork and user overrides.
- [ ] RED/GREEN stream-copy mutation with audio/chapter/duration/language/metadata verification.
- [ ] RED/GREEN generic and Audible chapter normalization, continuity, bounds, and atomic replacement.
- [ ] Commit `feat(curator): port metadata and chapter repair`.

## Task 9: Port acoustic and Whisper verification

- [ ] Define explicit optional capability interfaces and probes.
- [ ] RED/GREEN Audible sample download and Audiolocate verify/identify behavior.
- [ ] RED/GREEN candidate dedupe/order/early-stop/all behavior.
- [ ] RED/GREEN distributed Whisper windows, PCM extraction, JSON transcript parsing, and evidence thresholds.
- [ ] Preserve inconclusive exit status 2 and human selection authority.
- [ ] Commit `feat(curator): port acoustic and transcript evidence`.

## Task 10: Port final audit and complete Skill/docs

- [ ] RED/GREEN structural chapter audit, expected source map, SHA-256, audio hashes, and full decode.
- [ ] Replace narrow Skill with complete workflow and optional capability guidance.
- [ ] Document CLI, MCP tools, receipts, external dependencies, installation, and the RSC authoring pattern.
- [ ] Commit `docs(example): document complete curator workflow`.

## Task 11: Host artifact and real-world acceptance

- [ ] Build and validate exact Claude and Codex artifacts.
- [ ] Assert both contain the same complete operation catalog, Skill, and bundled script with no hooks.
- [ ] Install both into isolated host homes and invoke their MCP catalogs and representative tools.
- [ ] Globally link/install the workspace CLI and verify help plus representative operations.
- [ ] Run read-only ZeroFS inventory/library-audit/select/audit.
- [ ] Produce one local-scratch derived conversion from approved source input, then verify metadata/chapters/audit without altering ZeroFS.
- [ ] Exercise Audible and optional recognition integrations when available; record explicit unsupported results otherwise.
- [ ] Commit `test(example): prove installed curator parity`.

## Task 12: Completion audit and delivery

- [ ] Run focused package/example tests, typecheck, lint, build, Agent Bundle validation, and affected repository gates.
- [ ] Audit every parity ledger row against current evidence.
- [ ] Fetch and integrate the latest PR2 branch; rerun affected gates.
- [ ] Confirm clean worktree, incremental commit history, and remote branch parity.
- [ ] Push `codex/rsc-agent-runtime-demo`.
- [ ] Mark the active goal complete only when every ledger row is proved.
