import type { EnvironmentConfig } from '@rsbuild/core';

import type {
  AgentEventFallbackMode,
  AgentEventRuntimeMode,
  CanonicalAgentEvent,
} from '../routes/public.ts';
import type { CompiledAgentRoute, CompiledCliCommand, CompiledProvider } from '../routes/types.ts';
import type { SkillHostDocument, SkillIr, SkillTreeLayoutDecision } from '../skills/ir.ts';
import type { CapabilityState } from './capabilities.ts';

export interface AgentBundlePluginConfig {
  description?: string;
  /** Project-relative path to a logo image copied into host artifacts that support it. */
  logo?: string;
  name: string;
  /**
   * The host-facing declared version. Omit it to derive the version from the
   * project's `package.json` (issue #94 stage 3): package.json is
   * authoritative for release identity, and a declared value that disagrees
   * with it reports the AB4008 warning.
   *
   * @deprecated Declare the release version only in `package.json`. This
   * compatibility field will be removed through the normal breaking-change
   * policy.
   */
  version?: string;
  [key: string]: unknown;
}

export const canonicalHookEvents = Object.freeze([
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
  'agentStart',
  'agentStop',
  'workspaceOpen',
] as const);

export type CanonicalHookEvent = (typeof canonicalHookEvents)[number];

export const eventRouteOnlyHookEvents = Object.freeze([
  'sessionEnd',
  'promptSubmit',
] as const);

export type EventRouteOnlyHookEvent = (typeof eventRouteOnlyHookEvents)[number];
export type NormalizedHookEvent = CanonicalHookEvent | EventRouteOnlyHookEvent;

export const canonicalHookTools = Object.freeze(['shell', 'file.read', 'file.write', 'mcp', 'agent'] as const);

export type CanonicalHookTool = (typeof canonicalHookTools)[number];

/** A host-native tool named through the explicit `<target>:<native-name>` selector escape hatch. */
export interface NativeHookToolSelector {
  readonly name: string;
  readonly target: string;
}

/** Parses one `<target>:<native-name>` hook tool selector; canonical selectors return undefined. */
export const parseNativeHookToolSelector = (value: string): NativeHookToolSelector | undefined => {
  const separator = value.indexOf(':');
  if (separator === -1) return undefined;
  const target = value.slice(0, separator).trim();
  const name = value.slice(separator + 1).trim();
  return target.length === 0 || name.length === 0 ? undefined : { name, target };
};

/**
 * The prebuilt marker: names an already-built file the framework packages
 * as-is instead of compiling. The file must live inside a directory declared
 * in the top-level `payload` block; its artifact path is the payload
 * destination plus the file's payload-relative path, so consumer-pinned
 * stable paths survive packaging.
 */
export interface AgentBundlePrebuiltEntry {
  prebuilt: string;
}

/** True when a config entry value is the prebuilt marker object. */
export const isPrebuiltEntryInput = (value: unknown): value is AgentBundlePrebuiltEntry =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { readonly prebuilt?: unknown }).prebuilt === 'string';

export interface AgentBundleHookEntry {
  /** Extra command arguments. Only prebuilt handlers accept arguments. */
  args?: readonly string[];
  handler: string | AgentBundlePrebuiltEntry;
  targets?: readonly string[];
  /** Native hook timeout in seconds. Omit it to use the selected host's default. */
  timeout?: number;
  tools?: readonly string[];
}

export type McpTransport = 'stdio' | 'streamable-http';

export interface AgentBundleMcpApp {
  _meta?: Readonly<Record<string, unknown>>;
  entry: string;
  resourceUri: string;
  targets?: readonly string[];
  template?: string;
}

export interface AgentBundleMcpServer {
  apps?: Readonly<Record<string, AgentBundleMcpApp>>;
  args?: readonly string[];
  command?: string;
  cwd?: string;
  entry?: string | AgentBundlePrebuiltEntry;
  /**
   * Extra environment for stdio servers. Adapters inject the well-known
   * plugin-root anchor (see pluginRootEnvAnchor) beneath these entries, so a
   * declared key with that name wins over the injected value.
   */
  env?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  targets?: readonly string[];
  transport?: McpTransport;
  url?: string;
}

