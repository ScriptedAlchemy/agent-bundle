import type { EnvironmentConfig } from '@rsbuild/core';

export interface AgentBundlePluginConfig {
  description?: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export const canonicalHookEvents = Object.freeze(['sessionStart', 'beforeTool', 'afterTool', 'stop'] as const);

export type CanonicalHookEvent = (typeof canonicalHookEvents)[number];

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

export interface AgentBundleHookEntry {
  handler: string;
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
  entry?: string;
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
  /** Emit bundled type declarations next to the library output. Defaults to true. */
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
  plugin: AgentBundlePluginConfig;
  runtime?: AgentBundleRuntimeConfig;
  scripts?: Readonly<Record<string, AgentBundleScriptInput>>;
  skills?: string[];
  targets?: string[];
  tools?: AgentBundleToolsConfig;
  [key: string]: unknown;
}

export type ProvenanceKind = 'config' | 'conventional' | 'explicit';

export interface SourceProvenance {
  readonly kind: ProvenanceKind;
  readonly sourcePath: string;
}

export interface NormalizedMetadata {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
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
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly resources: readonly NormalizedSkillResource[];
  readonly source: string;
  readonly targets: readonly string[];
}

export interface NormalizedMcpServer {
  readonly args?: readonly string[];
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
  readonly source: string;
  readonly targets: readonly string[];
}

/** One normalized npm-facing CLI binary in the framework-owned package build. */
export interface NormalizedBinEntry {
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
  readonly event: CanonicalHookEvent;
  readonly id: string;
  readonly name: string;
  /** Host-native tools selected explicitly per target, alongside the canonical selectors. */
  readonly nativeTools?: readonly NativeHookToolSelector[];
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
  /** Native hook timeout in seconds. Omit it to use the selected host's default. */
  readonly timeout?: number;
  readonly tools: readonly CanonicalHookTool[];
}

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

export interface NormalizedPlugin {
  /**
   * Project-level copied assets. Normalizers always provide this collection;
   * it remains optional so hand-constructed models stay valid without assets.
   */
  readonly assets?: readonly NormalizedAsset[];
  readonly extensions: Readonly<Record<string, NormalizedConfigExtension>>;
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
  /** The generated-executable runtime floor selected during normalization. */
  readonly runtime: NormalizedRuntime;
  readonly scripts: readonly NormalizedScript[];
  readonly skills: readonly NormalizedSkill[];
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

export interface NormalizationTargetRegistry {
  configExtensions(): readonly NormalizationConfigExtension[];
  defaultTargetNames(): readonly string[];
  has(name: string): boolean;
  nativeHookSources?(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationNativeHookSource[];
  supports(name: string, capability: string): boolean;
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
