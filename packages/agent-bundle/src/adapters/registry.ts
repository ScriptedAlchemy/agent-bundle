import { dataArrayValues } from '../core/strict-json.ts';
import type {
  AgentBundleConfig,
  NormalizationConfigExtension,
  NormalizationNativeHookSource,
  NormalizationTargetRegistry,
} from '../core/types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { cursorAdapter } from './cursor.ts';
import { readStandardNativeHookCommands, type TargetHookContract } from './hook-contract.ts';
import { portableAdapter } from './portable.ts';
import { pluginAdapter } from './plugin.ts';
import type {
  TargetAdapter,
  TargetArtifactDocumentContract,
  TargetArtifactDocumentValidator,
  TargetArtifactLayout,
  TargetArtifactOutputLayout,
  TargetArtifactSchemaContract,
  TargetArtifactValidationContract,
  TargetAdapterMetadata,
  TargetSchemaDescriptor,
} from './types.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';

const sha256Pattern = /^[0-9a-f]{64}$/;
type NativeHookSource = NonNullable<TargetAdapter['nativeHookSource']>;

const emptyArtifactValidation: TargetArtifactValidationContract = Object.freeze({
  documents: Object.freeze([]),
  schemas: Object.freeze([]),
});

const emptyArtifactLayout: TargetArtifactLayout = Object.freeze({});

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

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined;
    return Object.fromEntries(Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.value]));
  } catch {
    // Hostile accessors or prototype traps never become adapter configuration.
    return undefined;
  }
};

const isArtifactDocumentValidator = (value: unknown): value is TargetArtifactDocumentValidator =>
  typeof value === 'function';

const snapshotSchema = (schema: unknown): TargetSchemaDescriptor => {
  const candidate = record(schema);
  if (candidate === undefined) {
    throw new Error('Target adapter metadata schemas must contain records.');
  }
  return Object.freeze({
    name: requireNonempty(candidate.name, 'schema name'),
    revision: requireNonempty(candidate.revision, 'schema revision'),
    sha256: requireSha256(candidate.sha256, 'schema hash'),
  });
};

const snapshotMetadata = (metadata: unknown): TargetAdapterMetadata => {
  const candidate = record(metadata);
  if (candidate === undefined) {
    throw new Error('Target adapter metadata is required.');
  }
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

const isSafeArtifactDocumentPath = (value: string): boolean => {
  const segments = value.split('/');
  return value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

const isSafeArtifactDirectory = (value: string): boolean =>
  isSafeArtifactDocumentPath(value) && !value.includes('/');

const artifactSuffixPattern = /^\.[a-z\d]+$/u;

const snapshotArtifactSuffixes = (value: unknown, field: string): readonly string[] => {
  const candidates = dataArrayValues(value);
  if (candidates === undefined) {
    throw new Error(`Target adapter artifact layout ${field} allowed suffixes must be a plain array.`);
  }
  if (candidates.length === 0) {
    throw new Error(`Target adapter artifact layout ${field} allowed suffixes must be a nonempty plain array.`);
  }

  const suffixes: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !artifactSuffixPattern.test(candidate)) {
      throw new Error(`Target adapter artifact layout ${field} allowed suffixes must contain canonical suffixes.`);
    }
    const previous = suffixes.at(-1);
    if (previous !== undefined && previous.localeCompare(candidate) >= 0) {
      throw new Error(`Target adapter artifact layout ${field} allowed suffixes must be unique and sorted.`);
    }
    suffixes.push(candidate);
  }
  return Object.freeze(suffixes);
};

const snapshotOutputLayout = (value: unknown, field: string): TargetArtifactOutputLayout => {
  const candidate = record(value);
  if (candidate === undefined) {
    throw new Error(`Target adapter artifact layout ${field} must be a record.`);
  }
  const directory = requireNonempty(candidate.directory, `artifact layout ${field} directory`);
  if (!isSafeArtifactDirectory(directory)) {
    throw new Error(`Target adapter artifact layout ${field} directory must be a safe single namespace.`);
  }
  return Object.freeze({
    allowedSuffixes: snapshotArtifactSuffixes(candidate.allowedSuffixes, field),
    directory,
  });
};

const snapshotRootDocuments = (value: unknown): readonly string[] => {
  const documents = dataArrayValues(value);
  if (documents === undefined) throw new Error('Target adapter artifact layout root documents must be a data array.');
  return Object.freeze(documents.map((document) => {
    const name = requireNonempty(document, 'artifact layout root document');
    if (!isSafeArtifactDirectory(name)) {
      throw new Error('Target adapter artifact layout root documents must be safe single-segment names.');
    }
    return name;
  }));
};

