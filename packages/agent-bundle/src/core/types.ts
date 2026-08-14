export interface AgentBundlePluginConfig {
  description?: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export type CanonicalHookEvent = 'sessionStart' | 'beforeTool' | 'afterTool' | 'stop';

export type CanonicalHookTool = 'shell' | 'file.read' | 'file.write' | 'mcp' | 'agent';

export interface AgentBundleHookEntry {
  handler: string;
  targets?: readonly string[];
  /** Native hook timeout in seconds. Omit it to use the selected host's default. */
  timeout?: number;
  tools?: readonly string[];
}

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';

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

export type AgentBundleHookInput =
  | string
  | AgentBundleHookEntry
  | readonly (string | AgentBundleHookEntry)[];

export interface AgentBundleConfig {
  claude?: AgentBundleHostConfig;
  codex?: AgentBundleHostConfig;
  hooks?: Partial<Record<CanonicalHookEvent, AgentBundleHookInput>>;
  marketplace?: boolean;
  mcp?: AgentBundleMcpConfig;
  plugin: AgentBundlePluginConfig;
  skills?: string[];
  targets?: string[];
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
  readonly transport: 'stdio' | 'streamable-http' | 'sse';
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
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
}

export interface NormalizedHook {
  readonly event: CanonicalHookEvent;
  readonly id: string;
  readonly name: string;
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly targets: readonly string[];
  /** Native hook timeout in seconds. Omit it to use the selected host's default. */
  readonly timeout?: number;
  readonly tools: readonly CanonicalHookTool[];
}

export interface NormalizedNativeHook {
  readonly document?: unknown;
  readonly issue?: 'missing' | 'parse';
  readonly provenance: SourceProvenance;
  readonly source: string;
  readonly target: 'codex' | 'claude';
}

export interface NormalizedPlugin {
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
  readonly scripts: readonly NormalizedScript[];
  readonly skills: readonly NormalizedSkill[];
  readonly targets: readonly NormalizedTarget[];
}

export interface NormalizationTargetRegistry {
  defaultTargetNames(): readonly string[];
  has(name: string): boolean;
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
