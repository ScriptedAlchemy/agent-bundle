import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { loadConfig as loadRstackConfig } from '@rstackjs/load-config';
import { createJiti } from 'jiti';

import type {
  AgentBundleConfig,
  ConfigFactoryContext,
} from '../core/types.ts';

const defaultConfigFile = 'agent-bundle.config.ts';
const typeScriptConfigExtensions = new Set(['.cts', '.mts', '.ts']);

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

const defaultExport = (module: unknown): unknown =>
  module !== null &&
  (typeof module === 'function' || typeof module === 'object') &&
  'default' in module
    ? module.default
    : module;

const isConfigFactory = (
  value: unknown,
): value is (context: ConfigFactoryContext) => unknown | Promise<unknown> =>
  typeof value === 'function';

const loadTypeScriptConfig = async (
  configPath: string,
  context: ConfigFactoryContext,
): Promise<unknown> => {
  const jiti = createJiti(configPath, {
    fsCache: false,
    interopDefault: false,
    moduleCache: false,
  });
  const exportedConfig = defaultExport(await jiti.import(configPath));
  return isConfigFactory(exportedConfig)
    ? exportedConfig(context)
    : exportedConfig;
};

const assertInsideProjectRoot = (root: string, candidate: string): string => {
  const projectRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const projectRelative = relative(projectRoot, resolvedCandidate);
  if (
    projectRelative === '..' ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new RangeError(
      `Configuration path ${JSON.stringify(resolvedCandidate)} is outside project root ${JSON.stringify(projectRoot)}.`,
    );
  }
  return resolvedCandidate;
};

export const loadConfig = async ({
  root,
  configPath,
  command,
  mode,
  targets = [],
}: LoadConfigOptions): Promise<LoadedConfig> => {
  const projectRoot = resolve(root);
  const requestedConfigPath = assertInsideProjectRoot(
    projectRoot,
    resolve(projectRoot, configPath ?? defaultConfigFile),
  );
  const [realProjectRoot, resolvedConfigPath] = await Promise.all([
    realpath(projectRoot),
    realpath(requestedConfigPath),
  ]);
  assertInsideProjectRoot(realProjectRoot, resolvedConfigPath);
  const context: ConfigFactoryContext = {
    command,
    mode,
    projectRoot: realProjectRoot,
    selectedTargets: [...targets],
  };
  const config = typeScriptConfigExtensions.has(extname(resolvedConfigPath))
    ? await loadTypeScriptConfig(resolvedConfigPath, context)
    : (await loadRstackConfig<AgentBundleConfig, [ConfigFactoryContext]>({
      configParams: [context],
      fresh: true,
      loader: 'auto',
      path: resolvedConfigPath,
    })).content;

  if (!isConfig(config)) {
    throw new TypeError(
      `Expected ${resolvedConfigPath} to export an Agent Bundle configuration object or factory.`,
    );
  }

  return { config, configPath: resolvedConfigPath, context };
};
