# Agent Bundle design

**Status:** Approved and implemented foundation; developer-workbench delivery is verified by the repository CI gates

**Date:** 2026-08-13

## Summary

`agent-bundle` is a build tool for producing AI-agent plugins. It should occupy the same
conceptual position that Rslib occupies for libraries and Rsbuild occupies for applications:
authors describe a product once, keep most source files in conventional locations, and receive
validated target artifacts.

The first release supports the plugin surfaces currently used by `rstackjs/agent-skills`:

- portable Agent Plugins metadata;
- Agent Skills, including scripts, references, and assets;
- MCP server definitions and bundled local MCP executables;
- Codex plugin metadata and lifecycle hooks;
- Claude Code plugin metadata and lifecycle hooks;
- Codex and Claude marketplace entries where requested;
- host-specific files through explicit extensions.

`rstackjs/agent-skills` is a reference fixture, not a migration target. It will remain an
independent repository.

## Goals

1. Generate native Codex, Claude Code, and portable plugin artifacts from one typed config.
2. Make the common case mostly convention-based while keeping explicit overrides available.
3. Compile TypeScript and JavaScript scripts, hooks, and MCP servers with Rslib/Rspack.
4. Copy non-JavaScript scripts and static skill resources without altering their semantics.
5. Validate source contracts and final target bundles before publication or installation.
6. Map normalized lifecycle hooks to each host at build time.
7. Emit self-contained artifacts with no `agent-bundle` runtime dependency.
8. Provide useful `build`, `dev`, `validate`, and `inspect` commands.
9. Expose a programmatic API so repositories and other build tools can compose the compiler.
10. Preserve escape hatches for host-native capabilities that have no portable equivalent.
11. Provide a real Rsbuild-powered development workbench for inspecting and exercising bundles.
12. Run reproducible plugin and skill evaluations through native Codex and Claude CLI harnesses.

## Non-goals for the first release

- migrating `rstackjs/agent-skills`;
- installing plugins into a user's agent host;
- operating a registry or marketplace;
- running a long-lived agent-bundle daemon;
- hiding all differences between hosts;
- inventing a portable standard for features that only one host supports;
- hosting a remote evaluation service;
- replacing a full source editor or IDE;
- claiming identical activation telemetry when a host does not expose it;
- deploying remote MCP services;
- requiring Turbo, Nx, or any particular monorepo orchestrator.

## Product principles

### Native output

Generated output should look like a carefully handwritten plugin. Hosts consume their own
native manifests and scripts; they never load an agent-bundle manifest at runtime.

### Compile away abstractions

Normalized concepts exist in source configuration and the compiler. Target bundles contain
only the host-specific result. Any necessary input or output adapter is inlined into the
generated script that uses it.

### Convention with explicit control

The compiler discovers standard directories by default, but config can add, remove, rename,
or specialize every component. Authors should not need a large config to package an ordinary
set of skills.

### Honest portability

The build must not silently weaken requested behavior. Exact mappings compile normally;
intentional degradation requires an explicit opt-in; unsupported guarantees produce a build
error.

### Artifact-first validation

Source validation catches mistakes early. Final artifact validation proves that generated
paths, manifests, commands, and copied resources are coherent after compilation.

## User experience

### Conventional project

```text
my-agent-plugin/
├── agent-bundle.config.ts
├── package.json
├── skills/
│   ├── review-change/
│   │   ├── SKILL.md
│   │   ├── scripts/
│   │   │   └── collect-diff.ts
│   │   ├── references/
│   │   └── assets/
│   └── debug-build/
│       └── SKILL.md
├── src/
│   ├── hooks/
│   │   ├── session-start.ts
│   │   └── check-command.ts
│   └── mcp/
│       └── server.ts
└── assets/
    └── logo.svg
```

Minimal configuration:

```ts
import { defineConfig } from "agent-bundle";

export default defineConfig({
  plugin: {
    name: "my-agent-plugin",
    version: "0.1.0",
    description: "Tools and workflows for My Project.",
  },
  targets: ["portable", "codex", "claude"],
  mcp: {
    servers: {
      project: {
        entry: "./src/mcp/server.ts",
      },
    },
  },
  hooks: {
    sessionStart: "./src/hooks/session-start.ts",
    beforeTool: [
      {
        tools: ["shell"],
        handler: "./src/hooks/check-command.ts",
      },
    ],
  },
});
```

Commands:

```bash
agent-bundle build
agent-bundle dev
agent-bundle validate
agent-bundle inspect
```

Projects using Rstack CLI may expose equivalent scripts through `rs` while the package keeps
the standalone `agent-bundle` executable usable in other repositories.

## Source configuration

The primary interface is `agent-bundle.config.ts`:

```ts
interface AgentBundleConfig {
  plugin: PluginMetadata;
  targets?: TargetName[];
  skills?: SkillInput[];
  mcp?: McpConfig;
  hooks?: NormalizedHooks;
  scripts?: ScriptInput[];
  assets?: AssetInput[];
  marketplaces?: MarketplaceConfig;
  output?: OutputConfig;
  validation?: ValidationConfig;
  codex?: CodexExtension;
  claude?: ClaudeExtension;
  portable?: PortableExtension;
  build?: BuildExtension;
  dev?: DevConfig;
  evals?: EvalConfig;
}
```

The `codex`, `claude`, and `portable` keys are contributed by the bundled target adapters
rather than being core config fields; a future adapter (for example `gemini`) contributes its
own extension key the same way, so the core interface never changes when a host is added.

The configuration loader returns an immutable normalized model. Target adapters receive that
model rather than the original user object.

Configuration may be synchronous or asynchronous. Environment-specific branching receives a
small typed context containing command, mode, project root, and selected targets.

## Normalized plugin model

The normalized model separates author intent from filesystem and host syntax:

```ts
interface NormalizedPlugin {
  metadata: NormalizedMetadata;
  targets: NormalizedTarget[];
  skills: NormalizedSkill[];
  scripts: NormalizedScript[];
  hooks: NormalizedHook[];
  mcpServers: NormalizedMcpServer[];
  assets: NormalizedAsset[];
  marketplaces: NormalizedMarketplace[];
  extensions: HostExtensions;
}
```

Each component has a stable internal ID, source location, selected targets, and provenance.
Diagnostics therefore point back to the author's config or source file instead of only naming
the generated file that failed.

## Skills and resources

By default, every `skills/*/SKILL.md` directory is a skill input. The complete directory is
preserved, subject to ignore rules. This includes:

- `SKILL.md`;
- `scripts/`;
- `references/`;
- `assets/`;
- `agents/` or other host files explicitly supported by a target adapter.

Markdown is not rewritten unless an opt-in transform requires it. Relative links and paths
are validated against the generated target layout.

TypeScript and JavaScript files in a skill's `scripts/` directory may be compiled into
self-contained executables. Shell and Python scripts are copied, retain their extension, and
receive executable permissions when appropriate. Static data is copied byte-for-byte.

Skill validation includes frontmatter, name-directory agreement, descriptions, referenced
resources, duplicate names, output path collisions, and target-specific restrictions.

Agent Bundle vendors a tested schema snapshot for each supported Agent Skills specification and
records its source revision in the build manifest. Adapter releases update that snapshot through
contract fixtures instead of accepting whichever schema happens to be online during a build.

Top-level `scripts` are named plugin utilities. JavaScript and TypeScript entries are bundled to
`<target>/scripts/<name>.mjs`; copied languages retain their extension. Skills, hooks, manifests,
and host extensions may reference those stable names without duplicating script inputs.

## Hook model

### Author-facing configuration

Hooks are configuration keys, not runtime framework objects:

```ts
hooks: {
  sessionStart: './src/hooks/session-start.ts',
  beforeTool: [
    {
      tools: ['shell'],
      handler: './src/hooks/check-command.ts',
    },
  ],
  afterTool: [
    {
      tools: ['shell', 'file.write'],
      handler: './src/hooks/record-result.ts',
    },
  ],
  stop: './src/hooks/on-stop.ts',
}
```

The initial portable names are deliberately small and must be confirmed by the phase-zero host
contract fixtures before release:

```ts
interface NormalizedHooks {
  sessionStart?: HookInput<SessionStartEvent>;
  beforeTool?: HookInput<BeforeToolEvent>;
  afterTool?: HookInput<AfterToolEvent>;
  stop?: HookInput<StopEvent>;
}
```

Handlers use a canonical compile-time contract:

```ts
type HookHandler<Event> = (
  event: Event,
  context: HookContext,
) => HookResult | void | Promise<HookResult | void>;

interface HookResult {
  outcome?: "continue" | "deny" | "stop";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}
```

