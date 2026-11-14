# Native OpenCode V2 Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit, validate, install, and natively load an OpenCode V2 2.2.6 plugin package through Agent Bundle's public target and lifecycle surfaces.

**Architecture:** A built-in adapter plans a relocatable `.opencode/plugins/<name>` package whose V2 `Plugin.define` setup registers MCP, skills, commands, and supported hooks. Existing compiled MCP/hook artifacts are reused; receipt-owned directory lifecycle and dev proxy generation attach the native package without changing user-owned config.

**Tech Stack:** TypeScript, Node 22.19+, Rstest, AJV, Effect 4.0.0, OpenCode V2 `@opencode/plugin@2.2.6`, Rspress en/zh docs.

**Spec:** `docs/superpowers/specs/2026-11-12-opencode-v2-target-design.md`

## Global Constraints

- Pin the host contract to OpenCode V2 `2.2.6` and exact `@opencode/plugin@2.2.6`; never use the legacy V1 API.
- Preserve AB6005/AB6039/AB7014/AB7015, fresh-dist enforcement, standalone MCP/hook executables, and unrelated work.
- Do not claim session/start, MCP App display, or other capabilities absent from the pinned V2 contract.
- Acceptance uses isolated home/config roots and never modifies the user's global OpenCode service/config.
- Update hand-written en and zh docs, add exactly one patch changeset, do not merge the PR.

## Review Focus

- Relocated package root/plugin-data/workspace-root resolution, tested by native MCP setup and packed installs.
- OpenCode's missing events rejected at plan/capability time rather than silently firing at setup, tested with session/start.
- Existing project/user `.opencode` content preserved across install/uninstall, tested with foreign files and receipts.
- External SDK declared and installed in a clean consumer, tested without workspace `node_modules`.
- Dev proxy rewriting updates the internal MCP table and not unrelated V2 config, tested by dev host sync.

---

### Task 1: Adapter registration, schemas, and native emission

**Files:**
- Create: `packages/agent-bundle/src/adapters/opencode.ts`
- Create: `packages/agent-bundle/src/adapters/capabilities/opencode-2.2.6.json`
- Create: `packages/agent-bundle/src/adapters/schemas/opencode/{config,package,mcp}.schema.json`
- Create: `packages/agent-bundle/src/adapters/schemas/opencode/PROVENANCE.json`
- Modify: `packages/agent-bundle/src/adapters/{registry,composite-layout,types}.ts`
- Test: `packages/agent-bundle/tests/opencode-adapter.test.ts`

**Interfaces:**
- Produces: `openCodeAdapter`, `openCodeArtifactPaths`, `OpenCodeHostConfig`, `OpenCodeConfigExtension`; V2 `opencode` target, documents/layout, and MCP runtime.

- [ ] Write failing tests for registry identity, V2 package/config entries, command/skill/MCP emission, remote/local MCP conversion, path tokens, target omissions, and schema validation.
- [ ] Run `pnpm exec rstest --config rstest.unit.config.ts packages/agent-bundle/tests/opencode-adapter.test.ts` and confirm missing-module/target failures.
- [ ] Implement the adapter, V2 setup source, capability evidence, schemas, registry, and public built-in unions.
- [ ] Rebuild and rerun the focused test green; confirm all new emission is registry-reachable.

### Task 2: V2 hook and event projection

