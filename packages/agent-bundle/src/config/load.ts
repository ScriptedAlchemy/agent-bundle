import { resolve } from 'node:path';

import { loadConfig as loadRstackConfig } from '@rstackjs/load-config';

import type {
  AgentBundleConfig,
  ConfigFactoryContext,
} from '../core/types.ts';

const defaultConfigFile = 'agent-bundle.config.ts';

export interface LoadConfigOptions {
  command: string;
  configPath?: string;
  mode: string;
  root: string;
  targets?: readonly string[];
}

export interface LoadedConfig {
  config: AgentBundleConfig;
  configPath: string;
  context: ConfigFactoryContext;
}

const isConfig = (value: unknown): value is AgentBundleConfig =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const loadConfig = async ({
  root,
  configPath,
  command,
  mode,
  targets = [],
}: LoadConfigOptions): Promise<LoadedConfig> => {
  const projectRoot = resolve(root);
  const resolvedConfigPath = resolve(projectRoot, configPath ?? defaultConfigFile);
  const context: ConfigFactoryContext = {
    command,
    mode,
    projectRoot,
    selectedTargets: [...targets],
  };
  const { content: config } = await loadRstackConfig<
    AgentBundleConfig,
    [ConfigFactoryContext]
  >({
    configParams: [context],
    fresh: true,
    loader: 'auto',
    path: resolvedConfigPath,
  });

  if (!isConfig(config)) {
    throw new TypeError(
      `Expected ${resolvedConfigPath} to export an Agent Bundle configuration object or factory.`,
    );
  }

  return { config, configPath: resolvedConfigPath, context };
};
