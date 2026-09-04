import { CapabilityStateError, capabilityStateNames, isCapabilityState } from '../core/capabilities.ts';
import type { CapabilityState } from '../core/capabilities.ts';
import { dataArrayValues } from '../core/strict-json.ts';
import type {
  AgentBundleConfig,
  NormalizationConfigExtension,
  NormalizationHostBinSource,
  NormalizationHostPayloadSource,
  NormalizationNativeHookSource,
  NormalizationTargetRegistry,
} from '../core/types.ts';
import {
  capabilityIsSupported,
  cliBinCapability,
  noticeDeliveryAdvertisementFrom,
  type NoticeDeliveryCapabilityTableEntry,
} from './capability-state.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { cursorAdapter } from './cursor.ts';
import { readStandardNativeHookCommands, type TargetHookContract } from './hook-contract.ts';
import { portableAdapter } from './portable.ts';
import {
  routedCliBinLayout,
  type TargetAdapter,
  type TargetArtifactDocumentContract,
  type TargetArtifactDocumentValidator,
  type TargetArtifactLayout,
  type TargetArtifactOutputLayout,
  type TargetArtifactSchemaContract,
  type TargetArtifactValidationContract,
  type TargetAdapterMetadata,
  type TargetSchemaDescriptor,
} from './types.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { NoticeDeliveryAdvertisement } from './notice-delivery.ts';


const sha256Pattern = /^[0-9a-f]{64}$/;
type NativeHookSource = NonNullable<TargetAdapter['nativeHookSource']>;
type BinSource = NonNullable<TargetAdapter['binSource']>;
type OutputStylesSource = NonNullable<TargetAdapter['outputStylesSource']>;
type WorkflowsSource = NonNullable<TargetAdapter['workflowsSource']>;