export interface AgentBundleMcpConfig {
  servers: Readonly<Record<string, AgentBundleMcpServer>>;
}

/** Optional artifact output location config, inspired by Rsbuild's `output.distPath`. */
export interface AgentBundleOutputConfig {
  /**
   * The artifact output directory of `agent-bundle build`, relative to the
   * project root. Defaults to `dist`. The per-invocation CLI `--output` flag
   * still wins, but remains subject to the same project-root containment
   * check; absolute and external output paths are unsupported.
   */
  distPath?: string;
}

export interface AgentBundleHostConfig {
  nativeHooks?: string;
}

/** Development-only settings that never become part of a built artifact. */
export interface AgentBundleDevConfig {
  /** Exposes the authenticated, loopback-only Agent API from `agent-bundle dev`. */
  agentApi?: boolean;
}

/** Runtime requirements for generated executable artifacts. */
export interface AgentBundleRuntimeConfig {
  /** Minimum supported Node.js version in `major.minor[.patch]` form. */
  node: string;
}

/** Adapter-owned config is contributed by declaration merging, not compiler core. */
// rslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merge extension point
export interface AgentBundleConfigExtensions {}

/** The portable adapter currently reserves an empty extension envelope. */
export interface AgentBundlePortableConfig {
  readonly [key: string]: unknown;
}

export interface AgentBundleScriptEntry {
  entry: string;
  targets?: readonly string[];
}

/** One declared prebuilt payload directory with an optional target restriction. */
export interface AgentBundlePayloadEntry {
  source: string;
  targets?: readonly string[];
}

export type AgentBundlePayloadInput = string | AgentBundlePayloadEntry;

/**
 * Prebuilt payload trees packaged byte-for-byte into selected target
 * artifacts. Key = artifact-root destination directory (a safe single path
 * segment outside the compiler-owned namespaces), value = the already-built
 * source directory. Every file keeps its exact relative path — payload trees
 * are opaque to the compiler, which cannot rewrite their internal sibling
 * references, so stable names are the correctness contract; integrity stays
 * content-addressed through the artifact manifest and project source inputs.
 */
export type AgentBundlePayloadConfig = Readonly<Record<string, AgentBundlePayloadInput>>;

/** One npm-facing CLI binary compiled into the framework-owned package build. */
export interface AgentBundleBinEntry {
  entry: string;
}

export type AgentBundleBinInput = string | AgentBundleBinEntry;

/**
 * npm-facing CLI binaries. Key = bin name, value = entry module. `false`
 * disables the `src/cli.ts` convention. Each entry becomes a self-executing
 * `dist/bin/<name>.js` bundle (shebang + executable bit) that `package.json`
 * `bin` can reference directly.
 */
export type AgentBundleBinConfig = false | Readonly<Record<string, AgentBundleBinInput>>;

/** The single-entry ESM+dts library profile of the framework-owned package build. */
export interface AgentBundleLibEntry {
  /**
   * Emit type declarations next to the library output — Rslib's bundleless
   * dts mode, a `.d.ts` graph beside the bundle rather than one rolled-up
   * file. Defaults to true.
   */
  dts?: boolean;
  entry: string;
}

/**
 * Optional npm library output. `false` disables the `src/index.ts`
 * convention. The profile is deliberately thin (one ESM entry, node target,
 * optional dts); packages needing a multi-format matrix have outgrown it and
 * should use Rslib directly.
 */
export type AgentBundleLibConfig = false | string | AgentBundleLibEntry;

