import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { createJiti } from 'jiti';

import type { AgentBundleDevRuntimeConfig } from '../core/types.ts';
import type { DevRuntimeDescriptor } from './runtime-protocol.ts';
import type { DevRuntimeProvider } from './runtime-provider.ts';

type ProviderModule = Readonly<{ createDevRuntimeProvider?: unknown }>;

export type DevRuntimeModuleImporter = (path: string) => Promise<ProviderModule>;

const importProviderModule: DevRuntimeModuleImporter = async (path) => {
  const jiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: true });
  return jiti.import<ProviderModule>(path);
};

export class DevRuntimeProviderLoadError extends Error {
  readonly code = 'AB8200' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DevRuntimeProviderLoadError';
  }
}

const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length > 0 && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
};

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const descriptor = (value: unknown): DevRuntimeDescriptor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor must be an object.');
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  const label = record.label;
  const schemaVersion = record.schemaVersion;
  const environmentVariables = record.environmentVariables;
  if (!nonemptyString(id) || !nonemptyString(label) || schemaVersion !== 1 || !Array.isArray(environmentVariables)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor is invalid.');
  }
  if (
    environmentVariables.some((name) => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/u.test(name)) ||
    new Set(environmentVariables).size !== environmentVariables.length
  ) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor environment variable names are invalid.');
  }

  return Object.freeze({
    environmentVariables: Object.freeze([...environmentVariables]),
    id,
    label,
    schemaVersion: 1,
  });
};

const containedProviderPath = async (projectRoot: string, declaration: AgentBundleDevRuntimeConfig): Promise<string> => {
  if (!nonemptyString(declaration.provider)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider must be a nonempty project-relative module path.');
  }

  const lexicalRoot = resolve(projectRoot);
  const lexicalProvider = resolve(lexicalRoot, declaration.provider);
  if (!contained(lexicalRoot, lexicalProvider)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider must resolve inside the project root.');
  }

  let canonicalRoot: string;
  let canonicalProvider: string;
  try {
    [canonicalRoot, canonicalProvider] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalProvider),
    ]);
  } catch {
    throw new DevRuntimeProviderLoadError('Development runtime provider must name an existing regular file inside the project root.');
  }
  if (!contained(canonicalRoot, canonicalProvider)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider must resolve inside the project root.');
  }

  try {
    if (!(await stat(canonicalProvider)).isFile()) {
      throw new DevRuntimeProviderLoadError('Development runtime provider must name an existing regular file.');
    }
  } catch (error) {
    if (error instanceof DevRuntimeProviderLoadError) throw error;
    throw new DevRuntimeProviderLoadError('Development runtime provider must name an existing regular file.');
  }
  return canonicalProvider;
};

/** Loads the provider only after its lexical and canonical paths are contained by the project. */
export const resolveDevRuntimeProvider = async (
  projectRoot: string,
  declaration: AgentBundleDevRuntimeConfig,
  importer: DevRuntimeModuleImporter = importProviderModule,
): Promise<DevRuntimeProvider> => {
  const providerPath = await containedProviderPath(projectRoot, declaration);
  let loaded: ProviderModule;
  try {
    loaded = await importer(providerPath);
  } catch {
    throw new DevRuntimeProviderLoadError('Development runtime provider module could not be loaded.');
  }

  if (typeof loaded.createDevRuntimeProvider !== 'function') {
    throw new DevRuntimeProviderLoadError('Development runtime provider must export createDevRuntimeProvider.');
  }

  let candidate: unknown;
  try {
    candidate = await loaded.createDevRuntimeProvider();
  } catch {
    throw new DevRuntimeProviderLoadError('Development runtime provider factory failed.');
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider factory must return an object.');
  }

  const provider = candidate as Record<string, unknown>;
  let start: unknown;
  let frozenDescriptor: DevRuntimeDescriptor;
  try {
    start = provider.start;
    frozenDescriptor = descriptor(provider.descriptor);
  } catch (error) {
    if (error instanceof DevRuntimeProviderLoadError) throw error;
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor is invalid.');
  }
  if (typeof start !== 'function') {
    throw new DevRuntimeProviderLoadError('Development runtime provider must define a start method.');
  }
  return Object.freeze({
    descriptor: frozenDescriptor,
    start: start as DevRuntimeProvider['start'],
  });
};