Capability validation narrows the result fields available to each event and target. An
observation-only hook returns `void` or `outcome: "continue"`; a hook may not request input
replacement, denial, or context injection unless every explicitly selected target supports it.
These types describe author intent only and are compiled into native target protocols.

`HookInput` accepts the shorthand and explicit forms shown above interchangeably:

```ts
type HookInput<Event> = HookEntry<Event> | HookEntry<Event>[];

type HookEntry<Event> =
  | string // handler path with default options
  | {
      handler: string;
      tools?: ToolSelector[]; // beforeTool / afterTool only
      targets?: TargetName[]; // restrict this hook to specific targets
      timeout?: number;
    };
```

Normalized tool selectors cover common semantic categories such as `shell`, `file.read`,
`file.write`, `mcp`, and `agent`. Native tool names remain available through an explicit
host selector.

### Build-time mapping

Adapters map normalized names, selectors, inputs, and outputs to native contracts:

```text
Normalized source
      |
      +-- Codex adapter --> Codex hooks.json + bundled Codex hook scripts
      |
      `-- Claude adapter -> Claude hooks.json + bundled Claude hook scripts
```

For example, `beforeTool` maps to the selected adapter's current native pre-invocation event or
events, while a normalized `file.write` selector maps to that host's applicable tool names or
aliases. The compiler takes these names from the versioned adapter capability table rather than
assuming Codex and Claude use identical native identifiers.

Identical native event names do not imply identical semantics. Adapters account for differences
in failure events, decisions, input replacement, context injection, matchers, asynchronous
execution, and supported handler types.

Each adapter keeps typed capability data beside its implementation, including verified native
event names, selector mappings, input and output features, minimum supported host CLI version,
and the native schema revision. The adapter and table version together. Updating a host contract
requires updating its fixture and generated-artifact tests in the same change.

### Capability validation

Each target adapter publishes capabilities, including:

- supported lifecycle events;
- observation versus blocking behavior;
- input replacement;
- context injection;
- available matcher dimensions;
- synchronous or asynchronous execution;
- supported native handler types.

Selecting an output target does not imply that every component kind exists on that target. By
default, a component is emitted to the intersection of the selected outputs and adapters that
support its kind. `inspect` shows skipped target/component pairs. Explicitly targeting a
component at an adapter that lacks the kind is an error, as is requesting behavior that a capable
adapter would have to weaken. An explicitly target-limited hook is emitted only for those
targets.

Agent Plugins 1.0.0 deliberately excludes hooks, commands, and agents from the portable
format, so the `portable` adapter lacks the hook component kind entirely: under the
intersection rule above, normalized hooks simply fall out of portable output, and the minimal
example (hooks plus all three targets) builds. A host that supports hooks but cannot honor a
specific requested event, selector dimension, blocking decision, or handler type remains a
build error unless the hook is explicitly limited to capable targets.

Claude Code LSP emission is intentionally consumer-driven and host-scoped: `claude.lspServers`
passes through the registered Claude config extension and emits plugin-root `.lsp.json` for the
Claude target (and the Claude half of the composite plugin target). It does not introduce a
portable LSP component kind or imply support in Codex, Cursor, or Agent Plugins 1.0.0; that
cross-host source model remains deferred under #100.

### Zero runtime dependency

Generated hook bundles do not import `agent-bundle` and do not detect the host dynamically.
For a shared TypeScript hook, the compiler builds one self-contained entry per target and
inlines only the small adapter required for that host's stdin/stdout protocol.

```text
dist/
├── codex/hooks/
│   ├── hooks.json
│   ├── session-start.mjs
│   └── check-command.mjs
└── claude/hooks/
    ├── hooks.json
    ├── session-start.mjs
    └── check-command.mjs
```

There is no runtime framework, daemon, shared adapter package, or dependency on the
`agent-bundle` executable in the generated plugin.

Under the hood, each executable is its own Rslib library environment. Rslib receives a real packaged
entry anchor, while a lib-scoped Rspack `VirtualModulesPlugin` supplies the generated host wrapper that
imports the author's handler. This works with Rslib's entry validation, lets the built-in SWC pipeline
compile TypeScript and JavaScript, and avoids temporary generated source files. Chunk splitting and
async chunks are disabled for these environments, so every hook remains one self-contained `.mjs`
asset. Agent Bundle still owns resource discovery, schema validation, collision checks, executable
modes, manifest hashing, and atomic publication; those artifact semantics are intentionally not
delegated to bundler copy plugins or loaders.

### Host-specific hooks

Host-native escape hatches remain explicit:

```ts
export default defineConfig({
  hooks: {
    sessionStart: "./src/hooks/start.ts",
  },
  claude: {
    nativeHooks: "./src/claude/hooks.json",
  },
  codex: {
    nativeHooks: "./src/codex/hooks.json",
  },
});
```

Native hook files are target-specific inputs. They still receive schema and artifact validation,
and their referenced scripts can still be bundled, but Agent Bundle does not claim the native
events are portable.

## MCP servers

An MCP server may reference a prebuilt command or a TypeScript/JavaScript entry:

```ts
import { defineConfig, pathTokens } from "agent-bundle";

