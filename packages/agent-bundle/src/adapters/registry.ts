import type {
  AgentBundleConfig,
  NormalizationConfigExtension,
  NormalizationNativeHookSource,
  NormalizationTargetRegistry,
} from '../core/types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import type { TargetHookContract } from './hook-contract.ts';
import { portableAdapter } from './portable.ts';
import type { TargetAdapter, TargetAdapterMetadata, TargetSchemaDescriptor } from './types.ts';

const sha256Pattern = /^[0-9a-f]{64}$/;
type NativeHookSource = NonNullable<TargetAdapter['nativeHookSource']>;

const requireNonempty = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Target adapter metadata ${field} must be a nonempty string.`);
  }
  return value;
};

const requireSha256 = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error(`Target adapter metadata ${field} must be a lowercase SHA-256 hash.`);
  }
  return value;
};

const snapshotSchema = (schema: unknown): TargetSchemaDescriptor => {
  if (schema === null || typeof schema !== 'object') {
    throw new Error('Target adapter metadata schemas must contain records.');
  }
  const candidate = schema as Record<string, unknown>;
  return Object.freeze({
    name: requireNonempty(candidate.name, 'schema name'),
    revision: requireNonempty(candidate.revision, 'schema revision'),
    sha256: requireSha256(candidate.sha256, 'schema hash'),
  });
};

const snapshotMetadata = (metadata: unknown): TargetAdapterMetadata => {
  if (metadata === null || typeof metadata !== 'object') {
    throw new Error('Target adapter metadata is required.');
  }
  const candidate = metadata as Record<string, unknown>;
  if (!Array.isArray(candidate.schemas)) {
    throw new Error('Target adapter metadata schemas must be an array.');
  }
  const names = new Set<string>();
  const schemas = candidate.schemas.map((schema) => {
    const snapshot = snapshotSchema(schema);
    if (names.has(snapshot.name)) {
      throw new Error(`Target adapter metadata schema "${snapshot.name}" is already declared.`);
    }
    names.add(snapshot.name);
    return snapshot;
  });

  return Object.freeze({
    adapterRevision: requireNonempty(candidate.adapterRevision, 'adapter revision'),
    capabilityRevision: requireNonempty(candidate.capabilityRevision, 'capability revision'),
    capabilitySha256: requireSha256(candidate.capabilitySha256, 'capability hash'),
    observedVersion: requireNonempty(candidate.observedVersion, 'observed version'),
    schemas: Object.freeze(schemas),
  });
};

const snapshotNativeHookSource = (adapter: TargetAdapter): NativeHookSource | undefined => {
  const source = adapter.nativeHookSource;
  if (source !== undefined && typeof source !== 'function') {
    throw new Error('Target adapter native hook source must be a function.');
  }
  return source;
};

const snapshotHookContract = (adapter: TargetAdapter): TargetHookContract | undefined => {
  const hookContract = adapter.hookContract;
  if (adapter.capabilities.hooks === true && hookContract === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares hooks capability without a hook contract.`);
  }
  if (adapter.capabilities.hooks !== true && hookContract !== undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares a hook contract without hooks capability.`);
  }
  if (hookContract === undefined) return undefined;
  return Object.freeze({
    ...hookContract,
    eventNames: Object.freeze({ ...hookContract.eventNames }),
    matchers: Object.freeze({ ...hookContract.matchers }),
  });
};

export class TargetRegistry implements NormalizationTargetRegistry {
  readonly #adapters = new Map<string, TargetAdapter>();
  readonly #defaults: string[] = [];
  readonly #extensions = new Map<string, NormalizationConfigExtension>();
  readonly #hookContracts = new Map<string, TargetHookContract>();
  readonly #metadata = new Map<string, TargetAdapterMetadata>();
  readonly #nativeHookSources = new Map<string, NativeHookSource>();

  register(adapter: TargetAdapter, options: { readonly default?: boolean } = {}): this {
    if (this.#adapters.has(adapter.name)) {
      throw new Error(`Target adapter "${adapter.name}" is already registered.`);
    }
    const extension = adapter.configExtension;
    if (extension !== undefined && this.#extensions.has(extension.key)) {
      throw new Error(`Config extension key "${extension.key}" is already registered.`);
    }
    const metadata = snapshotMetadata(adapter.metadata);
    const nativeHookSource = snapshotNativeHookSource(adapter);
    const hookContract = snapshotHookContract(adapter);

    this.#adapters.set(adapter.name, adapter);
    this.#metadata.set(adapter.name, metadata);
    if (extension !== undefined) {
      this.#extensions.set(extension.key, Object.freeze({
        key: extension.key,
        target: adapter.name,
      }));
    }
    if (nativeHookSource !== undefined) {
      this.#nativeHookSources.set(adapter.name, nativeHookSource);
    }
    if (hookContract !== undefined) {
      this.#hookContracts.set(adapter.name, hookContract);
    }
    if (options.default === true) {
      this.#defaults.push(adapter.name);
    }

    return this;
  }

  get(name: string): TargetAdapter {
    const adapter = this.#adapters.get(name);
    if (adapter === undefined) {
      throw new Error(`Unknown target adapter "${name}".`);
    }

    return adapter;
  }

  metadata(name: string): TargetAdapterMetadata {
    const metadata = this.#metadata.get(name);
    if (metadata === undefined) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return metadata;
  }

  has(name: string): boolean {
    return this.#adapters.has(name);
  }

  hookContract(name: string): TargetHookContract | undefined {
    if (!this.#adapters.has(name)) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return this.#hookContracts.get(name);
  }

  configExtensions(): readonly NormalizationConfigExtension[] {
    return Object.freeze([...this.#extensions.values()]);
  }

  nativeHookSources(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationNativeHookSource[] {
    const sources: NormalizationNativeHookSource[] = [];
    for (const target of [...this.#nativeHookSources.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!targetNames.includes(target)) continue;
      const adapter = this.#adapters.get(target)!;
      try {
        const source = this.#nativeHookSources.get(target)!.call(adapter, config);
        if (typeof source === 'string' && source.trim().length > 0) {
          sources.push(Object.freeze({ source, target }));
        } else if (source !== undefined) {
          sources.push(Object.freeze({ issue: 'invalid', target }));
        }
      } catch {
        sources.push(Object.freeze({ issue: 'error', target }));
      }
    }
    return Object.freeze(sources);
  }

  supports(name: string, capability: string): boolean {
    return this.#adapters.get(name)?.capabilities[capability] === true;
  }

  names(): readonly string[] {
    return Object.freeze([...this.#adapters.keys()]);
  }

  defaultTargetNames(): readonly string[] {
    return Object.freeze([...this.#defaults]);
  }
}

export const createDefaultRegistry = (): TargetRegistry =>
  new TargetRegistry()
    .register(portableAdapter, { default: true })
    .register(codexAdapter)
    .register(claudeAdapter);