/**
 * THE bundler escape hatch. Both fragments are merged last-but-bounded into
 * every bundler config agent-bundle synthesizes (artifact scripts, MCP
 * entries, hooks, MCP Apps, and the package build), mirroring Rslib's
 * user-config priority and Rspress's `builderConfig` position. The artifact
 * invariant assertions still run after the merge, so a hatch value that
 * breaks an artifact contract is a hard diagnostic, never a silent override.
 * Consumers never need a second bundler config file.
 *
 * Dual-engine reality: the hatch executes under two bundler engine copies.
 * Artifact scripts, MCP entries, hooks, and the package build compile
 * through Rslib and run under the Rsbuild/Rspack versions nested in
 * `@rslib/core` (currently the 2.1.x line); MCP App views compile through
 * the workspace-pinned `@rsbuild/core` (2.2.x). These types come from the
 * latter. Hatch authors must therefore never construct plugins or perform
 * `instanceof` checks against an imported `@rspack/core` — use the utils
 * argument Rslib/Rsbuild pass to `tools.rspack` mutator functions
 * (`(config, { rspack }) => ...`), which always hands the executing
 * engine's own `rspack` object.
 */
export interface AgentBundleToolsConfig {
  /** Rsbuild environment-config fragment merged after the synthesized profile. */
  rsbuild?: EnvironmentConfig;
  /** Rspack config fragment or mutator(s), Rslib `tools.rspack` semantics, applied after `rsbuild`. */
  rspack?: NonNullable<NonNullable<EnvironmentConfig['tools']>['rspack']>;
}

export type AgentBundleScriptInput = string | AgentBundleScriptEntry;

export type AgentBundleHookInput =
  | string
  | AgentBundleHookEntry
  | readonly (string | AgentBundleHookEntry)[];

/** False disables the conventional src/state.ts module. */
export type AgentBundleStateConfig = false;

export interface AgentBundleDevRuntimeConfig {
  readonly provider: string;
}

export interface AgentBundleDevConfig {
  readonly runtime?: AgentBundleDevRuntimeConfig;
}

export interface AgentBundleConfig extends AgentBundleConfigExtensions {
  /** Project-level static files copied byte-for-byte into every target artifact under `assets/`. */
  assets?: string[];
  bin?: AgentBundleBinConfig;
  dev?: AgentBundleDevConfig;
  hooks?: Partial<Record<CanonicalHookEvent, AgentBundleHookInput>>;
  lib?: AgentBundleLibConfig;
  marketplace?: boolean;
  mcp?: AgentBundleMcpConfig;
  output?: AgentBundleOutputConfig;
  payload?: AgentBundlePayloadConfig;
  plugin: AgentBundlePluginConfig;
  runtime?: AgentBundleRuntimeConfig;
  scripts?: Readonly<Record<string, AgentBundleScriptInput>>;
  skills?: string[];
  state?: AgentBundleStateConfig;
  targets?: string[];
  tools?: AgentBundleToolsConfig;
  [key: string]: unknown;
}

export type ProvenanceKind = 'config' | 'conventional' | 'explicit' | 'prebuilt';

export interface SourceProvenance {
  readonly kind: ProvenanceKind;
  readonly sourcePath: string;
}

export interface NormalizedPluginLogo {
  readonly bytes: number;
  /** Artifact-relative POSIX path written into host manifests that support logo. */
  readonly path: string;
  readonly source: string;
}

export interface NormalizedMetadata {
  readonly description?: string;
  readonly id: string;
  readonly logo?: NormalizedPluginLogo;
  readonly name: string;
  /** The validated npm package name derived from the project's package.json. */
  readonly packageName?: string;
  /** The validated semantic version derived from the project's package.json. */
  readonly packageVersion?: string;
  readonly provenance: SourceProvenance;
  readonly version: string;
}

export interface NormalizedTarget {
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
}

export interface NormalizedSkillResource {
  readonly bytes: number;
  readonly relativePath: string;
  readonly source: string;
}

/** One project-level static file copied byte-for-byte into selected target artifacts. */
export interface NormalizedAsset {
  readonly bytes: number;
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  /** The POSIX destination path under the artifact's `assets/` directory. */
  readonly relativePath: string;
  /** The absolute source file path. */
  readonly source: string;
  readonly targets: readonly string[];
}

