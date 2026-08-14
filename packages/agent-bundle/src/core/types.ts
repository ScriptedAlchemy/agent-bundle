export interface AgentBundlePluginConfig {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface AgentBundleConfig {
  plugin: AgentBundlePluginConfig;
  [key: string]: unknown;
}

export type ConfigFactory = () => AgentBundleConfig;

export const defineConfig = (
  config: AgentBundleConfig | ConfigFactory,
): AgentBundleConfig | ConfigFactory => config;

export const pathTokens = Object.freeze({
  pluginRoot: 'agent-bundle:path:plugin-root',
  pluginData: 'agent-bundle:path:plugin-data',
  workspaceRoot: 'agent-bundle:path:workspace-root',
} as const);