export default defineConfig({
  // ...
  mcp: {
    servers: {
      project: {
        entry: "./src/mcp/server.ts",
        transport: "stdio",
        env: {
          CACHE_DIR: pathTokens.pluginData,
        },
      },
    },
  },
});
```

JavaScript entries are compiled into self-contained executables. Target adapters generate the
correct native MCP configuration and translate normalized path tokens such as plugin root,
plugin data, and workspace root into the host's supported syntax.

The default generated runtime target is Node.js 22.12 or newer. A project may raise the floor,
and the selected floor is written to artifact metadata. A native addon or other runtime
dependency that cannot be bundled is a build error in the first release; authors can instead
reference an explicitly prebuilt command through the existing MCP/script input escape hatch.

`pathTokens` is exported from the main package and produces opaque token strings that the
compiler resolves per target at build time. Token availability is a per-target and per-component
capability. Claude resolves `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and
`${CLAUDE_PROJECT_DIR}` in its documented MCP fields. Portable `mcp.json` (Agent Plugins 1.0.0)
resolves `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `args`, `env`, and `cwd`, but not in `command`.
Codex exposes `PLUGIN_ROOT` and `PLUGIN_DATA` to plugin hook processes, but Codex CLI 0.147.0's
native `.mcp.json` loader does not interpolate those variables; native Codex MCP output therefore
uses contained relative paths where possible and rejects token uses that cannot be represented
honestly. An unavailable token is a build error unless the server is limited to capable targets.
This is the honest-portability rule applied to paths.

Remote HTTP MCP definitions are copied into native manifests without bundling a local server.
No MCP process is launched during `build` or `validate`.

MCP Apps are the portable UI contract. They remain ordinary MCP tools and `ui://` resources, not a
separate server kind. New integrations use `_meta.ui.resourceUri`,
`text/html;profile=mcp-app`, and the `ui/*` JSON-RPC bridge over `postMessage`. The OpenAI
`_meta["openai/outputTemplate"]` field remains transparent author-owned protocol data, but Agent
Bundle neither synthesizes it nor uses it as the portable source of truth. Optional `window.openai`
features are capability-detected by the View; the compiler never branches on a host product name.
A tool must still return useful text or
structured data when its host cannot render the View, including terminal clients such as Codex and
Claude Code.

An optional MCP App declaration associates a local MCP server with a browser View entry and an
explicit, versioned `ui://` resource URI. Agent Bundle builds each View through the public Rsbuild
JavaScript API in browser mode before compiling the owning server. The production View is one
self-contained HTML document: scripts, styles, and imported static assets are inlined; split and
async chunks are disabled; filename hashing is disabled; and any unexpected additional output is
a build error. This uses Rsbuild's standard asset pipeline and React plugin when TSX is selected;
it does not run a nested compiler from a custom loader.

The resulting HTML, URI, MIME type, and declared resource metadata are exposed to the server entry
through a compiler-owned virtual module. Server code registers them directly with the current
split MCP v2 server API. Agent Bundle does not add the legacy monolithic SDK merely to call helper
functions that normalize deprecated metadata, and it does not parse registrations or rewrite tool
metadata. The generated server remains the protocol source of truth: the workbench
discovers the tool metadata, calls
`resources/read` for the exact `ui://` URI, and receives the same structured content and result
metadata as ChatGPT or Claude. The pinned MCP Apps SDK version and its provenance are recorded and
covered by compatibility fixtures rather than copied into private bridge or schema code.

## Build engine

Rslib is the JavaScript/TypeScript compilation engine. Agent-bundle owns the higher-level
product model and output assembly.

The initial implementation may provide an internal first-party Rslib plugin responsible for:

1. registering generated wrapper entries for hooks, scripts, and MCP servers;
2. producing deterministic ESM command artifacts;
3. tracking emitted filenames without reconstructing Rslib internals;
4. emitting or coordinating non-code manifests and copied assets;
5. running final target validation after compilation;
6. reporting output provenance back to the build manifest.

The Rslib plugin is an implementation detail initially. A public extension API should be added
only after real integrations demonstrate which hooks and model operations are stable.

The implementation should use public Rslib/Rsbuild plugin and JavaScript APIs. It should not
patch process globals, depend on private compiler objects, or reproduce Rslib's CLI parsing.

All shipped production outputs use stable, unhashed filenames. Rslib/Rsbuild/Rspack filename
hashing is disabled for the package, generated executables, and prebuilt workbench assets; content
integrity and rebuild identity remain represented by the compiler manifest's SHA-256 values rather
than being duplicated in filenames.

Rslib's CLI supports `--watch`, but Agent Bundle development observes more than the JavaScript
module graph: configuration, skill Markdown, references, copied assets, marketplace metadata,
and generated host manifests can all invalidate an artifact. The first implementation therefore
uses one Agent Bundle invalidation coordinator and invokes the public Rslib build API for each
coalesced artifact epoch. It must not embed an opaque `rslib --watch` subprocess whose lifecycle
and completion state cannot be correlated with the normalized model. A later implementation may
adopt a public incremental Rslib lifecycle when it can preserve the same epoch contract.

## Target adapters

Each target adapter implements a common compiler contract:

```ts
interface TargetAdapter {
  name: TargetName;
  capabilities: TargetCapabilities;
  validateModel(model: NormalizedPlugin): Diagnostic[];
  createEntries(model: NormalizedPlugin): GeneratedEntry[];
  emitManifests(context: EmitContext): Promise<EmittedFile[]>;
  validateArtifact(context: ArtifactContext): Promise<Diagnostic[]>;
}
```

Initial adapters:

- `portable`: root Agent Plugins `plugin.json`, portable `mcp.json`, and skills;
- `codex`: `.codex-plugin/plugin.json`, `.mcp.json`, hooks, skills, and marketplace metadata;
- `claude`: `.claude-plugin/plugin.json`, `.mcp.json`, hooks, skills, and marketplace metadata.

Portable output follows the Agent Plugins 1.0.0 and Agent Skills specifications (see
References). Generated portable manifests carry the spec's required `$schema` identifiers, and
`plugin.json` never contains inline component configuration — the spec fixes `skills/` and
`mcp.json` at the plugin root and reserves everything host-specific for reverse-domain
extension namespaces. Host-specific metadata remains in the corresponding adapter rather than
leaking into the portable model.

## Host extensibility

The adapter contract is the only host boundary. Compiler core, discovery, normalization, and
the build engine never branch on a target name; anything host-specific lives in an adapter's
capability table, schema snapshots, contract fixtures, and emit/validate implementations.

Adapters register in a target registry keyed by `TargetName`, and `targets` entries are
validated against that registry. Adding a host is therefore additive: one new adapter module
providing its capability table, vendored schema snapshot, fixtures, manifest emitter, artifact
validator, and config extension key — with no changes to the normalized model or to existing
adapters. The existing open question about one package versus `core` plus adapter packages is
a packaging decision on top of this registry, not a different architecture.

Portable output is the default growth path. Hosts that natively consume Agent Plugins 1.0
(ChatGPT, Codex CLI, Cursor, GitHub Copilot, VS Code, and Kiro at launch) are already served
by the `portable` target for skills and MCP; a dedicated adapter is justified only when a host
has native-only surfaces worth compiling to, as Codex and Claude do with hooks and marketplace
metadata. The nearest candidate is a `gemini` adapter: Gemini CLI packages MCP servers,
commands, hooks, and skills in its own `gemini-extension.json` layout, which is a different
manifest but the same adapter shape.