export interface NormalizedSkill {
  readonly body: string;
  readonly description?: string;
  readonly dir: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /**
   * Per-host lowered Skill documents. The artifact planner emits these
   * instead of the authored bytes when `passThrough` is false.
   */
  readonly hostDocuments?: Readonly<Record<string, SkillHostDocument>>;
  readonly id: string;
  /**
   * The compiled SKILL.md document of a rendered skill (`SKILL.tsx`
   * convention). When present, adapters emit it as a generated write entry;
   * static skills ship their authored SKILL.md as a copied resource instead.
   */
  readonly markdown?: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly resources: readonly NormalizedSkillResource[];
  readonly skillIr?: SkillIr;
  readonly skillTreeLayout?: SkillTreeLayoutDecision;
  readonly source: string;
  readonly targets: readonly string[];
}

/** One conventional command prompt with peeled target selection. */
export interface NormalizedCommand {
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly id: string;
  /** Exact authored bytes decoded as UTF-8 for byte-faithful passthrough. */
  readonly markdown: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
}

/** One conventional Cursor `.mdc` rule with peeled target selection. */
export interface NormalizedRule {
  readonly body: string;
  /** Host-emitted document with authoring-only frontmatter keys stripped. */
  readonly emittedMarkdown: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly id: string;
  /** Exact authored bytes decoded as UTF-8; retained as an identity input. */
  readonly markdown: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
}

