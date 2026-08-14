import { resolve } from 'node:path';

import { createJiti } from 'jiti';

import type {
  AgentBundleConfig,
  ConfigFactory,
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

const resolveConfigExport = (module: unknown): unknown => {
  if (typeof module !== 'object' || module === null || !('default' in module)) {
    return module;
  }

  return module.default;
};

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
  const jiti = createJiti(resolvedConfigPath);
  const exported = resolveConfigExport(await jiti.import(resolvedConfigPath));
  const config =
    typeof exported === 'function'
      ? await (exported as ConfigFactory)(context)
      : exported;

  if (!isConfig(config)) {
    throw new TypeError(
      `Expected ${resolvedConfigPath} to export an Agent Bundle configuration object or factory.`,
    );
  }

  return { config, configPath: resolvedConfigPath, context };
};
