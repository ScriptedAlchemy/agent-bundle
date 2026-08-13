# Agent Bundle design

**Status:** Approved architecture, implementation pending

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

## Non-goals for the first release

- migrating `rstackjs/agent-skills`;
- installing plugins into a user's agent host;
- operating a registry or marketplace;
- running a long-lived agent-bundle daemon;
- hiding all differences between hosts;
- inventing a portable standard for features that only one host supports;
- evaluating skill quality or model behavior;
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
}
```

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
  sessionEnd: './src/hooks/session-end.ts',
}
```

The initial normalized names are:

```ts
interface NormalizedHooks {
  sessionStart?: HookInput<SessionStartEvent>;
  sessionEnd?: HookInput<SessionEndEvent>;
  promptSubmit?: HookInput<PromptSubmitEvent>;
  beforeTool?: HookInput<BeforeToolEvent>;
  afterTool?: HookInput<AfterToolEvent>;
  permissionRequest?: HookInput<PermissionRequestEvent>;
  beforeCompact?: HookInput<BeforeCompactEvent>;
  afterCompact?: HookInput<AfterCompactEvent>;
  subagentStart?: HookInput<SubagentStartEvent>;
  subagentStop?: HookInput<SubagentStopEvent>;
  stop?: HookInput<StopEvent>;
}
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

For example, `beforeTool` maps to each host's `PreToolUse` event, while a normalized
`file.write` selector maps to the host's applicable tool names or aliases.

Identical native event names do not imply identical semantics. Adapters account for differences
in failure events, decisions, input replacement, context injection, matchers, asynchronous
execution, and supported handler types.

### Capability validation

Each target adapter publishes capabilities, including:

- supported lifecycle events;
- observation versus blocking behavior;
- input replacement;
- context injection;
- available matcher dimensions;
- synchronous or asynchronous execution;
- supported native handler types.

The compiler validates every normalized hook against every selected target. Unsupported exact
behavior is an error. An explicitly target-limited hook is emitted only for those targets.

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

### Host-specific hooks

Host-native escape hatches remain explicit:

```ts
export default defineConfig({
  hooks: {
    sessionStart: "./src/hooks/start.ts",
  },
  claude: {
    hooks: {
      FileChanged: "./src/hooks/file-changed.ts",
    },
  },
  codex: {
    hooks: {
      PostToolUse: {
        matcher: "^apply_patch$",
        handler: "./src/hooks/codex-edit.ts",
      },
    },
  },
});
```

These declarations still receive schema and artifact validation, but agent-bundle does not
claim they are portable.

## MCP servers

An MCP server may reference a prebuilt command or a TypeScript/JavaScript entry:

```ts
mcp: {
  servers: {
    project: {
      entry: './src/mcp/server.ts',
      transport: 'stdio',
      env: {
        CACHE_DIR: pathToken.pluginData,
      },
    },
  },
}
```

JavaScript entries are compiled into self-contained executables. Target adapters generate the
correct native MCP configuration and translate normalized path tokens such as plugin root,
plugin data, and workspace root into the host's supported syntax.

Remote HTTP MCP definitions are copied into native manifests without bundling a local server.
No MCP process is launched during `build` or `validate`.

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

Portable output follows the Agent Plugins and Agent Skills specifications. Host-specific
metadata remains in the corresponding adapter rather than leaking into the portable model.

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

Watches config, skills, scripts, MCP sources, hooks, and assets. It rebuilds only affected
targets and prints concise artifact changes. It does not attempt to restart every supported
agent host.

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

## Programmatic API

The package exports composition-friendly functions:

```ts
export { defineConfig } from "agent-bundle";
export { loadConfig, normalizeProject } from "agent-bundle/config";
export { build, validate, inspect } from "agent-bundle/api";
```

APIs accept an explicit project root, config path, targets, and logger. They return structured
results and diagnostics rather than writing process output directly.

## Package and repository tooling

The repository should use Rstack tools where practical:

- `rs lint` for source linting and type-aware diagnostics;
- `rs test` for unit, integration, fixture, and artifact tests;
- `rs lib`/Rslib for package output;
- Rspack through Rslib for executable bundling;
- Prettier and repository spelling checks for documentation.

The tool itself should remain usable outside Rstack repositories through its own executable
and JavaScript API.

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

## Release sequence

1. Core types, config loading, discovery, and diagnostics.
2. Portable adapter and skills-only artifact generation.
3. Rslib-backed executable bundling and build manifest.
4. Codex adapter.
5. Claude adapter.
6. Normalized hooks with compile-time host adapters.
7. MCP entry compilation and native configuration.
8. Dev watch, inspect UX, and clean-consumer verification.

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
10. The first release builds packages; it does not install, publish, deploy, or evaluate them.

## Open implementation questions

These can be resolved during planning without changing the architecture:

- whether the first package ships as one package or `core` plus target adapter packages;
- the exact mechanism for preserving executable modes in published archives;
- whether marketplace output belongs in each target directory or an optional sibling directory;
- which native JSON schemas are bundled versus downloaded or version-pinned;
- whether dev mode uses Rslib watch directly or a thin invalidation coordinator around it.

The preferred starting point is one package with internal adapters. Package splitting should
follow demonstrated independent versioning or dependency needs.
