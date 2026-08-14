# Agent Bundle Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the typed Agent Bundle compiler, portable/Codex/Claude adapters, artifact validation, command-line interface, and clean-consumer fixtures described by the approved compiler design.

**Architecture:** A single published `agent-bundle` package owns config loading, discovery, normalization, validation, target adapters, Rslib-backed executable compilation, and structured APIs. Host-specific behavior lives behind `TargetAdapter`; generated targets have no Agent Bundle runtime dependency. Tests exercise public behavior and generated artifacts from temporary fixture projects.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, npm workspaces, Rslib 0.23, Rstest 0.11, Rslint 0.8, Ajv 8, Jiti 2, fast-glob 3, YAML, Commander 15.

## Global Constraints

- The Agent Bundle CLI requires Node.js 22.19 or newer; emitted JavaScript defaults to Node.js 22.12 or newer.
- The published package is ESM and exports `agent-bundle`, `agent-bundle/config`, `agent-bundle/api`, and `agent-bundle/eval`.
- Builds never download schemas and never launch MCP servers.
- Generated hooks, scripts, and MCP entries are self-contained and do not import `agent-bundle`.
- Portable output follows the vendored Agent Plugins 1.0.0 and Agent Skills schema snapshots.
- Host-specific behavior exists only in adapters, capability tables, schemas, and contract fixtures.
- All filesystem paths passed to child processes use argument arrays; no shell-joined commands.
- Diagnostics have stable codes, severity, source location, target, explanation, and recovery text.
- Tests follow strict red-green-refactor and use real temporary directories instead of asserting on mocks.

---

## File Structure

```text
package.json                         # workspace scripts and pinned tool versions
package-lock.json                    # reproducible npm install
tsconfig.json                        # strict shared TypeScript settings
rslib.config.ts                      # published package build
rstest.config.ts                     # Node test project
rslint.config.ts                     # lint/type-check configuration
packages/agent-bundle/
├── package.json                     # exports, bin, files, engines
├── src/
│   ├── index.ts                     # defineConfig and pathTokens
│   ├── api.ts                       # build/validate/inspect exports
│   ├── cli.ts                       # executable command tree
│   ├── core/
│   │   ├── types.ts                 # source/normalized/result contracts
│   │   ├── diagnostics.ts           # diagnostic creation and failure policy
│   │   ├── digest.ts                # deterministic hashes and stable JSON
│   │   └── paths.ts                 # contained-path and output helpers
│   ├── config/
│   │   ├── index.ts                 # config subpath exports
│   │   ├── load.ts                  # async TS config loading
│   │   ├── discover.ts              # conventional component discovery
│   │   ├── skill.ts                 # frontmatter/resource parsing
│   │   └── normalize.ts             # immutable normalized model
│   ├── adapters/
│   │   ├── types.ts                 # TargetAdapter contract
│   │   ├── registry.ts              # additive adapter registry
│   │   ├── portable.ts              # portable manifests and tokens
│   │   ├── codex.ts                 # Codex manifests/hooks/marketplace
│   │   ├── claude.ts                # Claude manifests/hooks/marketplace
│   │   └── schemas/                  # vendored schema snapshots + provenance
│   ├── build/
│   │   ├── entries.ts               # generated wrapper entry sources
│   │   ├── rslib.ts                 # programmatic Rslib compilation
│   │   ├── emit.ts                  # manifests, skills, assets, modes
│   │   ├── validate-artifact.ts     # final tree checks
│   │   └── build.ts                 # atomic production build orchestration
│   └── services/
│       ├── hook-service.ts           # emitted wrapper simulation
│       └── mcp-service.ts            # epoch-bound MCP list/invoke
├── tests/
│   ├── config.test.ts
│   ├── normalization.test.ts
│   ├── adapters.test.ts
│   ├── build.test.ts
│   ├── hooks.test.ts
│   ├── mcp.test.ts
│   ├── cli.test.ts
│   └── helpers/project-fixture.ts
└── fixtures/contracts/              # checked-in host/schema contract inputs
fixtures/integration/                # source projects and expected artifact trees
```

### Task 1: Bootstrap the package and public configuration API

**Files:**
- Create: `package.json`, `tsconfig.json`, `rslib.config.ts`, `rstest.config.ts`, `rslint.config.ts`
- Create: `packages/agent-bundle/package.json`
- Create: `packages/agent-bundle/src/index.ts`
- Create: `packages/agent-bundle/src/core/types.ts`
- Test: `packages/agent-bundle/tests/public-api.test.ts`

**Interfaces:**
- Produces: `defineConfig(config: AgentBundleConfig | ConfigFactory): AgentBundleConfig | ConfigFactory`
- Produces: `pathTokens: { pluginRoot; pluginData; workspaceRoot }` using opaque `agent-bundle:path:*` strings