export interface NormalizedMcpServer {
  readonly args?: readonly string[];
  /** Filesystem routes compiled into this framework-generated server entry. */
  readonly generatedRoutes?: readonly CompiledAgentRoute[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  /** Absolute local source path for compiler-owned MCP entries only. */
  readonly source?: string;
  readonly targets: readonly string[];
  readonly transport: McpTransport;
  readonly url?: string;
}

export interface NormalizedMcpApp {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly name: string;
  /**
   * True when the owning server's prebuilt payload already contains the
   * served resource: the app stays a development surface and the compiler
   * emits no `mcp-apps/` output for it.
   */
  readonly prebuilt?: true;
  readonly provenance: SourceProvenance;
  readonly resourceUri: string;
  readonly serverId: string;
  readonly serverName: string;
  /** Absolute browser entry source path. */
  readonly source: string;
  readonly targets: readonly string[];
  /** Absolute optional HTML shell template path. */
  readonly template?: string;
}

export interface NormalizedScript {
  readonly id: string;
  readonly mode: 'bundle' | 'copy';
  readonly name: string;
  readonly provenance: SourceProvenance;
  /** True for a conventional rendered-script route (`src/scripts/<name>.tsx`) executed through the Agent renderer (#102 stage 3). */
  readonly rendered?: true;
  readonly source: string;
  readonly targets: readonly string[];
}

/** One normalized npm-facing CLI binary in the framework-owned package build. */
export interface NormalizedBinEntry {
  /** The compiled routed-CLI surface a framework-generated bin executes (#102 stage 2). */
  readonly generatedCli?: {
    readonly commands: readonly CompiledCliCommand[];
    readonly routes: readonly CompiledAgentRoute[];
  };
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
}

/** The normalized single-entry ESM+dts library output of the package build. */
export interface NormalizedLibEntry {
  readonly dts: boolean;
  readonly id: string;
  /** The output stem: `<name>.js` (+ `<name>.d.ts`) under the package output directory. */
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
}

/** The node-consumable package build agent-bundle owns alongside target artifacts. */
export interface NormalizedPackageBuild {
  readonly bins: readonly NormalizedBinEntry[];
  readonly lib?: NormalizedLibEntry;
  /** POSIX path of the package output directory relative to the project root. */
  readonly outputDir: string;
}

export interface NormalizedHook {
  /** Extra command arguments appended after the handler path; prebuilt hooks only. */
  readonly args?: readonly string[];
  readonly event: NormalizedHookEvent;
  /** Filesystem event-route execution metadata; absent for config-declared hook escape hatches. */
  readonly eventRoute?: Readonly<{
    readonly event: CanonicalAgentEvent;
    readonly fallback: AgentEventFallbackMode;
    readonly runtime: AgentEventRuntimeMode;
  }>;
  readonly id: string;
  readonly name: string;
  /** Host-native tools selected explicitly per target, alongside the canonical selectors. */
  readonly nativeTools?: readonly NativeHookToolSelector[];
  /**
   * Artifact-relative POSIX path of a prebuilt handler inside a declared
   * payload. Present only for prebuilt hooks: adapters point the native
   * command at this stable path instead of compiling a wrapper.
   */
  readonly prebuiltPath?: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
  /** Hook execution deadline in milliseconds. Omit it to use the selected host's default. */
  readonly timeoutMs?: number;
  readonly tools: readonly CanonicalHookTool[];
}

/** One file of a prebuilt payload directory, copied byte-for-byte. */
export interface NormalizedPayloadFile {
  readonly bytes: number;
  /** POSIX path relative to the payload source directory (and its artifact destination). */
  readonly relativePath: string;
  /** Absolute source file path. */
  readonly source: string;
}

/** One declared prebuilt payload directory packaged verbatim into target artifacts. */
export interface NormalizedPayload {
  readonly files: readonly NormalizedPayloadFile[];
  readonly id: string;
  /** The artifact-root destination directory name. */
  readonly name: string;
  readonly provenance: SourceProvenance;
  /** Absolute payload source directory. */
  readonly source: string;
  readonly targets: readonly string[];
}

/** One file enumerated from a host-native plugin executable directory. */
export interface NormalizedHostBinFile {
  readonly bytes: number;
  readonly executable: boolean;
  /** POSIX path relative to the declared host bin directory. */
  readonly relativePath: string;
  /** Absolute source file path. */
  readonly source: string;
}

/** One adapter-declared host-native plugin payload directory. */
export interface NormalizedHostPayloadDirectory {
  readonly files: readonly NormalizedHostBinFile[];
  readonly issue?: 'empty' | 'missing' | 'not-directory' | 'outside' | 'source-error' | 'source-invalid';
  readonly provenance: SourceProvenance;
  /** Absolute source directory path. */
  readonly source: string;
  readonly target: string;
}

/** One adapter-declared host-native plugin executable directory. */
export type NormalizedHostBin = NormalizedHostPayloadDirectory;

export interface NormalizedNativeHook {
  readonly document?: unknown;
  readonly issue?: 'missing' | 'parse' | 'source-error' | 'source-invalid';
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly target: string;
}

export interface NormalizedConfigExtension {
  readonly id: string;
  readonly key: string;
  readonly provenance: SourceProvenance;
  readonly target: string;
  readonly value: unknown;
}

/** The selected runtime floor for generated executables, written to artifact metadata. */
export interface NormalizedRuntime {
  readonly node: string;
}

/** Statically extracted conventional project state used by generated entry emitters. */
export type AgentStateBudgetName =
  | 'maxCommitMs'
  | 'maxEventBytes'
  | 'maxRevisions'
  | 'maxStateBytes';

export type NormalizedStateBudgets =
  | {
    readonly declared: Readonly<Partial<Record<AgentStateBudgetName, number>>>;
  }
  | 'dynamic';

export interface NormalizedStateDefinition {
  readonly budgets?: NormalizedStateBudgets;
  readonly id: string;
  readonly lifetime: 'request' | 'process' | 'workspace-durable';
  readonly provenance: SourceProvenance;
  readonly source: string;
}

export interface NormalizedPlugin {
  /**
   * Project-level copied assets. Normalizers always provide this collection;
   * it remains optional so hand-constructed models stay valid without assets.
   */
  readonly assets?: readonly NormalizedAsset[];
  /**
   * Conventional `src/commands/*.md` documents. Present only when commands are
   * discovered; optional so hand-constructed models predating commands remain valid.
   */
  readonly commands?: readonly NormalizedCommand[];
  readonly extensions: Readonly<Record<string, NormalizedConfigExtension>>;
  /** Adapter-declared host-native executable directories, enumerated during normalization. */
  readonly hostBins?: readonly NormalizedHostBin[];
  /** Adapter-declared host-native output-style directories, enumerated during normalization. */
  readonly hostOutputStyles?: readonly NormalizedHostPayloadDirectory[];
  /** Adapter-declared host-native workflow directories, enumerated during normalization. */
  readonly hostWorkflows?: readonly NormalizedHostPayloadDirectory[];
  readonly hooks: readonly NormalizedHook[];
  readonly marketplace?: true;
  readonly metadata: NormalizedMetadata;
  readonly mcpServers: readonly NormalizedMcpServer[];
  /**
   * Compiler-owned local MCP Apps. Normalizers always provide this collection;
   * it remains optional so pre-Apps consumers can continue to provide a
   * hand-constructed normalized model.
   */
  readonly mcpApps?: readonly NormalizedMcpApp[];
  readonly nativeHooks?: readonly NormalizedNativeHook[];
  /**
   * The framework-owned npm package build (bin + lib outputs). Present only
   * when configured or discovered by convention; optional so hand-constructed
   * models predating the package build stay valid.
   */
  readonly packageBuild?: NormalizedPackageBuild;
  /**
   * Declared prebuilt payload directories packaged verbatim. Present only
   * when the config declares a `payload` block; optional so hand-constructed
   * models predating prebuilt payloads stay valid.
   */
  readonly payloads?: readonly NormalizedPayload[];
  /** Conventional context providers executed for every generated render request. */
  readonly providers?: readonly CompiledProvider[];
  /**
   * Conventional `src/rules/*.mdc` documents. Present only when rules are
   * discovered; optional so hand-constructed models predating rules remain valid.
   */
  readonly rules?: readonly NormalizedRule[];
  /** The generated-executable runtime floor selected during normalization. */
  readonly runtime: NormalizedRuntime;
  readonly scripts: readonly NormalizedScript[];
  readonly skills: readonly NormalizedSkill[];
  readonly state?: NormalizedStateDefinition;
  readonly targets: readonly NormalizedTarget[];
}

export interface NormalizationConfigExtension {
  readonly key: string;
  readonly target: string;
}

export interface NormalizationNativeHookDocument {
  readonly source: string;
  readonly target: string;
}

export interface NormalizationNativeHookSourceError {
  readonly issue: 'error' | 'invalid';
  readonly target: string;
}

export type NormalizationNativeHookSource =
  | NormalizationNativeHookDocument
  | NormalizationNativeHookSourceError;

export interface NormalizationHostBinDocument {
  readonly source: string;
  readonly target: string;
}

export interface NormalizationHostBinSourceError {
  readonly issue: 'error' | 'invalid';
  readonly target: string;
}

export type NormalizationHostBinSource =
  | NormalizationHostBinDocument
  | NormalizationHostBinSourceError;

export type NormalizationHostPayloadSource = NormalizationHostBinSource;

export interface NormalizationTargetRegistry {
  binSources?(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostBinSource[];
  capabilityState?(name: string, capability: string): CapabilityState | undefined;
  configExtensions(): readonly NormalizationConfigExtension[];
  defaultTargetNames(): readonly string[];
  has(name: string): boolean;
  nativeHookSources?(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationNativeHookSource[];
  outputStyleSources?(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostPayloadSource[];
  supports(name: string, capability: string): boolean;
  workflowSources?(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostPayloadSource[];
}

export interface ConfigFactoryContext {
  command: string;
  mode: string;
  projectRoot: string;
  selectedTargets: readonly string[];
}

export type ConfigFactory = (
  context: ConfigFactoryContext,
) => AgentBundleConfig | Promise<AgentBundleConfig>;

export const defineConfig = (
  config: AgentBundleConfig | ConfigFactory,
): AgentBundleConfig | ConfigFactory => config;

export const pathTokens = Object.freeze({
  pluginRoot: 'agent-bundle:path:plugin-root',
  pluginData: 'agent-bundle:path:plugin-data',
  workspaceRoot: 'agent-bundle:path:workspace-root',
} as const);

/**
 * Well-known environment variable every adapter injects into emitted stdio
 * MCP server entries, holding the plugin install root in the target's native
 * representation (`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`,
 * `${CURSOR_PLUGIN_ROOT}`, or Codex's `./` resolved against the entry's
 * plugin-root cwd). Server runtime code should resolve persistent state and
 * bundled assets against it instead of the process working directory, which
 * not every host anchors to the plugin root. A user-declared env entry with
 * this key always wins over the injected value.
 */
export const pluginRootEnvAnchor = 'AGENT_BUNDLE_PLUGIN_ROOT';