const emptyArtifactValidation: TargetArtifactValidationContract = deepFreeze({
  documents: [],
  schemas: [],
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
  // A supported `cli` capability promises a home for the compiled routed CLI,
  // and the compiler emits it at exactly one place (`bin/<name>.mjs`), so the
  // promise is checked before any early return and against that fixed layout.
  // The judgment is the component one (`componentCapabilities ?? capabilities`)
  // because that is what decides emission; malformed declarations are
  // reported by the capability validators, not here.
  const componentCapabilities = adapter.componentCapabilities === undefined
    ? undefined
    : record(adapter.componentCapabilities);
  const cliJudgment = (componentCapabilities ?? adapter.capabilities)[cliBinCapability];
  const cliSupported = isCapabilityState(cliJudgment) && capabilityIsSupported(cliJudgment);
  const missingCliBinLayout = (): Error =>
    new Error(`Target adapter "${adapter.name}" declares a supported ${cliBinCapability} capability without a routed CLI bin layout.`);
  const declaredLayout = adapter.artifactLayout;
  if (declaredLayout === undefined) {
    if (cliSupported) throw missingCliBinLayout();
    return emptyArtifactLayout;
  }
  const layout = record(declaredLayout);
  if (layout === undefined) throw new Error('Target adapter artifact layout must be a record.');

  const cliBin = layout.cliBin === undefined ? undefined : snapshotOutputLayout(layout.cliBin, 'routed CLI bin');
  if (cliBin === undefined && cliSupported) throw missingCliBinLayout();
  if (
    cliBin !== undefined &&
    (cliBin.directory !== routedCliBinLayout.directory ||
      !routedCliBinLayout.allowedSuffixes.every((suffix) => cliBin.allowedSuffixes.includes(suffix)))
  ) {
    throw new Error(
      `Target adapter "${adapter.name}" routed CLI bin layout must use directory ${JSON.stringify(routedCliBinLayout.directory)} and admit ${routedCliBinLayout.allowedSuffixes.map((suffix) => JSON.stringify(suffix)).join(', ')}; the compiler emits the routed CLI only there.`,
    );
  }
  const commands = layout.commands === undefined ? undefined : snapshotOutputLayout(layout.commands, 'commands');
  const hookWrappers = layout.hookWrappers === undefined
    ? undefined
    : snapshotOutputLayout(layout.hookWrappers, 'hook wrappers');
  const mcpApps = layout.mcpApps === undefined ? undefined : snapshotOutputLayout(layout.mcpApps, 'MCP apps');
  const mcpEntries = layout.mcpEntries === undefined
    ? undefined
    : snapshotOutputLayout(layout.mcpEntries, 'MCP entries');
  const outputStyles = layout.outputStyles === undefined
    ? undefined
    : snapshotOutputLayout(layout.outputStyles, 'output styles');
  const rules = layout.rules === undefined ? undefined : snapshotOutputLayout(layout.rules, 'rules');
  const scripts = layout.scripts === undefined ? undefined : snapshotOutputLayout(layout.scripts, 'scripts');
  const assets = layout.assets === undefined
    ? undefined
    : requireNonempty(layout.assets, 'artifact layout assets namespace');
  const bin = layout.bin === undefined
    ? undefined
    : requireNonempty(layout.bin, 'artifact layout bin namespace');
  const skills = layout.skills === undefined
    ? undefined
    : requireNonempty(layout.skills, 'artifact layout skills namespace');
  const workflows = layout.workflows === undefined
    ? undefined
    : requireNonempty(layout.workflows, 'artifact layout workflows namespace');
  const rootDocuments = layout.rootDocuments === undefined ? undefined : snapshotRootDocuments(layout.rootDocuments);

  if (assets !== undefined && !isSafeArtifactDirectory(assets)) {
    throw new Error('Target adapter artifact layout assets namespace must be a safe single namespace.');
  }
  if (bin !== undefined && !isSafeArtifactDirectory(bin)) {
    throw new Error('Target adapter artifact layout bin namespace must be a safe single namespace.');
  }
  if (skills !== undefined && !isSafeArtifactDirectory(skills)) {
    throw new Error('Target adapter artifact layout skills namespace must be a safe single namespace.');
  }
  if (workflows !== undefined && !isSafeArtifactDirectory(workflows)) {
    throw new Error('Target adapter artifact layout workflows namespace must be a safe single namespace.');
  }
  if (hookWrappers !== undefined && hookContract === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares hook wrapper layout without a hook contract.`);
  }
  if ((mcpApps !== undefined || mcpEntries !== undefined) && mcpRuntime === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares MCP output layout without an MCP runtime contract.`);
  }
  if (skills !== undefined && !capabilityIsSupported(adapter.capabilities.skills)) {
    throw new Error(`Target adapter "${adapter.name}" declares Skill layout without skills capability.`);
  }
  return Object.freeze({
    ...(assets === undefined ? {} : { assets }),
    ...(bin === undefined ? {} : { bin }),
    ...(cliBin === undefined ? {} : { cliBin }),
    ...(commands === undefined ? {} : { commands }),
    ...(hookWrappers === undefined ? {} : { hookWrappers }),
    ...(mcpApps === undefined ? {} : { mcpApps }),
    ...(mcpEntries === undefined ? {} : { mcpEntries }),
    ...(outputStyles === undefined ? {} : { outputStyles }),
    ...(rootDocuments === undefined ? {} : { rootDocuments }),
    ...(rules === undefined ? {} : { rules }),
    ...(scripts === undefined ? {} : { scripts }),
    ...(skills === undefined ? {} : { skills }),
    ...(workflows === undefined ? {} : { workflows }),
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
  return deepFreeze({
    documents: documents.sort((left, right) => left.path.localeCompare(right.path)),
    schemas: schemas.sort((left, right) => left.name.localeCompare(right.name)),
  });
};

const snapshotNativeHookSource = (adapter: TargetAdapter): NativeHookSource | undefined => {
  const source = adapter.nativeHookSource;
  if (source !== undefined && typeof source !== 'function') {
    throw new Error('Target adapter native hook source must be a function.');
  }
  return source;
};

/**
 * The registry is the boundary where unchecked JavaScript adapters are
 * validated, so a malformed `lowersConfigExtensions` fails registration
 * instead of throwing later inside normalization.
 */
const snapshotLowersConfigExtensions = (adapter: TargetAdapter): readonly string[] => {
  const declared = adapter.lowersConfigExtensions;
  if (declared === undefined) return Object.freeze([]);
  if (!Array.isArray(declared) || declared.some((key) => typeof key !== 'string' || key.trim().length === 0)) {
    throw new Error(`Target adapter "${adapter.name}" lowersConfigExtensions must be an array of nonempty extension keys.`);
  }
  return Object.freeze([...new Set(declared)]);
};

const snapshotBinSource = (adapter: TargetAdapter): BinSource | undefined => {
  const source = adapter.binSource;
  if (source !== undefined && typeof source !== 'function') {
    throw new Error('Target adapter bin source must be a function.');
  }
  return source;
};

const snapshotOutputStylesSource = (adapter: TargetAdapter): OutputStylesSource | undefined => {
  const source = adapter.outputStylesSource;
  if (source !== undefined && typeof source !== 'function') {
    throw new Error('Target adapter output styles source must be a function.');
  }
  return source;
};

const snapshotWorkflowsSource = (adapter: TargetAdapter): WorkflowsSource | undefined => {
  const source = adapter.workflowsSource;
  if (source !== undefined && typeof source !== 'function') {
    throw new Error('Target adapter workflows source must be a function.');
  }
  return source;
};

const snapshotHookContract = (adapter: TargetAdapter): TargetHookContract | undefined => {
  const hookContract = adapter.hookContract;
  if (capabilityIsSupported(adapter.capabilities.hooks) && hookContract === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares hooks capability without a hook contract.`);
  }
  if (!capabilityIsSupported(adapter.capabilities.hooks) && hookContract !== undefined) {
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
  if (capabilityIsSupported(adapter.capabilities.mcp) && mcpRuntime === undefined) {
    throw new Error(`Target adapter "${adapter.name}" declares mcp capability without an MCP runtime contract.`);
  }
  if (!capabilityIsSupported(adapter.capabilities.mcp) && mcpRuntime !== undefined) {
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

/**
 * Re-validates a declared notice delivery advertisement at the registry
 * boundary so a JavaScript adapter cannot smuggle an unknown route state into
 * the generated MCP entry's route selection.
 */
const snapshotNoticeDelivery = (adapter: TargetAdapter): NoticeDeliveryAdvertisement | undefined => {
  const declared = adapter.noticeDelivery;
  if (declared === undefined) return undefined;
  const rows = record(declared);
  if (rows === undefined) {
    throw new CapabilityStateError(
      `Target adapter "${adapter.name}" must declare notice delivery advertisements as a record.`,
    );
  }
  const entries = Object.fromEntries(Object.entries(rows).map(([route, entry]): [string, NoticeDeliveryCapabilityTableEntry] => {
    const row = record(entry);
    if (row === undefined || typeof row.state !== 'string') {
      throw new CapabilityStateError(
        `Target adapter "${adapter.name}" notice delivery route "${route}" must declare a state.`,
      );
    }
    return [route, {
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      ...(typeof row.sensitivity === 'string' ? { sensitivity: row.sensitivity } : {}),
      ...(typeof row.sensitivityEvidence === 'string' ? { sensitivityEvidence: row.sensitivityEvidence } : {}),
      state: row.state,
    }];
  }));
  return noticeDeliveryAdvertisementFrom(adapter.name, entries);
};

/**
 * The registry is a runtime boundary for third-party and JavaScript adapters,
 * whose declarations the compiler never checked. Rejecting a malformed state
 * here keeps it out of `supports()` and capability intersection entirely.
 */
const assertCapabilityContract = (adapter: TargetAdapter): void => {
  const capabilities = record(adapter.capabilities);
  if (capabilities === undefined) {
    throw new CapabilityStateError(`Target adapter "${adapter.name}" must declare capabilities as a record.`);
  }
  for (const [capability, state] of Object.entries(capabilities)) {
    // An absent capability is an honest "not declared"; a present malformed one is not.
    if (state === undefined || isCapabilityState(state)) continue;
    throw new CapabilityStateError(
      `Target adapter "${adapter.name}" capability "${capability}" must declare one of ` +
        `${capabilityStateNames.join('/')} with that state's required fields.`,
    );
  }
  if (adapter.componentCapabilities === undefined) return;
  const componentCapabilities = record(adapter.componentCapabilities);
  if (componentCapabilities === undefined) {
    throw new CapabilityStateError(
      `Target adapter "${adapter.name}" must declare component capabilities as a record.`,
    );
  }
  for (const [capability, state] of Object.entries(componentCapabilities)) {
    if (state === undefined || isCapabilityState(state)) continue;
    throw new CapabilityStateError(
      `Target adapter "${adapter.name}" component capability "${capability}" must declare one of ` +
        `${capabilityStateNames.join('/')} with that state's required fields.`,
    );
  }
};

export class TargetRegistry implements NormalizationTargetRegistry {
  readonly #adapters = new Map<string, TargetAdapter>();
  readonly #artifactLayouts = new Map<string, TargetArtifactLayout>();
  readonly #artifactValidations = new Map<string, TargetArtifactValidationContract>();
  readonly #binSources = new Map<string, BinSource>();
  readonly #defaults: string[] = [];
  readonly #extensions = new Map<string, NormalizationConfigExtension>();
  readonly #hookContracts = new Map<string, TargetHookContract>();
  readonly #lowersConfigExtensions = new Map<string, readonly string[]>();
  readonly #metadata = new Map<string, TargetAdapterMetadata>();
  readonly #mcpRuntimes = new Map<string, TargetMcpRuntimeContract>();
  readonly #nativeHookSources = new Map<string, NativeHookSource>();
  readonly #noticeDeliveries = new Map<string, NoticeDeliveryAdvertisement>();
  readonly #outputStylesSources = new Map<string, OutputStylesSource>();
  readonly #workflowsSources = new Map<string, WorkflowsSource>();

  register(adapter: TargetAdapter, options: { readonly default?: boolean } = {}): this {
    if (this.#adapters.has(adapter.name)) {
      throw new Error(`Target adapter "${adapter.name}" is already registered.`);
    }
    const extension = adapter.configExtension;
    if (extension !== undefined && this.#extensions.has(extension.key)) {
      throw new Error(`Config extension key "${extension.key}" is already registered.`);
    }
    assertCapabilityContract(adapter);
    const metadata = snapshotMetadata(adapter.metadata);
    const artifactValidation = snapshotArtifactValidation(adapter, metadata);
    const binSource = snapshotBinSource(adapter);
    const nativeHookSource = snapshotNativeHookSource(adapter);
    const outputStylesSource = snapshotOutputStylesSource(adapter);
    const workflowsSource = snapshotWorkflowsSource(adapter);
    const hookContract = snapshotHookContract(adapter);
    const mcpRuntime = snapshotMcpRuntime(adapter);
    const artifactLayout = snapshotArtifactLayout(adapter, hookContract, mcpRuntime);
    const lowersConfigExtensions = snapshotLowersConfigExtensions(adapter);
    const noticeDelivery = snapshotNoticeDelivery(adapter);

    this.#adapters.set(adapter.name, adapter);
    this.#lowersConfigExtensions.set(adapter.name, lowersConfigExtensions);
    this.#artifactValidations.set(adapter.name, artifactValidation);
    this.#artifactLayouts.set(adapter.name, artifactLayout);
    this.#metadata.set(adapter.name, metadata);
    if (binSource !== undefined) {
      this.#binSources.set(adapter.name, binSource);
    }
    if (extension !== undefined) {
      this.#extensions.set(extension.key, Object.freeze({
        key: extension.key,
        target: adapter.name,
      }));
    }
    if (nativeHookSource !== undefined) {
      this.#nativeHookSources.set(adapter.name, nativeHookSource);
    }
    if (outputStylesSource !== undefined) {
      this.#outputStylesSources.set(adapter.name, outputStylesSource);
    }
    if (workflowsSource !== undefined) {
      this.#workflowsSources.set(adapter.name, workflowsSource);
    }
    if (hookContract !== undefined) {
      this.#hookContracts.set(adapter.name, hookContract);
    }
    if (mcpRuntime !== undefined) {
      this.#mcpRuntimes.set(adapter.name, mcpRuntime);
    }
    if (noticeDelivery !== undefined) {
      this.#noticeDeliveries.set(adapter.name, noticeDelivery);
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

  /** The validated notice delivery advertisement, or undefined for a host that declares none. */
  noticeDelivery(name: string): NoticeDeliveryAdvertisement | undefined {
    if (!this.#adapters.has(name)) {
      throw new Error(`Unknown target adapter "${name}".`);
    }
    return this.#noticeDeliveries.get(name);
  }

  configExtensions(): readonly NormalizationConfigExtension[] {
    return Object.freeze([...this.#extensions.values()]);
  }

  binSources(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostBinSource[] {
    const sources: NormalizationHostBinSource[] = [];
    for (const target of [...this.#binSources.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!targetNames.includes(target)) continue;
      const adapter = this.#adapters.get(target)!;
      try {
        const source = this.#binSources.get(target)!.call(adapter, config);
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

  outputStyleSources(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostPayloadSource[] {
    const sources: NormalizationHostPayloadSource[] = [];
    for (const target of [...this.#outputStylesSources.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!targetNames.includes(target)) continue;
      const adapter = this.#adapters.get(target)!;
      try {
        const source = this.#outputStylesSources.get(target)!.call(adapter, config);
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

  workflowSources(
    config: Readonly<AgentBundleConfig>,
    targetNames: readonly string[],
  ): readonly NormalizationHostPayloadSource[] {
    const sources: NormalizationHostPayloadSource[] = [];
    for (const target of [...this.#workflowsSources.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!targetNames.includes(target)) continue;
      const adapter = this.#adapters.get(target)!;
      try {
        const source = this.#workflowsSources.get(target)!.call(adapter, config);
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

  capabilityState(name: string, capability: string): CapabilityState | undefined {
    return this.#adapters.get(name)?.capabilities[capability];
  }

  componentCapabilityState(name: string, capability: string): CapabilityState | undefined {
    const adapter = this.#adapters.get(name);
    return adapter === undefined ? undefined : (adapter.componentCapabilities ?? adapter.capabilities)[capability];
  }

  lowersConfigExtension(name: string, key: string): boolean {
    if (!this.#adapters.has(name)) return false;
    // Ownership comes from the snapshots taken at registration, never from
    // the live adapter object an unchecked JavaScript caller could mutate.
    return this.#extensions.get(key)?.target === name || (this.#lowersConfigExtensions.get(name) ?? []).includes(key);
  }

  supports(name: string, capability: string): boolean {
    return capabilityIsSupported(this.capabilityState(name, capability));
  }

  /** True when the target emits components needing `capability`, by the same judgment `inspect` reports. */
  hostsComponent(name: string, capability: string): boolean {
    return capabilityIsSupported(this.componentCapabilityState(name, capability));
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
    .register(cursorAdapter);