- [ ] **Step 1: Add workspace/tool configuration and install the pinned dependencies**

  Root scripts must expose `build`, `test`, `test:watch`, `lint`, `typecheck`, and `check`. Package exports must map the four public subpaths and the `agent-bundle` bin to Rslib output.

- [ ] **Step 2: Write the failing public API test**

```ts
it('preserves a synchronous config and exposes opaque path tokens', () => {
  const config = { plugin: { name: 'demo', version: '1.0.0' } };
  expect(defineConfig(config)).toBe(config);
  expect(pathTokens).toEqual({
    pluginRoot: 'agent-bundle:path:plugin-root',
    pluginData: 'agent-bundle:path:plugin-data',
    workspaceRoot: 'agent-bundle:path:workspace-root',
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails because the public module does not exist**

  Run: `npm test -- packages/agent-bundle/tests/public-api.test.ts`

- [ ] **Step 4: Implement the minimal types, `defineConfig`, and frozen `pathTokens` object**

- [ ] **Step 5: Run test, lint, and type-check**

  Run: `npm test -- packages/agent-bundle/tests/public-api.test.ts && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

  Run: `git add package.json package-lock.json tsconfig.json rslib.config.ts rstest.config.ts rslint.config.ts packages/agent-bundle && git commit -m "feat: bootstrap agent bundle package"`

### Task 2: Diagnostics, deterministic data, and safe path primitives

**Files:**
- Create: `packages/agent-bundle/src/core/diagnostics.ts`
- Create: `packages/agent-bundle/src/core/digest.ts`
- Create: `packages/agent-bundle/src/core/paths.ts`
- Test: `packages/agent-bundle/tests/core.test.ts`

**Interfaces:**
- Produces: `Diagnostic`, `DiagnosticBag`, `DiagnosticError`
- Produces: `stableJson(value): string`, `digest(value): string`, `assertInside(root, candidate): string`

- [ ] **Step 1: Write failing tests for stable key ordering, contained paths, and diagnostic failure summaries**

```ts
expect(stableJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
expect(() => assertInside('/tmp/out', '/tmp/outside/file')).toThrow(/outside output root/);
expect(new DiagnosticBag([error]).throwIfErrors).toThrow(DiagnosticError);
```

- [ ] **Step 2: Run the focused test and confirm all three missing behaviors fail**

- [ ] **Step 3: Implement recursive stable serialization, SHA-256 digests, lexical/real-path containment, and diagnostic aggregation**

- [ ] **Step 4: Run the focused test and full suite**

- [ ] **Step 5: Commit**

  Run: `git add packages/agent-bundle/src/core packages/agent-bundle/tests/core.test.ts && git commit -m "feat: add compiler core primitives"`

### Task 3: Load config, discover conventional inputs, and parse Skills

**Files:**
- Create: `packages/agent-bundle/src/config/index.ts`
- Create: `packages/agent-bundle/src/config/load.ts`
- Create: `packages/agent-bundle/src/config/discover.ts`
- Create: `packages/agent-bundle/src/config/skill.ts`
- Create: `packages/agent-bundle/tests/helpers/project-fixture.ts`
- Test: `packages/agent-bundle/tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig({ root, configPath, command, mode, targets }): Promise<LoadedConfig>`
- Produces: `discoverProject(root, config): Promise<DiscoveredProject>`
- Produces: `parseSkill(skillDir): Promise<SkillDocument>`

- [ ] **Step 1: Write a failing temporary-project test**

  The fixture contains an async `agent-bundle.config.ts`, `skills/review/SKILL.md`, a referenced image, an ignored log, and a TypeScript skill script. Assert resolved config context, parsed frontmatter/body, byte resources, source locations, and ignore behavior.

- [ ] **Step 2: Run the test and confirm config/discovery symbols are missing**

- [ ] **Step 3: Implement Jiti-based async config loading and conventional discovery with explicit config overrides**

- [ ] **Step 4: Implement YAML frontmatter/resource parsing without rewriting Markdown**

- [ ] **Step 5: Run the focused and full tests**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/config packages/agent-bundle/tests && git commit -m "feat: load and discover agent bundle projects"`

### Task 4: Normalize projects and validate source/model contracts

**Files:**
- Create: `packages/agent-bundle/src/config/normalize.ts`
- Create: `packages/agent-bundle/src/config/validate.ts`
- Test: `packages/agent-bundle/tests/normalization.test.ts`

**Interfaces:**
- Produces: `normalizeProject(loaded, discovered, registry): Promise<NormalizedPlugin>`
- Produces: `validateSource(...)` and `validateModel(...)` returning `Diagnostic[]`

- [ ] **Step 1: Write failing table tests for stable IDs, defaults, duplicate names, missing resources, collisions, unknown targets, and immutable output**

- [ ] **Step 2: Verify failures are caused by absent normalization**

- [ ] **Step 3: Implement normalization with provenance on every component and deep-freeze the result**

- [ ] **Step 4: Implement stable diagnostic codes for every tested invalid case**

- [ ] **Step 5: Run focused tests and mutation-check wrong target/collision branches**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/config packages/agent-bundle/tests/normalization.test.ts && git commit -m "feat: normalize and validate plugin models"`