**Files:**
- Modify: `packages/agent-bundle/src/adapters/hook-contract.ts`
- Modify: `packages/agent-bundle/src/events/projection.ts`
- Modify: `packages/agent-bundle/src/routes/events.ts`
- Modify: `packages/agent-bundle/src/adapters/hook-handler.ts`
- Test: `packages/agent-bundle/tests/opencode-adapter.test.ts`, `packages/agent-bundle/tests/event-payload.test.ts`, `packages/agent-bundle/tests/target-hook-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 `openCodeAdapter` and generated hook wrappers.
- Produces: OpenCode native event names/mappings and V2 callback changes for supported events only.

- [ ] Add failing tests for prompt/tool/stop registration, hook input rewrite/deny/output handling, session/start omission, and native payload identity/provenance.
- [ ] Run focused tests and confirm failures name the missing OpenCode mappings.
- [ ] Implement V2 envelope conversion and output application; keep unsupported context/event channels fail-closed.
- [ ] Rebuild and rerun focused tests green.

### Task 3: Public config, scaffolder, and manifest integration

**Files:**
- Modify: `packages/agent-bundle/src/{index.ts,config/index.ts,build/manifest.ts,config/normalize.ts,skills/tokens.ts,skills/lower.ts}`
- Modify: `packages/create-agent-bundle/src/options.ts`
- Test: `packages/agent-bundle/tests/{public-api,adapter-metadata,manifest-schema}.test.ts`, `packages/create-agent-bundle/tests/{host-catalog,scaffold}.test.ts`

**Interfaces:**
- Produces: `AgentBundleConfig & OpenCodeConfigExtension` and `TargetName 'opencode'` alongside existing targets.

- [ ] Write failing union/export/scaffolder/manifest assertions for the new host.
- [ ] Run focused tests and confirm compile/test failures.
- [ ] Add public unions/exports and host catalog behavior without inventing target config fields.
- [ ] Rebuild and rerun focused suites green.

### Task 4: Receipt-owned lifecycle and development install

**Files:**
- Create: `packages/agent-bundle/src/install/opencode.ts`
- Modify: `packages/agent-bundle/src/install/{identity,commands,install,uninstall,doctor,surface}.ts`
- Modify: `packages/agent-bundle/src/dev/{host-install-manager,dev-proxy-command}.ts`
- Modify: `packages/agent-bundle/src/contracts/mcp-session.ts`
- Test: `packages/agent-bundle/tests/{opencode-install,install-surface,dev-host-install-manager}.test.ts`

**Interfaces:**
- Consumes: Task 1 plugin package and internal MCP table.
- Produces: project/user `install|uninstall|doctor opencode`, package-bound lifecycle support, and `dev --install-host opencode`.

- [ ] Write failing tests for isolated project/user install, replacement/drift/foreign collision, uninstall plan/removal, doctor, and dev proxy.
- [ ] Run focused tests red, then implement directory lifecycle using existing receipt/inventory helpers.
- [ ] Verify repeated install/uninstall preserves unrelated `.opencode` and user config files.
- [ ] Rebuild and rerun lifecycle/dev suites green.

### Task 5: Meaningful native and packed-consumer acceptance

**Files:**
- Create: `packages/agent-bundle/tests/opencode-native.test.ts`
- Modify: `packages/agent-bundle/tests/{packed-consumer,packed-host-install-proof}.test.ts` or add focused packed proof files
- Modify: `rstest.integration-tests.ts` only if required for opt-in native V2 coverage

**Interfaces:**
- Consumes: Tasks 1–4 production output and installed CLI V2 2.2.6.
- Produces: reproducible evidence of host-facing plugin/config loading, skill/MCP registration, supported hooks, and package-bound installation in a clean packed consumer.

- [ ] Add failing integration fixtures using conventional movie-library-shaped MCP and skill components plus supported hook flows.
- [ ] Run integration tests to establish the missing target failure.
- [ ] Implement minimal fixes revealed by real `@opencode/cli --standalone` execution in isolated temporary roots; do not mock the host for acceptance.
- [ ] Add packed tarball/proof with workspace resolution and credentials removed, then run affected integration and packed suites green.

### Task 6: Bilingual docs, changeset, full gates, and PR

**Files:**
- Modify: matching pages under `website/docs/en/**` and `website/docs/zh/**`
- Create: `.changeset/<opencode-slug>.md`
- Modify: `packages/agent-bundle/package.json` description/keywords only if needed for public target accuracy

**Interfaces:**
- Produces: user-facing opt-in/install docs and one patch changeset naming each changed publishable package, ending `(#PR)` after the draft PR number exists.

- [ ] Document exact native files, supported/unsupported capabilities, config example, project/user lifecycle, isolated development flow, and movie-library opt-in without manual skill copying, in en and zh.
- [ ] Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit --pool.maxWorkers 4`, full integration pool, affected packed suites, and `pnpm docs:site:build`, in that order with fresh dist.
- [ ] Review the actual diff and repair attributable failures; add one patch changeset with no private package names or version/changelog edits.
- [ ] Commit and push `t3/opencode-v2-output-target`, create a draft PR with exact evidence/results/risks, link it through T3, and record immutable preview URLs when publication finishes or pending status honestly.