Artifact validation may additionally shell out to a host's own validator when one is installed
(`claude plugin validate`, `skills-ref validate`, the published Agent Plugins JSON schemas),
reporting its findings as diagnostics. The build never depends on an external validator being
present or correct — vendored schema snapshots remain authoritative, since host validators have
known gaps (Claude's currently validates marketplace manifests without descending into each
plugin's `plugin.json`).

## Output layout

The default multi-target output is explicit:

```text
dist/
├── portable/
├── codex/
├── claude/
└── agent-bundle.manifest.json
```

Each target directory is independently usable. A target can optionally emit to the root of its
own output directory for repositories that publish one host bundle per package.

`agent-bundle.manifest.json` is build metadata for authors and CI. Hosts do not consume it. It
records source inputs, generated files, selected targets, adapter versions, hashes, and
validation results.

Production `build` writes the documented `dist/` tree. Development attempts build in a staging
directory and publish successful, atomic snapshots under
`.agent-bundle/epochs/<epoch-id>/<target>/`; `dist/` is never used as mutable dev state. A failed
target fails the whole attempt, leaving the previous epoch active for every target.

### Distribution assumptions

The first release produces repository-distributable artifacts rather than installing them. A
Codex or Claude target includes the native plugin and optional marketplace metadata needed to
reference that target from a local or Git repository marketplace. Portable output is consumed as
an Agent Plugins directory or archive. Clean-consumer tests install each generated target through
the host's verified local path or marketplace flow, which proves the same artifact can be used
outside the source repository.

## Validation

Validation runs in four layers:

### Source validation

- config schema and required metadata;
- file existence and input glob resolution;
- skill frontmatter and resource references;
- duplicate component names and output collisions;
- script language and entry compatibility.

### Normalized-model validation

- cross-component references;
- normalized names and IDs;
- target selection;
- hook capability requirements;
- path-token availability;
- MCP transport compatibility.

### Target validation

- host manifest schemas;
- native event and matcher validity;
- supported handler types;
- required marketplace metadata;
- host path and command conventions.

### Artifact validation

- every manifest path resolves inside the generated target;
- every command references an emitted executable;
- skill resources and relative links resolve;
- no two inputs overwrite one output;
- generated JSON parses and satisfies the selected schema;
- bundled JavaScript imports successfully in a clean process;
- copied executable scripts retain the required mode;
- output hashes match the build manifest.

Diagnostics use stable codes and include target, source location, generated location when
available, explanation, and suggested recovery.

## CLI behavior

### `agent-bundle build`

Loads config, normalizes the project, validates capabilities, compiles executable entries,
emits target artifacts, validates final output, and writes the build manifest.

### `agent-bundle dev`

Starts a foreground development coordinator and the Rsbuild-built workbench. Agent Bundle ships
the prebuilt browser assets and serves them with project, artifact, MCP, hook, diagnostic, and eval
APIs plus live project events. Rsbuild's native HMR is used while developing Agent Bundle itself;
plugin authors do not recompile the workbench UI. The coordinator watches config, skills, scripts,
MCP sources, hooks, and assets, then publishes immutable artifact epochs only after a successful
Rslib-backed build and validation.

The command does not attempt to restart every supported agent host. Native host trials are
started explicitly from the workbench or `agent-bundle eval`.

### `agent-bundle validate`

Runs source and model validation. With `--artifact`, it also validates an existing output
directory without rebuilding it.

### `agent-bundle inspect`

Prints the normalized model and target mappings. Focused forms include:

```bash
agent-bundle inspect --hooks
agent-bundle inspect --skills
agent-bundle inspect --target codex
```

Hook inspection shows normalized event, native event, native matcher, capabilities used,
generated handler, and whether the mapping is exact or target-specific.

Additional development commands share the same application services:

```bash
agent-bundle mcp list
agent-bundle mcp invoke <server> <tool>
agent-bundle hooks list
agent-bundle hooks simulate <hook>
agent-bundle eval [suite-or-case]
agent-bundle eval compare <baseline> <candidate>
```

Standalone `mcp invoke` and `hooks simulate` commands build and validate a temporary current-source
epoch by default. `--artifact <manifest>` binds them to an existing, validated manifest instead.
They never select an ambient `dist/` directory by modification time.

The detailed workbench, renderer, MCP playground, and evaluation design is specified in
[`2026-08-14-agent-bundle-dev-workbench-design.md`](2026-08-14-agent-bundle-dev-workbench-design.md).

## Programmatic API

The package exports composition-friendly functions:

```ts
export { defineConfig } from "agent-bundle";
export { loadConfig, normalizeProject } from "agent-bundle/config";
export {
  build,
  validate,
  inspect,
  startDevServer,
  runEvals,
} from "agent-bundle/api";
```

APIs accept an explicit project root, config path, targets, and logger. They return structured
results and diagnostics rather than writing process output directly.

## Package and repository tooling

The repository should use Rstack tools where practical:

- `rs lint` for source linting and type-aware diagnostics;
- `rs test` for unit, integration, fixture, and artifact tests;
- `rs lib`/Rslib for package output;
- Rspack through Rslib for executable bundling;
- Rsbuild for the React workbench build and native HMR during Agent Bundle development;
- Rstest for compiler, adapter, workbench, and harness tests;
- one resident Rslint instance for affected-file diagnostics in development;
- Prettier and repository spelling checks for documentation.

The tool itself should remain usable outside Rstack repositories through its own executable
and JavaScript API. The Agent Bundle CLI requires Node.js 22.19 or newer, matching the tested
toolchain of its initial attributed MCP Inspector source snapshot. Generated plugin executables
retain their separately configured default target of Node.js 22.12 or newer.

## Testing strategy

### Unit tests

- config normalization;
- discovery and ignore behavior;
- skill/resource validation;
- hook event and tool-selector mappings;
- capability diagnostics;
- path-token translation;
- deterministic manifest generation.

### Adapter contract tests

Every adapter receives the same normalized fixtures and is checked against native schemas and
expected artifact trees.

### Integration fixtures

Fixtures cover:

- skills-only portable plugin;
- Codex and Claude plugin from one source;
- skill scripts in TypeScript, shell, and Python;
- local stdio MCP server;
- remote MCP definition;
- shared normalized hooks;
- host-only hooks;
- unsupported-capability failures;
- assets and relative references;
- multi-target output collisions;
- paths containing spaces.

### Clean-consumer tests

Pack or copy each generated target into an isolated directory without repository
`node_modules`. Verify manifests, import bundled JavaScript, run deterministic test hooks with
fixture input, and perform an MCP initialization handshake where applicable. This proves the
zero-runtime-dependency constraint.

### Reference-repository fixture

`rstackjs/agent-skills` may be checked out at a pinned revision in CI or represented by a small
license-compatible fixture. Agent-bundle must not rewrite or migrate the repository as part of
this project.

### Workbench and harness tests

- contributor workbench HMR, published prebuilt serving, live project events, and cleanup;
- rendered Skill Markdown, GFM, frontmatter, code blocks, and relative resources;
- MCP initialization, catalog inspection, invocation, restart, and error presentation;
- normalized hook simulation through the generated native wrapper;
- deterministic eval graders and clean fixture copies;
- native Codex and Claude harness preflight, initialization evidence, and trace normalization;
- baseline/candidate comparisons with multiple trials and unavailable telemetry represented
  honestly.

## Release sequence

1. Core types, config loading, discovery, and diagnostics.
2. Portable adapter and skills-only artifact generation.
3. Rslib-backed executable bundling and build manifest.
4. Codex adapter.
5. Claude adapter.
6. Normalized hooks with compile-time host adapters.
7. MCP entry compilation and native configuration.
8. Complete the workbench delivery phases in
   [`2026-08-14-agent-bundle-dev-workbench-design.md`](2026-08-14-agent-bundle-dev-workbench-design.md).

Each phase should leave a usable vertical slice rather than introducing unused framework
layers.

## Decisions

1. One typed source config produces multiple native targets.
2. Conventions reduce config but do not replace explicit inputs.
3. Portable Agent Plugins covers skills and MCP; host-only behavior remains in adapters.
4. Hook names and tool selectors are normalized in source configuration.
5. Hook mappings and protocol adapters are compiled into target-specific files.
6. Generated artifacts have no agent-bundle runtime dependency.
7. Rslib is the executable compilation engine; a small internal Rslib plugin is allowed.
8. Final artifacts receive the same level of validation as the source model.
9. Host-specific escape hatches are supported and clearly labeled non-portable.
10. Rsbuild powers the browser workbench; Rslib powers generated executable artifacts.
11. Dev mode is a foreground process with no daemon or global discovery service.
12. Evaluations use fresh fixture copies and native host CLIs; they do not publish or install
    into a user's normal host configuration.
13. Skill rendering uses structured frontmatter plus CommonMark/GFM Markdown and does not
    execute MDX.
14. Agent Bundle vendors an attributed, allowlisted MCP Inspector source snapshot behind an
    internal adapter. It does not iframe the standalone app, import unpublished npm paths, or make
    Inspector code the owner of plugin traces and eval records.

## Open implementation questions

These can be resolved during planning without changing the architecture:

- whether the first package ships as one package or `core` plus target adapter packages;
- the exact mechanism for preserving executable modes in published archives;
- whether marketplace output belongs in each target directory or an optional sibling directory;
- which initial native-CLI model aliases should appear in optional example eval configuration
  without making direct model-provider APIs part of the build contract.

Native host and portable JSON schemas are vendored as tested snapshots with their source
revisions recorded in the build manifest, per the schema-snapshot policy above; they are never
downloaded during a build.

The preferred starting point is one package with internal adapters. Package splitting should
follow demonstrated independent versioning or dependency needs.

## Prior art and positioning

Nothing in the current ecosystem occupies the compiler position this design targets:

- The [`skills` CLI](https://github.com/vercel-labs/skills) (`npx skills add owner/repo`)
  distributes and installs existing skills across hosts; it does not compile scripts, hooks,
  or MCP servers, and it has no typed source model.
- [compound-engineering-plugin](https://github.com/everyinc/compound-engineering-plugin)
  converts Claude Code plugins to other hosts, treating the Claude format as the source of
  truth; agent-bundle instead compiles from a host-neutral typed config so no host is
  privileged.
- Multi-harness collections such as [wshobson/agents](https://github.com/wshobson/agents) and
  `rstackjs/agent-skills` itself commit hand-maintained per-host registries and manifests —
  exactly the generated artifacts agent-bundle produces from one source.
- [MCP Bundles](https://github.com/modelcontextprotocol/mcpb) (`.mcpb`, formerly DXT) packages
  a single local MCP server as a zip for one-click install; it covers neither skills nor hooks
  and is a packaging format, not a build tool.

Agent-bundle's position mirrors Rslib's: authors keep a typed source model and conventional
files; the compiler produces validated native artifacts that look handwritten.

## References

Specifications the adapters target:

- [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification) — portable
  `plugin.json`, root `skills/` and `mcp.json`, reverse-domain extension namespaces. Hooks,
  commands, agents, rules, and LSP servers are explicitly outside the v1 portable format.
- [Agent Skills specification](https://agentskills.io/specification) — `SKILL.md` frontmatter
  (`name` and `description` required; `license`, `compatibility`, `metadata`, `allowed-tools`
  optional), name-directory agreement, `scripts/`/`references/`/`assets/` conventions, and the
  [skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) validator.
- [Claude Code plugins](https://code.claude.com/docs/en/plugins) and
  [hooks reference](https://code.claude.com/docs/en/hooks) — `.claude-plugin/plugin.json`,
  `hooks/hooks.json`, native event and matcher catalog, `${CLAUDE_PLUGIN_ROOT}` and
  `${CLAUDE_PLUGIN_DATA}` placeholders, handler types.
- [Codex plugins and hooks](https://developers.openai.com/codex/hooks) —
  `.codex-plugin/plugin.json`, root `.mcp.json`, plugin-bundled `hooks/hooks.json`, native
  event catalog, plugin environment variables.
- [rstackjs/agent-skills](https://github.com/rstackjs/agent-skills) — the reference fixture;
  its hand-maintained `.agents/`, `.claude-plugin/`, `.codex-plugin/`, and `.gemini/`
  directories illustrate the duplication this tool compiles away.

Host adoption and future adapter candidates:

- [Agent Plugins 1.0 in VS Code, Copilot CLI, and the Copilot app](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/)
  — portable-target reach beyond Codex and Claude at launch.
- [Gemini CLI extensions](https://google-gemini.github.io/gemini-cli/docs/extensions/) —
  `gemini-extension.json` packaging MCP servers, commands, hooks, and skills; the nearest
  candidate for a dedicated adapter.

Validators the artifact layer can integrate but must not depend on:

- [`skills-ref validate`](https://github.com/agentskills/agentskills/tree/main/skills-ref) —
  reference validator for `SKILL.md` frontmatter and naming.
- `claude plugin validate` — validates marketplace manifests today without descending into
  per-plugin `plugin.json`
  ([anthropics/claude-code#60725](https://github.com/anthropics/claude-code/issues/60725)),
  which is why vendored schema snapshots stay authoritative.
- [Agent Plugins JSON schemas](https://agent-plugins.org/specification) — published
  `plugin.schema.json` and `mcp.schema.json` for portable manifests.

The Rstack tooling and developer-workbench research links live in
[`2026-08-14-agent-bundle-dev-workbench-design.md`](2026-08-14-agent-bundle-dev-workbench-design.md).
