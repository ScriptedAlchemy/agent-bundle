export interface AgentBundlePluginConfig {
  description?: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface AgentBundleConfig {
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

export interface NormalizedPlugin {
  readonly metadata: NormalizedMetadata;
  readonly skills: readonly NormalizedSkill[];
  readonly targets: readonly NormalizedTarget[];
}

export interface NormalizationTargetRegistry {
  defaultTargetNames(): readonly string[];
  has(name: string): boolean;
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