const snapshotArtifactLayout = (
  adapter: TargetAdapter,
  hookContract: TargetHookContract | undefined,
  mcpRuntime: TargetMcpRuntimeContract | undefined,
): TargetArtifactLayout => {
  const declaredLayout = adapter.artifactLayout;
  if (declaredLayout === undefined) return emptyArtifactLayout;
  const layout = record(declaredLayout);
  if (layout === undefined) throw new Error('Target adapter artifact layout must be a record.');

  const hookWrappers = layout.hookWrappers === undefined
    ? undefined
    : snapshotOutputLayout(layout.hookWrappers, 'hook wrappers');
  const mcpApps = layout.mcpApps === undefined ? undefined : snapshotOutputLayout(layout.mcpApps, 'MCP apps');
  const mcpEntries = layout.mcpEntries === undefined
    ? undefined
    : snapshotOutputLayout(layout.mcpEntries, 'MCP entries');
  const scripts = layout.scripts === undefined ? undefined : snapshotOutputLayout(layout.scripts, 'scripts');
  const assets = layout.assets === undefined
    ? undefined
    : requireNonempty(layout.assets, 'artifact layout assets namespace');
  const skills = layout.skills === undefined
    ? undefined
    : requireNonempty(layout.skills, 'artifact layout skills namespace');
  const rootDocuments = layout.rootDocuments === undefined ? undefined : snapshotRootDocuments(layout.rootDocuments);

  if (assets !== undefined && !isSafeArtifactDirectory(assets)) {
    throw new Error('Target adapter artifact layout assets namespace must be a safe single namespace.');
  }
  if (skills !== undefined && !isSafeArtifactDirectory(skills)) {
    throw new Error('Target adapter artifact layout skills namespace must be a safe single namespace.');
  }
  if (hookWrappers !== undefined && hookContract === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares hook wrapper layout without a hook contract.`);
  }
  if ((mcpApps !== undefined || mcpEntries !== undefined) && mcpRuntime === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares MCP output layout without an MCP runtime contract.`);
  }
  if (skills !== undefined && adapter.capabilities.skills !== true) {
    throw new Error(`Target adapter "${adapter.name}" declares Skill layout without skills capability.`);
  }
  return Object.freeze({
    ...(assets === undefined ? {} : { assets }),
    ...(hookWrappers === undefined ? {} : { hookWrappers }),
    ...(mcpApps === undefined ? {} : { mcpApps }),
    ...(mcpEntries === undefined ? {} : { mcpEntries }),
    ...(rootDocuments === undefined ? {} : { rootDocuments }),
    ...(scripts === undefined ? {} : { scripts }),
    ...(skills === undefined ? {} : { skills }),
  });
};

const snapshotArtifactValidation = (
  adapter: TargetAdapter,
  metadata: TargetAdapterMetadata,
): TargetArtifactValidationContract => {
  const declaredValidation = adapter.artifactValidation;
  if (declaredValidation === undefined) {
    if (metadata.schemas.length === 0) return emptyArtifactValidation;
    throw new Error(`Target adapter "${adapter.name}" must declare artifact validation for every metadata schema.`);
  }
  const validation = record(declaredValidation);
  if (validation === undefined ||
    !Array.isArray(validation.schemas) || !Array.isArray(validation.documents)) {
    throw new Error('Target adapter artifact validation must declare schema and document arrays.');
  }

  const schemaNames = new Set<string>();
  const schemas = validation.schemas.map((candidate): TargetArtifactSchemaContract => {
    const schema = record(candidate);
    if (schema === undefined) {
      throw new Error('Target adapter artifact schema contracts must contain records.');
    }
    const name = requireNonempty(schema.name, 'artifact schema contract name');
    if (schemaNames.has(name)) {
      throw new Error(`Target adapter artifact schema contract "${name}" is already declared.`);
    }
    if (!isArtifactDocumentValidator(schema.validate)) {
      throw new Error(`Target adapter artifact schema contract "${name}" must provide a validator.`);
    }
    schemaNames.add(name);
    return Object.freeze({ name, validate: schema.validate });
  });
  const metadataSchemaNames = new Set(metadata.schemas.map((schema) => schema.name));
  if (
    schemaNames.size !== metadataSchemaNames.size ||
    [...schemaNames].some((name) => !metadataSchemaNames.has(name))
  ) {
    throw new Error(`Target adapter "${adapter.name}" artifact schema contracts must exactly match metadata schemas.`);
  }

  const documentPaths = new Set<string>();
  const referencedSchemas = new Set<string>();
  const documents = validation.documents.map((candidate): TargetArtifactDocumentContract => {
    const document = record(candidate);
    if (document === undefined) {
      throw new Error('Target adapter artifact documents must contain records.');
    }
    const path = requireNonempty(document.path, 'artifact document path');
    if (!isSafeArtifactDocumentPath(path)) {
      throw new Error(`Target adapter artifact document path ${JSON.stringify(path)} must be a safe relative POSIX path.`);
    }
    if (documentPaths.has(path)) {
      throw new Error(`Target adapter artifact document path "${path}" is already declared.`);
    }
    const schema = requireNonempty(document.schema, 'artifact document schema');
    if (!schemaNames.has(schema)) {
      throw new Error(`Target adapter artifact document ${JSON.stringify(path)} references unknown schema "${schema}".`);
    }
    if (typeof document.required !== 'boolean') {
      throw new Error(`Target adapter artifact document ${JSON.stringify(path)} must declare whether it is required.`);
    }
    documentPaths.add(path);
    referencedSchemas.add(schema);
    return Object.freeze({ path, required: document.required, schema });
  });
  if (documents.length === 0 || !documents.some((document) => document.required)) {
    throw new Error(`Target adapter "${adapter.name}" must declare at least one required artifact document.`);
  }
  if ([...schemaNames].some((name) => !referencedSchemas.has(name))) {
    throw new Error(`Target adapter "${adapter.name}" must assign every artifact schema contract to a document.`);
  }
  return Object.freeze({
    documents: Object.freeze(documents.sort((left, right) => left.path.localeCompare(right.path))),
    schemas: Object.freeze(schemas.sort((left, right) => left.name.localeCompare(right.name))),
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
    readNativeCommands: hookContract.readNativeCommands ?? readStandardNativeHookCommands,
  });
};