### Task 5: Adapter registry and portable target

**Files:**
- Create: `packages/agent-bundle/src/adapters/types.ts`
- Create: `packages/agent-bundle/src/adapters/registry.ts`
- Create: `packages/agent-bundle/src/adapters/portable.ts`
- Create: `packages/agent-bundle/src/adapters/schemas/portable/*.json`
- Create: `packages/agent-bundle/src/adapters/schemas/portable/PROVENANCE.json`
- Test: `packages/agent-bundle/tests/portable-adapter.test.ts`

**Interfaces:**
- Produces: `TargetAdapter`, `TargetRegistry`, `createDefaultRegistry()`
- Portable adapter emits `plugin.json`, `mcp.json`, and complete skill directories.

- [ ] **Step 1: Check in the pinned Agent Plugins 1.0.0 schema snapshots and provenance hashes**

- [ ] **Step 2: Write failing tests for a skills-only artifact, portable MCP output, and token placement**

  Literal expectations must prove `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expand only in `args`, `env`, and `cwd`, while placing a token in `command` or using workspace root produces a diagnostic.

- [ ] **Step 3: Run the tests and confirm the adapter is absent**

- [ ] **Step 4: Implement the registry, portable capabilities, deterministic manifests, schema validation, and resource copy plan**

- [ ] **Step 5: Run focused tests, full tests, lint, and type-check**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/adapters packages/agent-bundle/tests/portable-adapter.test.ts && git commit -m "feat: add portable target adapter"`

### Task 6: Rslib executable compilation and production artifact pipeline

**Files:**
- Create: `packages/agent-bundle/src/build/entries.ts`
- Create: `packages/agent-bundle/src/build/rslib.ts`
- Create: `packages/agent-bundle/src/build/emit.ts`
- Create: `packages/agent-bundle/src/build/validate-artifact.ts`
- Create: `packages/agent-bundle/src/build/build.ts`
- Test: `packages/agent-bundle/tests/build.test.ts`

**Interfaces:**
- Produces: `compileEntries(entries, options): Promise<CompiledEntry[]>`
- Produces: `build(options): Promise<BuildResult>`
- Produces: `validateArtifact(context): Promise<Diagnostic[]>`

- [ ] **Step 1: Write a failing integration test that builds a TypeScript skill script from a path containing spaces**

  Assert `dist/portable/scripts/<name>.mjs` imports in a clean child process, the complete Skill tree is copied, hashes match `agent-bundle.manifest.json`, and a failed staged build leaves an existing `dist/` unchanged.

- [ ] **Step 2: Run the test and confirm no build pipeline exists**

- [ ] **Step 3: Implement generated entry sources and invoke `createRslib({ config })`, `rslib.build()`, and `close()`**

- [ ] **Step 4: Implement staged emission, artifact validation, deterministic manifest hashing, and atomic publication**

