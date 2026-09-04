import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { createJiti } from 'jiti';

import type { AgentBundleDevRuntimeConfig } from '../core/types.ts';
import type { DevRuntimeDescriptor } from './runtime-protocol.ts';
import type { DevRuntimeProvider } from './runtime-provider.ts';
import { YieldableFrameworkError } from '../effect/errors.ts';

type ProviderModule = Readonly<{ createDevRuntimeProvider?: unknown }>;

export type DevRuntimeModuleImporter = (path: string) => Promise<ProviderModule>;

const importProviderModule: DevRuntimeModuleImporter = async (path) => {
  const jiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: true });
  return jiti.import<ProviderModule>(path);
};

export class DevRuntimeProviderLoadError extends YieldableFrameworkError {
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

const environmentVariableNames = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor is invalid.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor environment variable names are invalid.');
  }
  const length = lengthDescriptor.value;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) {
      throw new DevRuntimeProviderLoadError('Development runtime provider descriptor environment variable names are invalid.');
    }
  }

  const names: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (entry === undefined || !entry.enumerable || !('value' in entry) || typeof entry.value !== 'string') {
      throw new DevRuntimeProviderLoadError('Development runtime provider descriptor environment variable names are invalid.');
    }
    names.push(entry.value);
  }
  if (
    names.some((name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor environment variable names are invalid.');
  }
  return Object.freeze(names);
};

const descriptor = (value: unknown): DevRuntimeDescriptor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor must be an object.');
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  const label = record.label;
  const schemaVersion = record.schemaVersion;
  const environmentVariables = record.environmentVariables;
  if (!nonemptyString(id) || !nonemptyString(label) || schemaVersion !== 1) {
    throw new DevRuntimeProviderLoadError('Development runtime provider descriptor is invalid.');
  }

  return Object.freeze({
    environmentVariables: environmentVariableNames(environmentVariables),
    id,
    label,
    schemaVersion: 1,
  });
};

const namedProviderFactory = (module: ProviderModule): (() => unknown) => {
  if (typeof module !== 'object' || module === null || Array.isArray(module)) {
    throw new DevRuntimeProviderLoadError('Development runtime provider must export createDevRuntimeProvider.');
  }
  const entry = Object.getOwnPropertyDescriptor(module, 'createDevRuntimeProvider');
  if (entry === undefined || !('value' in entry) || typeof entry.value !== 'function') {
    throw new DevRuntimeProviderLoadError('Development runtime provider must export createDevRuntimeProvider.');
  }
  return entry.value as () => unknown;
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

  let createProvider: () => unknown;
  try {
    createProvider = namedProviderFactory(loaded);
  } catch (error) {
    if (error instanceof DevRuntimeProviderLoadError) throw error;
    throw new DevRuntimeProviderLoadError('Development runtime provider must export createDevRuntimeProvider.');
  }
  let candidate: unknown;
  try {
    candidate = await Reflect.apply(createProvider, loaded, []);
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
    start: ((context) => Reflect.apply(start, candidate, [context])) as DevRuntimeProvider['start'],
  });
};