const snapshotMcpRuntime = (adapter: TargetAdapter): TargetMcpRuntimeContract | undefined => {
  const mcpRuntime = adapter.mcpRuntime;
  if (adapter.capabilities.mcp === true && mcpRuntime === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares mcp capability without an MCP runtime contract.`);
  }
  if (adapter.capabilities.mcp !== true && mcpRuntime !== undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares an MCP runtime contract without mcp capability.`);
  }
  if (mcpRuntime === undefined) return undefined;
  if (typeof mcpRuntime.manifestPath !== 'string' || !isSafeArtifactDocumentPath(mcpRuntime.manifestPath)) {
    throw new Error('Target adapter MCP runtime manifest path must be a safe relative POSIX path.');
  }
  if (
    typeof mcpRuntime.readModernServers !== 'function' ||
    typeof mcpRuntime.resolveStdioArgument !== 'function' ||
    typeof mcpRuntime.resolveValue !== 'function'
  ) {
    throw new Error('Target adapter MCP runtime contract methods must be functions.');
  }
  return Object.freeze({
    manifestPath: mcpRuntime.manifestPath,
    readModernServers: mcpRuntime.readModernServers,
    resolveStdioArgument: mcpRuntime.resolveStdioArgument,
    resolveValue: mcpRuntime.resolveValue,
  });
};

export class TargetRegistry implements NormalizationTargetRegistry {
  readonly #adapters = new Map<string, TargetAdapter>();
  readonly #artifactLayouts = new Map<string, TargetArtifactLayout>();
  readonly #artifactValidations = new Map<string, TargetArtifactValidationContract>();
  readonly #defaults: string[] = [];
  readonly #extensions = new Map<string, NormalizationConfigExtension>();
  readonly #hookContracts = new Map<string, TargetHookContract>();
  readonly #metadata = new Map<string, TargetAdapterMetadata>();
  readonly #mcpRuntimes = new Map<string, TargetMcpRuntimeContract>();
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
    const artifactValidation = snapshotArtifactValidation(adapter, metadata);
    const nativeHookSource = snapshotNativeHookSource(adapter);
    const hookContract = snapshotHookContract(adapter);
    const mcpRuntime = snapshotMcpRuntime(adapter);
    const artifactLayout = snapshotArtifactLayout(adapter, hookContract, mcpRuntime);

    this.#adapters.set(adapter.name, adapter);
    this.#artifactValidations.set(adapter.name, artifactValidation);
    this.#artifactLayouts.set(adapter.name, artifactLayout);
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
    if (mcpRuntime !== undefined) {
      this.#mcpRuntimes.set(adapter.name, mcpRuntime);
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

  artifactValidation(name: string): TargetArtifactValidationContract {
    const validation = this.#artifactValidations.get(name);
    if (validation === undefined) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return validation;
  }

  artifactLayout(name: string): TargetArtifactLayout {
    const layout = this.#artifactLayouts.get(name);
    if (layout === undefined) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return layout;
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

  mcpRuntime(name: string): TargetMcpRuntimeContract | undefined {
    if (!this.#adapters.has(name)) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return this.#mcpRuntimes.get(name);
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
    .register(claudeAdapter)
    .register(cursorAdapter)
    .register(pluginAdapter);