- [ ] **Step 5: Run the integration test twice and compare byte-for-byte output digests**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/build packages/agent-bundle/tests/build.test.ts && git commit -m "feat: build validated agent artifacts with Rslib"`

### Task 7: Codex and Claude target adapters

**Files:**
- Create: `packages/agent-bundle/src/adapters/codex.ts`
- Create: `packages/agent-bundle/src/adapters/claude.ts`
- Create: `packages/agent-bundle/src/adapters/capabilities/*.json`
- Create: `packages/agent-bundle/src/adapters/schemas/{codex,claude}/*`
- Create: `packages/agent-bundle/fixtures/contracts/{codex,claude}/*`
- Test: `packages/agent-bundle/tests/host-adapters.test.ts`

**Interfaces:**
- Extends: `TargetAdapter`
- Produces: native plugin, MCP, hooks, skills, and optional marketplace files.

- [ ] **Step 1: Capture CLI versions/help and checked-in capability fixtures for installed Codex and Claude Code**

- [ ] **Step 2: Write failing adapter contract tests using the same normalized fixture for both hosts**

  Assert exact native paths, path-token syntax, marketplace references, capability diagnostics, and schema-valid JSON.

- [ ] **Step 3: Implement versioned capability tables and the Codex adapter**

- [ ] **Step 4: Implement versioned capability tables and the Claude adapter**

- [ ] **Step 5: Run adapter tests and build a three-target fixture**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/adapters packages/agent-bundle/fixtures packages/agent-bundle/tests/host-adapters.test.ts && git commit -m "feat: add Codex and Claude adapters"`

### Task 8: Generated hook wrappers and simulation

**Files:**
- Modify: `packages/agent-bundle/src/build/entries.ts`
- Create: `packages/agent-bundle/src/services/hook-service.ts`
- Test: `packages/agent-bundle/tests/hooks.test.ts`

**Interfaces:**
- Produces: `HookService.list()`, `HookService.simulate({ artifact, target, hook, input })`

- [ ] **Step 1: Write failing round-trip tests for sessionStart, beforeTool denial, afterTool observation, and host-only native hooks**

- [ ] **Step 2: Verify the tests fail before wrapper generation exists**

- [ ] **Step 3: Generate one self-contained target wrapper per hook and map canonical/native stdin/stdout through adapter codecs**

- [ ] **Step 4: Implement simulation by spawning only the emitted wrapper from a validated artifact**

- [ ] **Step 5: Run hook tests in a clean directory without repository `node_modules`**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src packages/agent-bundle/tests/hooks.test.ts && git commit -m "feat: compile and simulate native hooks"`

### Task 9: MCP entry compilation and artifact-bound protocol operations

**Files:**
- Modify: `packages/agent-bundle/src/build/entries.ts`
- Create: `packages/agent-bundle/src/services/mcp-service.ts`
- Test: `packages/agent-bundle/tests/mcp.test.ts`

**Interfaces:**
- Produces: `McpService.list(artifact)` and `McpService.invoke({ artifact, target, server, tool, input })`

- [ ] **Step 1: Write a failing real-process test with a generated stdio server**

  Assert initialize, tools/list, tools/call, stderr capture, timeout, cancellation, remote HTTP config preservation, and that the selected manifest—not source—is executed.

- [ ] **Step 2: Run and observe the missing service failure**

- [ ] **Step 3: Compile local entries with Rslib and implement the MCP SDK client/session lifecycle**

- [ ] **Step 4: Add path-token expansion from the selected artifact and per-session plugin-data directory**

- [ ] **Step 5: Run focused tests and clean-consumer handshake**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src packages/agent-bundle/tests/mcp.test.ts && git commit -m "feat: compile and invoke MCP servers"`

### Task 10: Structured API and CLI commands

**Files:**
- Create: `packages/agent-bundle/src/api.ts`
- Create: `packages/agent-bundle/src/cli.ts`
- Modify: `packages/agent-bundle/src/config/index.ts`
- Test: `packages/agent-bundle/tests/cli.test.ts`

**Interfaces:**
- Produces: `build`, `validate`, `inspect`, `startDevServer`, `runEvals`
- Produces commands: `build`, `validate`, `inspect`, `mcp`, `hooks`, `eval`, `dev`

- [ ] **Step 1: Write failing process tests for `build`, JSON `inspect`, artifact `validate`, `mcp list/invoke`, and `hooks list/simulate`**

- [ ] **Step 2: Confirm commands fail because the executable is absent**

- [ ] **Step 3: Implement application APIs with explicit roots/loggers and Commander handlers that only decode/encode**

- [ ] **Step 4: Map diagnostics to stable JSON and human output with nonzero exit status on errors**

- [ ] **Step 5: Run CLI tests through the built package executable**

- [ ] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src packages/agent-bundle/tests/cli.test.ts && git commit -m "feat: expose agent bundle API and CLI"`

### Task 11: Full compiler fixture matrix and packed-consumer verification

**Files:**
- Create: `fixtures/integration/*`
- Create: `packages/agent-bundle/tests/integration.test.ts`
- Create: `packages/agent-bundle/tests/packed-consumer.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes all compiler public APIs and emitted formats.

- [ ] **Step 1: Add failing integration cases for every fixture named in the approved testing strategy**

  Include skills-only portable, dual-host, three script languages, local/remote MCP, shared/host hooks, unsupported capabilities, relative assets, collisions, and paths with spaces.

- [ ] **Step 2: Run the matrix and fix product behavior one failing case at a time**

- [ ] **Step 3: Pack `agent-bundle`, install it into a clean consumer, build all targets, import emitted JavaScript, simulate hooks, and perform MCP initialization**

- [ ] **Step 4: Document the implemented configuration, commands, outputs, and Node requirements with runnable examples**

- [ ] **Step 5: Run `npm run check`, package build, packed-consumer test, and `npm pack --dry-run`**

- [ ] **Step 6: Commit**

  Run: `git add fixtures packages/agent-bundle README.md && git commit -m "test: verify compiler end to end"`

---

## Compiler Completion Evidence

- `npm run check` passes with no warnings.
- Every adapter contract fixture matches a vendored schema and records provenance.
- Two identical builds produce identical hashes.
- A failed staged build preserves the prior output.
- Packed-consumer tests run with no repository `node_modules` access.
- Generated JavaScript contains no import of `agent-bundle`.
- All documented compiler/API/CLI commands have process-level tests.
