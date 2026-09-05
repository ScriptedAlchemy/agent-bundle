import { digest, stableJson } from '../core/digest.ts';
import {
  formatRuntimeVersion,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { isPreservedRuntimeRoot, isRelocatablePosixPath, preservedRuntimeEntries } from '../core/paths.ts';
import { isValidPackageName, isValidPackageVersion } from '../core/project-context.ts';
import { isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { providerKeyFromName } from '../routes/providers.ts';
import type { CliProjectionFlagDefault } from '../routes/public.ts';
import type {
  CompiledCliMode,
  CompiledCliOption,
  CompiledLayoutScope,
  CompiledRouteKind,
  CompiledServerMode,
  RouteInputPropertySchema,
  RouteInputSchema,
  RouteInputSchemaLiteral,
} from '../routes/types.ts';
import {
  artifactManifestVersion,
  mcpServerKinds,
  parseProjectionHosts,
  parseServerLaunches,
  parseWebManifest,
  requireLaunchFiles,
  requireLaunchReferences,
  requireManifestVersion,
  type ArtifactManifestLaunch,
  type ArtifactManifestLaunchArgument,
  type WebManifest,
} from '../web-host/manifest.ts';

// The launch record and the checks both readers make are declared beside the
// lean reader bundled into generated executables (`agent-bundle/web-host`),
// which must not import this module.
export type { ArtifactManifestLaunch, ArtifactManifestLaunchArgument };

/**
 * The authoritative artifact manifest (`agent-bundle.manifest.json`, issue
 * #592 step 3). One document indexes the composite root (#555): the
 * application identity that was compiled, the compiled route graph, the
 * selected host projections with their derived host-document pointers, every
 * executable the root can start, and the distribution surface. Every reader
 * — `validate`, `install`, `doctor`, `serve-app`, `eval`, the Workbench —
 * reads this document instead of probing host documents or directory layouts.
 *
 * Keys are closed at every level, arrays carry an explicit sort key, and the
 * bytes are canonical `stableJson`: any reader rejects a document that is not
 * byte-identical to its own serialization. `manifestVersion` versions the
 * public contract consumers read; `compiler.recordVersion` versions the
 * operational compiler record independently. Either number bumps on any
 * change an old closed reader would reject — adding, renaming, or removing a
 * key (optional or not) or changing an enumerated value set the reader
 * closes. Within one version the key inventory is frozen. Optional is not
 * backward compatible. Readers refuse any other version.
 */

export const artifactManifestName = 'agent-bundle.manifest.json';
export { artifactManifestVersion };
export const artifactCompilerRecordVersion = 1;

export type ArtifactManifestFileKind = 'bundle' | 'copy' | 'generated' | 'prebuilt';
export type ArtifactManifestValidationStatus = 'passed';

export interface ArtifactManifestSourceInput {
  readonly executable?: boolean;
  readonly path: string;
  readonly sha256: string;
}

export interface ArtifactManifestAgentSkills {
  readonly schemaSha256: string;
  readonly sourceRevision: string;
  readonly specification: string;
}

export interface ArtifactManifestFile {
  readonly bytes: number;
  readonly kind: ArtifactManifestFileKind;
  readonly mode?: number;
  readonly path: string;
  readonly sha256: string;
}

/** One `files[]` row's source-input provenance; lives on `compiler.provenance`. */
export interface ArtifactManifestProvenance {
  readonly path: string;
  readonly sourceInputs: readonly string[];
}

export interface ArtifactManifestProducer {
  readonly name: 'agent-bundle';
  readonly version: string;
}

/** The selected generated-executable runtime floor recorded with the artifact. */
export interface ArtifactManifestRuntime {
  readonly node: string;
}

export interface ArtifactManifestProject {
  readonly configDigest: string;
  readonly configPath: string;
  readonly modelDigest: string;
  /** The validated npm package name axis; absent for unpackaged development projects. */
  readonly packageName?: string;
  /** The validated semantic release-version axis; absent for unpackaged development projects. */
  readonly packageVersion?: string;
  readonly revision: string;
  readonly sourceInputs: readonly ArtifactManifestSourceInput[];
}

/**
 * The application identity, once and host-independent: what `install`,
 * `doctor`, and `uninstall` act on. Host documents and this manifest are
 * serialized from the same compiled model in one build.
 */
export interface ArtifactManifestApplication {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface ArtifactManifestProjectionSchema {
  readonly name: string;
  readonly revision: string;
  readonly sha256: string;
}

/**
 * Root-relative paths of the host documents one projection derived from the
 * manifest: the host's plugin manifest, and its marketplace, MCP, and hooks
 * documents when the projection emitted them. Every path is a `files[]` entry.
 */
export interface ArtifactManifestProjectionDocuments {
  readonly hooks?: string;
  readonly marketplace?: string;
  readonly mcp?: string;
  /** The host plugin manifest; absent when the projection emits none (`install`/`doctor` then fail `AB7001`). */
  readonly plugin?: string;
}

export interface ArtifactManifestProjectionMarketplace {
  readonly name: string;
}

/**
 * One selected host projection of the composite root (#555): targets select
 * projections, they are not identity. `host` is the adapter name.
 */
/**
 * The shipped adapters, by identity. A projection planned by one of them
 * records which, so a consumer holding only the manifest judges "is this the
 * Claude projection" the way the build did — by adapter, never by the name
 * the project selected it under (#578 audit: names are selection, not identity).
 */
export type ArtifactManifestBuiltInHost = 'claude' | 'codex' | 'cursor' | 'portable';

export interface ArtifactManifestProjection {
  /** The shipped adapter that planned this projection; absent for an advanced-registry adapter. */
  readonly builtInHost?: ArtifactManifestBuiltInHost;
  readonly documents: ArtifactManifestProjectionDocuments;
  /** The target name the project selected the projection under (its directory key in `targets`). */
  readonly host: string;
  /** The marketplace the projection's marketplace document registers; absent when none was emitted. */
  readonly marketplace?: ArtifactManifestProjectionMarketplace;
}

/** Operational adapter facts for one projection; lives on `compiler.adapters`. */
export interface ArtifactManifestCompilerAdapter {
  readonly adapterRevision: string;
  readonly host: string;
  readonly observedVersion: string;
  readonly schemas: readonly ArtifactManifestProjectionSchema[];
}

/** Mirrors {@link CompiledRouteKind}: the manifest groups by the compiler's own kinds. */
export type ArtifactManifestRouteKind = CompiledRouteKind;

/**
 * How a route entered the graph. Only conventional filesystem discovery exists
 * today; the discriminant is where a projected route (#596) attaches later.
 */
export interface ArtifactManifestRouteProvenance {
  readonly kind: 'conventional';
}

export interface ArtifactManifestEventExecution {
  readonly fallback: 'none' | 'standalone';
  /** Project-relative POSIX path of the event route's preflight module. */
  readonly preflight?: string;
  /** Sorted, unique conventional provider keys required by the event route. */
  readonly providers?: readonly string[];
  readonly runtime: 'shared' | 'standalone';
}

/** One compiled route of the Application IR, host-independent. */
export interface ArtifactManifestRoute {
  /** Id of the `routes.contracts[]` row this route binds (#593); absent when no static contract was extracted. */
  readonly contract?: string;
  /** `config.description` when it is a string. */
  readonly description?: string;
  /** Canonical event identity; `event-route` routes only. */
  readonly event?: string;
  /** Event execution metadata; present exactly for `event-route` routes. */
  readonly execution?: ArtifactManifestEventExecution;
  readonly id: string;
  /** Bounded JSON Schema projection; absent when the route schema is richer than the static grammar. */
  readonly inputSchema?: RouteInputSchema;
  readonly kind: ArtifactManifestRouteKind;
  readonly provenance: ArtifactManifestRouteProvenance;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
  /** Project-relative POSIX module path: the route's portable identity. */
  readonly source: string;
}

export interface ArtifactManifestServer {
  readonly id: string;
  readonly mode: CompiledServerMode;
  readonly name: string;
  readonly routes: readonly ArtifactManifestRoute[];
}

/** One argv projection of a CLI route's input schema, without editor defaults. */
export interface ArtifactManifestCliOption {
  /** Extra long-form `--spellings` a CLI projection declared (`flags.<key>.aliases`); sorted, unique. */
  readonly aliases?: readonly string[];
  readonly choices?: readonly string[];
  readonly description?: string;
  readonly key: string;
  readonly kind: CompiledCliOption['kind'];
  readonly option: string;
  readonly positional?: number;
  readonly repeated: boolean;
  readonly required: boolean;
}

export interface ArtifactManifestCliCommandMcp {
  readonly confirm: boolean;
  readonly server: string;
  readonly tool: string;
}

/**
 * Mirrors {@link CompiledCliProjection}: what a tool's `<tool>.cli.{ts,tsx}`
 * module (#596) contributes beyond the argv grammar `options` already spell.
 */
export interface ArtifactManifestCliProjection {
  /** Canonical key → the projection's `flags.<key>.default` literal. */
  readonly defaults?: Readonly<Record<string, CliProjectionFlagDefault>>;
  /** True when the module exports `mapInput`. */
  readonly mapInput: boolean;
  /** Project-relative POSIX path of the projection module. */
  readonly module: string;
  /** Canonical-required keys the projection made optional on the CLI; sorted, unique. */
  readonly relaxed?: readonly string[];
}

/** One executable command compiled from a custom CLI route or projected MCP tool. */
export interface ArtifactManifestCliCommand {
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly exitCode: 'result' | 'zero';
  readonly mcp?: ArtifactManifestCliCommandMcp;
  readonly options: readonly ArtifactManifestCliOption[];
  readonly path: readonly string[];
  /** Present for a command compiled from a tool's CLI projection module. */
  readonly projection?: ArtifactManifestCliProjection;
  readonly routeId: string;
}

export interface ArtifactManifestCli {
  /** Present only in `generated` mode, matching the compiler surface. */
  readonly commands?: readonly ArtifactManifestCliCommand[];
  readonly mode: CompiledCliMode;
  /** The custom `cli` routes plus every MCP `tool` route `routes.mcpCommands` projects into the executable. */
  readonly routes: readonly ArtifactManifestRoute[];
}

export interface ArtifactManifestProvider {
  readonly id: string;
  readonly name: string;
  /** Project-relative POSIX module path. */
  readonly source: string;
}

export interface ArtifactManifestLayout {
  /** `layout:root` or `layout:mcp:<server>`. */
  readonly id: string;
  readonly scope: CompiledLayoutScope;
  /** The owning MCP server id; `server` scope only. */
  readonly serverId?: string;
  /** Project-relative POSIX module path. */
  readonly source: string;
}

/** The compiled route graph the artifact was built from (gap 1 of #592 step 3). */
/** Where a contract's schema is declared: the project-relative module and the binding at the end of any alias chain. */
export interface ArtifactManifestRouteContractOrigin {
  readonly binding: string;
  readonly module: string;
}

/**
 * One canonical input contract (#593): a route `inputSchema` declaration
 * normalized once and shared by every route binding the same declaration.
 * `id` is `contract:<origin.module>#<origin.binding>`; `routes` are the sorted
 * ids of the graph routes bound to it.
 */
export interface ArtifactManifestRouteContract {
  readonly id: string;
  readonly input: RouteInputSchema;
  readonly origin: ArtifactManifestRouteContractOrigin;
  readonly routes: readonly string[];
}

export interface ArtifactManifestRoutes {
  readonly cli?: ArtifactManifestCli;
  /** Sorted by id; present exactly when some route binds a contract. */
  readonly contracts?: readonly ArtifactManifestRouteContract[];
  /** sha256 over the graph's project-relative identity. */
  readonly digest: string;
  readonly events: readonly ArtifactManifestRoute[];
  readonly layouts: readonly ArtifactManifestLayout[];
  readonly providers: readonly ArtifactManifestProvider[];
  readonly scripts: readonly ArtifactManifestRoute[];
  readonly servers: readonly ArtifactManifestServer[];
}

/** The routed CLI executable (`bin/<name>.mjs`) and its Flight worker. */
export interface ArtifactManifestBin {
  readonly hosts: readonly string[];
  readonly name: string;
  readonly path: string;
  readonly worker?: string;
}

/**
 * One compiler wrapper a host's hooks document runs: `event-route` wrappers
 * dispatch a conventional `src/hooks/**` route, `config` wrappers run a hook
 * declared in the configuration. Native commands an author writes directly
 * into a host document and prebuilt-payload commands are Projection IR and
 * are not rows here; the validator proves every wrapper a host document names
 * is exactly one row (`AB6018`).
 */
export interface ArtifactManifestHook {
  readonly event: string;
  readonly host: string;
  readonly id: string;
  readonly kind: 'config' | 'event-route';
  readonly name: string;
  readonly path: string;
  /** The `routes.events[]` row an `event-route` wrapper dispatches; present exactly for that kind. */
  readonly routeId?: string;
  /** Native hook timeout in seconds. Omit it to use the host default. */
  readonly timeout?: number;
}

export interface ArtifactManifestMcpApp {
  readonly id: string;
  readonly name: string;
  /** The emitted self-contained HTML; absent for a `prebuilt` app whose payload already serves it. */
  readonly path?: string;
  readonly prebuilt?: true;
  readonly resourceUri: string;
}

/**
 * One MCP server the artifact declares: `compiled` and `prebuilt` servers
 * carry the one `launch` record the artifact starts them from, `command`
 * servers name a host-run command, `remote` servers a URL — the last two live
 * only in the host MCP documents.
 */
export interface ArtifactManifestMcpServer {
  readonly apps: readonly ArtifactManifestMcpApp[];
  readonly hosts: readonly string[];
  readonly id: string;
  readonly kind: 'command' | 'compiled' | 'prebuilt' | 'remote';
  /** Present exactly for `compiled` and `prebuilt` servers. */
  readonly launch?: ArtifactManifestLaunch;
  readonly name: string;
  readonly transport: string;
}

export interface ArtifactManifestScriptRendered {
  readonly routeId: string;
}

export interface ArtifactManifestScript {
  readonly hosts: readonly string[];
  readonly id: string;
  readonly mode: 'bundle' | 'copy';
  readonly name: string;
  readonly path: string;
  /** The conventional rendered-script route this entry renders. */
  readonly rendered?: ArtifactManifestScriptRendered;
  readonly worker?: string;
}

/** Every process the artifact can start (gap 6 of #592 step 3). */
export interface ArtifactManifestExecutables {
  readonly bins: readonly ArtifactManifestBin[];
  readonly hooks: readonly ArtifactManifestHook[];
  readonly mcpServers: readonly ArtifactManifestMcpServer[];
  readonly scripts: readonly ArtifactManifestScript[];
}

export type ArtifactManifestDistributionChannel = 'local' | 'npm';

/** Root-relative pointers at the install surface (#555 W2/S5 owns the contents). */
export interface ArtifactManifestDistributionInstall {
  readonly instructions?: string;
  readonly script?: string;
}

/**
 * One prebuilt payload directory the artifact packages byte-for-byte
 * (`definePrebuilt`, #630). The compiler never opens its files, so the
 * author's `runtimeDependencies` declaration is the only record of what the
 * tree loads from a consumer's install; `files[]` rows under `<name>/` carry
 * kind `prebuilt`.
 */
export interface ArtifactManifestPayload {
  /** Declared projections the payload is packaged for; sorted. */
  readonly hosts: readonly string[];
  /** Artifact-root directory name. */
  readonly name: string;
  /** Bare package names the payload loads at run time; sorted, unique. */
  readonly runtimeDependencies: readonly string[];
}

/** How the artifact reaches a host (gap 7 of #592 step 3). */
export interface ArtifactManifestDistribution {
  /** `local` always; `npm` when the project carries a package identity. */
  readonly channels: readonly ArtifactManifestDistributionChannel[];
  readonly install?: ArtifactManifestDistributionInstall;
  /** Prebuilt payload directories, sorted by name. */
  readonly payloads: readonly ArtifactManifestPayload[];
}

export interface ArtifactManifestValidationRecord {
  readonly status: ArtifactManifestValidationStatus;
}

export interface ArtifactManifestProjectionValidation extends ArtifactManifestValidationRecord {
  readonly host: string;
}

export interface ArtifactManifestValidation {
  readonly artifact: ArtifactManifestValidationRecord;
  readonly projections: readonly ArtifactManifestProjectionValidation[];
  readonly source: ArtifactManifestValidationRecord;
}

/**
 * Operational record of the compiler run. Versioned by `recordVersion`
 * independently of `manifestVersion`: a change here is not a change to the
 * artifact contract consumers read.
 */
export interface ArtifactManifestCompiler {
  readonly adapters: readonly ArtifactManifestCompilerAdapter[];
  readonly agentSkills: ArtifactManifestAgentSkills;
  readonly producer: ArtifactManifestProducer;
  readonly project: ArtifactManifestProject;
  readonly provenance: readonly ArtifactManifestProvenance[];
  readonly recordVersion: typeof artifactCompilerRecordVersion;
  readonly validation: ArtifactManifestValidation;
}

export interface ArtifactManifest {
  readonly application: ArtifactManifestApplication;
  readonly compiler: ArtifactManifestCompiler;
  readonly distribution: ArtifactManifestDistribution;
  readonly executables: ArtifactManifestExecutables;
  readonly files: readonly ArtifactManifestFile[];
  readonly manifestVersion: typeof artifactManifestVersion;
  readonly projections: readonly ArtifactManifestProjection[];
  readonly routes: ArtifactManifestRoutes;
  readonly runtime: ArtifactManifestRuntime;
  readonly web?: WebManifest;
}

export interface AssembledArtifactManifest {
  readonly bytes: string;
  readonly manifest: ArtifactManifest;
}

type JsonRecord = Record<string, unknown>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

const routeKinds: readonly ArtifactManifestRouteKind[] = Object.freeze([
  'app',
  'cli',
  'event-route',
  'prompt',
  'resource',
  'script',
  'tool',
]);
const serverModes: readonly CompiledServerMode[] = Object.freeze(['command', 'conflict', 'custom', 'generated', 'remote']);
const cliModes: readonly CompiledCliMode[] = Object.freeze(['conflict', 'conventional', 'generated']);
const cliOptionKinds: readonly CompiledCliOption['kind'][] = Object.freeze(['boolean', 'enum', 'number', 'string']);
const layoutScopes: readonly CompiledLayoutScope[] = Object.freeze(['root', 'server']);
const distributionChannels: readonly ArtifactManifestDistributionChannel[] = Object.freeze(['local', 'npm']);

const fail = (message: string): never => {
  throw new TypeError(`Artifact manifest ${message}`);
};

// Inputs are parsed JSON, so the canonical guard's narrowing is retyped to JsonRecord.
const isPlainObject = isPlainRecord as (value: unknown) => value is JsonRecord;

const requireRecord = (value: unknown, location: string): JsonRecord =>
  isPlainObject(value) ? value : fail(`${location} must be a plain object.`);

const requireArray = (value: unknown, location: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(`${location} must be an array.`);

const requireString = (value: unknown, location: string): string =>
  typeof value === 'string' && value.length > 0
    ? value
    : fail(`${location} must be a non-empty string.`);

const requireBoolean = (value: unknown, location: string): boolean =>
  typeof value === 'boolean' ? value : fail(`${location} must be a boolean.`);

const requireOneOf = <Value extends string>(
  value: unknown,
  location: string,
  allowed: readonly Value[],
): Value => (allowed as readonly unknown[]).includes(value)
  ? value as Value
  : fail(`${location} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}.`);

const requireHash = (value: unknown, location: string): string => {
  const hash = requireString(value, location);
  return sha256Pattern.test(hash) ? hash : fail(`${location} must be a lowercase SHA-256 hash.`);
};

const requirePath = (value: unknown, location: string): string => {
  const path = requireString(value, location);
  return isRelocatablePosixPath(path) ? path : fail(`${location} must be a safe relative POSIX path.`);
};

const requireExactKeys = (
  value: JsonRecord,
  location: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0) fail(`${location} has unexpected keys: ${unexpected.join(', ')}.`);
  if (missing.length > 0) fail(`${location} is missing keys: ${missing.join(', ')}.`);
};

const requireSortedUnique = <Value>(
  values: readonly Value[],
  location: string,
  keyFor: (value: Value) => string,
): void => {
  let previous: string | undefined;
  for (const value of values) {
    const key = keyFor(value);
    if (previous !== undefined && previous.localeCompare(key) >= 0) {
      fail(`${location} must be sorted with no duplicate entries.`);
    }
    previous = key;
  }
};

const parseStringList = (value: unknown, location: string, sorted = true): readonly string[] => {
  const entries = requireArray(value, location).map((entry, index) => requireString(entry, `${location}[${index}]`));
  if (sorted) requireSortedUnique(entries, location, (entry) => entry);
  return entries;
};

const requireStatus = (value: unknown, location: string): ArtifactManifestValidationRecord => {
  const record = requireRecord(value, location);
  requireExactKeys(record, location, ['status']);
  if (record.status !== 'passed') fail(`${location}.status must be "passed".`);
  return { status: 'passed' };
};

const parseSourceInputs = (value: unknown, location: string): readonly ArtifactManifestSourceInput[] => {
  const inputs = requireArray(value, location).map((candidate, index) => {
    const input = requireRecord(candidate, `${location}[${index}]`);
    requireExactKeys(input, `${location}[${index}]`, ['path', 'sha256'], ['executable']);
    const executable = input.executable === undefined
      ? undefined
      : requireBoolean(input.executable, `${location}[${index}].executable`);
    return {
      ...(executable === undefined ? {} : { executable }),
      path: requirePath(input.path, `${location}[${index}].path`),
      sha256: requireHash(input.sha256, `${location}[${index}].sha256`),
    } satisfies ArtifactManifestSourceInput;
  });
  requireSortedUnique(inputs, location, (input) => input.path);
  return inputs;
};

const parseProvenanceSourceInputs = (value: unknown, location: string): readonly string[] => {
  const sourceInputs = requireArray(value, location).map((input, index) =>
    requirePath(input, `${location}[${index}]`));
  requireSortedUnique(sourceInputs, location, (input) => input);
  return sourceInputs;
};

const parseFiles = (value: unknown): readonly ArtifactManifestFile[] => {
  const files = requireArray(value, 'files').map((candidate, index) => {
    const file = requireRecord(candidate, `files[${index}]`);
    requireExactKeys(file, `files[${index}]`, ['bytes', 'kind', 'path', 'sha256'], ['mode']);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) {
      fail(`files[${index}].bytes must be a non-negative safe integer.`);
    }
    if (file.kind !== 'bundle' && file.kind !== 'copy' && file.kind !== 'generated' && file.kind !== 'prebuilt') {
      fail(`files[${index}].kind is unknown.`);
    }
    if (file.mode !== undefined && (!Number.isSafeInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777)) {
      fail(`files[${index}].mode must be an integer from 0 through 0777.`);
    }
    const path = requirePath(file.path, `files[${index}].path`);
    if (path === artifactManifestName) fail(`files[${index}].path must not name the manifest itself.`);
    if (isPreservedRuntimeRoot(path.split('/')[0]!)) {
      fail(`files[${index}].path must not be under the runtime-owned root ${JSON.stringify(`${preservedRuntimeEntries[0]}/`)}.`);
    }
    return {
      bytes: file.bytes as number,
      kind: file.kind as ArtifactManifestFileKind,
      ...(file.mode === undefined ? {} : { mode: file.mode as number }),
      path,
      sha256: requireHash(file.sha256, `files[${index}].sha256`),
    } satisfies ArtifactManifestFile;
  });
  requireSortedUnique(files, 'files', (file) => file.path);
  return files;
};

const parseProvenance = (value: unknown): readonly ArtifactManifestProvenance[] => {
  const provenance = requireArray(value, 'compiler.provenance').map((candidate, index) => {
    const record = requireRecord(candidate, `compiler.provenance[${index}]`);
    requireExactKeys(record, `compiler.provenance[${index}]`, ['path', 'sourceInputs']);
    const path = requirePath(record.path, `compiler.provenance[${index}].path`);
    if (path === artifactManifestName) fail(`compiler.provenance[${index}].path must not name the manifest itself.`);
    return {
      path,
      sourceInputs: parseProvenanceSourceInputs(
        record.sourceInputs,
        `compiler.provenance[${index}].sourceInputs`,
      ),
    } satisfies ArtifactManifestProvenance;
  });
  requireSortedUnique(provenance, 'compiler.provenance', (entry) => entry.path);
  return provenance;
};

const parseApplication = (value: unknown): ArtifactManifestApplication => {
  const application = requireRecord(value, 'application');
  requireExactKeys(application, 'application', ['id', 'name', 'version'], ['description']);
  return {
    ...(application.description === undefined
      ? {}
      : { description: requireString(application.description, 'application.description') }),
    id: requireString(application.id, 'application.id'),
    name: requireString(application.name, 'application.name'),
    version: requireString(application.version, 'application.version'),
  };
};

const parseProjectionSchemas = (value: unknown, location: string): readonly ArtifactManifestProjectionSchema[] => {
  const schemas = requireArray(value, location).map((candidate, index) => {
    const schema = requireRecord(candidate, `${location}[${index}]`);
    requireExactKeys(schema, `${location}[${index}]`, ['name', 'revision', 'sha256']);
    return {
      name: requireString(schema.name, `${location}[${index}].name`),
      revision: requireString(schema.revision, `${location}[${index}].revision`),
      sha256: requireHash(schema.sha256, `${location}[${index}].sha256`),
    } satisfies ArtifactManifestProjectionSchema;
  });
  requireSortedUnique(schemas, location, (schema) => schema.name);
  return schemas;
};

const parseProjectionDocuments = (value: unknown, location: string): ArtifactManifestProjectionDocuments => {
  const documents = requireRecord(value, location);
  requireExactKeys(documents, location, [], ['hooks', 'marketplace', 'mcp', 'plugin']);
  const optionalPath = (key: 'hooks' | 'marketplace' | 'mcp' | 'plugin'): Record<string, string> =>
    documents[key] === undefined ? {} : { [key]: requirePath(documents[key], `${location}.${key}`) };
  return {
    ...optionalPath('hooks'),
    ...optionalPath('marketplace'),
    ...optionalPath('mcp'),
    ...optionalPath('plugin'),
  };
};

const parseProjections = (value: unknown): readonly ArtifactManifestProjection[] => {
  const projections = requireArray(value, 'projections').map((candidate, index) => {
    const location = `projections[${index}]`;
    const projection = requireRecord(candidate, location);
    requireExactKeys(
      projection,
      location,
      ['documents', 'host'],
      ['builtInHost', 'marketplace'],
    );
    const documents = parseProjectionDocuments(projection.documents, `${location}.documents`);
    let marketplace: ArtifactManifestProjectionMarketplace | undefined;
    if (projection.marketplace !== undefined) {
      const record = requireRecord(projection.marketplace, `${location}.marketplace`);
      requireExactKeys(record, `${location}.marketplace`, ['name']);
      marketplace = { name: requireString(record.name, `${location}.marketplace.name`) };
      if (documents.marketplace === undefined) {
        fail(`${location}.marketplace requires a documents.marketplace pointer.`);
      }
    }
    return {
      ...(projection.builtInHost === undefined ? {} : {
        builtInHost: requireOneOf(projection.builtInHost, `${location}.builtInHost`, ['claude', 'codex', 'cursor', 'portable'] as const),
      }),
      documents,
      host: requireString(projection.host, `${location}.host`),
      ...(marketplace === undefined ? {} : { marketplace }),
    } satisfies ArtifactManifestProjection;
  });
  requireSortedUnique(projections, 'projections', (projection) => projection.host);
  return projections;
};

const parseCompilerAdapters = (value: unknown): readonly ArtifactManifestCompilerAdapter[] => {
  const adapters = requireArray(value, 'compiler.adapters').map((candidate, index) => {
    const location = `compiler.adapters[${index}]`;
    const adapter = requireRecord(candidate, location);
    requireExactKeys(adapter, location, ['adapterRevision', 'host', 'observedVersion', 'schemas']);
    return {
      adapterRevision: requireString(adapter.adapterRevision, `${location}.adapterRevision`),
      host: requireString(adapter.host, `${location}.host`),
      observedVersion: requireString(adapter.observedVersion, `${location}.observedVersion`),
      schemas: parseProjectionSchemas(adapter.schemas, `${location}.schemas`),
    } satisfies ArtifactManifestCompilerAdapter;
  });
  requireSortedUnique(adapters, 'compiler.adapters', (adapter) => adapter.host);
  return adapters;
};

const parseSchemaLiteral = (value: unknown, location: string): RouteInputSchemaLiteral => {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'boolean' || typeof entry === 'number' || typeof entry === 'string')) {
    return value as readonly (boolean | number | string)[];
  }
  return fail(`${location} must be a boolean, number, string, or an array of those.`);
};

const parseInputSchemaProperty = (value: unknown, location: string): RouteInputPropertySchema => {
  const property = requireRecord(value, location);
  const type = requireOneOf(property.type, `${location}.type`, ['array', 'boolean', 'number', 'string'] as const);
  const description = property.description === undefined
    ? {}
    : { description: requireString(property.description, `${location}.description`) };
  const defaultValue = property.default === undefined
    ? {}
    : { default: parseSchemaLiteral(property.default, `${location}.default`) };
  switch (type) {
    case 'boolean':
    case 'number':
      requireExactKeys(property, location, ['type'], ['default', 'description']);
      return { ...defaultValue, ...description, type };
    case 'string':
      requireExactKeys(property, location, ['type'], ['default', 'description', 'enum']);
      return {
        ...defaultValue,
        ...description,
        ...(property.enum === undefined ? {} : { enum: parseStringList(property.enum, `${location}.enum`, false) }),
        type,
      };
    case 'array': {
      requireExactKeys(property, location, ['items', 'type'], ['default', 'description']);
      const items = requireRecord(property.items, `${location}.items`);
      const itemType = requireOneOf(items.type, `${location}.items.type`, ['boolean', 'number', 'string'] as const);
      if (itemType === 'string') {
        requireExactKeys(items, `${location}.items`, ['type'], ['enum']);
        return {
          ...defaultValue,
          ...description,
          items: {
            ...(items.enum === undefined ? {} : { enum: parseStringList(items.enum, `${location}.items.enum`, false) }),
            type: itemType,
          },
          type,
        };
      }
      requireExactKeys(items, `${location}.items`, ['type']);
      return { ...defaultValue, ...description, items: { type: itemType }, type };
    }
    default: {
      const exhaustive: never = type;
      return fail(`${location}.type ${String(exhaustive)} is unknown.`);
    }
  }
};

const parseInputSchema = (value: unknown, location: string): RouteInputSchema => {
  const schema = requireRecord(value, location);
  requireExactKeys(schema, location, ['additionalProperties', 'properties', 'type'], ['required']);
  if (schema.additionalProperties !== false) fail(`${location}.additionalProperties must be false.`);
  if (schema.type !== 'object') fail(`${location}.type must be "object".`);
  const propertiesRecord = requireRecord(schema.properties, `${location}.properties`);
  const properties: Record<string, RouteInputPropertySchema> = {};
  for (const key of Object.keys(propertiesRecord)) {
    properties[key] = parseInputSchemaProperty(propertiesRecord[key], `${location}.properties.${key}`);
  }
  const required = schema.required === undefined
    ? undefined
    : parseStringList(schema.required, `${location}.required`, false);
  if (required?.some((key) => !Object.hasOwn(properties, key)) === true) {
    fail(`${location}.required names an undeclared property.`);
  }
  return {
    additionalProperties: false,
    properties,
    ...(required === undefined ? {} : { required }),
    type: 'object',
  };
};

const parseEventExecution = (value: unknown, location: string): ArtifactManifestEventExecution => {
  const execution = requireRecord(value, location);
  requireExactKeys(execution, location, ['fallback', 'runtime'], ['preflight', 'providers']);
  return {
    fallback: requireOneOf(execution.fallback, `${location}.fallback`, ['none', 'standalone'] as const),
    ...(execution.preflight === undefined ? {} : { preflight: requirePath(execution.preflight, `${location}.preflight`) }),
    ...(execution.providers === undefined ? {} : { providers: parseStringList(execution.providers, `${location}.providers`) }),
    runtime: requireOneOf(execution.runtime, `${location}.runtime`, ['shared', 'standalone'] as const),
  };
};

const parseRoute = (value: unknown, location: string): ArtifactManifestRoute => {
  const route = requireRecord(value, location);
  requireExactKeys(
    route,
    location,
    ['id', 'kind', 'provenance', 'source'],
    ['contract', 'description', 'event', 'execution', 'inputSchema', 'serverId'],
  );
  const provenance = requireRecord(route.provenance, `${location}.provenance`);
  requireExactKeys(provenance, `${location}.provenance`, ['kind']);
  if (provenance.kind !== 'conventional') fail(`${location}.provenance.kind must be "conventional".`);
  const kind = requireOneOf(route.kind, `${location}.kind`, routeKinds);
  const event = route.event === undefined ? undefined : requireString(route.event, `${location}.event`);
  if ((kind === 'event-route') !== (event !== undefined)) {
    fail(`${location}.event is present exactly for event-route routes.`);
  }
  const execution = route.execution === undefined
    ? undefined
    : parseEventExecution(route.execution, `${location}.execution`);
  if ((kind === 'event-route') !== (execution !== undefined)) {
    fail(`${location}.execution is present exactly for event-route routes.`);
  }
  const serverId = route.serverId === undefined ? undefined : requireString(route.serverId, `${location}.serverId`);
  const isMcpKind = kind === 'app' || kind === 'prompt' || kind === 'resource' || kind === 'tool';
  if (isMcpKind !== (serverId !== undefined)) {
    fail(`${location}.serverId is present exactly for MCP route kinds.`);
  }
  return {
    ...(route.contract === undefined ? {} : { contract: requireString(route.contract, `${location}.contract`) }),
    ...(route.description === undefined ? {} : { description: requireString(route.description, `${location}.description`) }),
    ...(event === undefined ? {} : { event }),
    ...(execution === undefined ? {} : { execution }),
    id: requireString(route.id, `${location}.id`),
    ...(route.inputSchema === undefined ? {} : { inputSchema: parseInputSchema(route.inputSchema, `${location}.inputSchema`) }),
    kind,
    provenance: { kind: 'conventional' },
    ...(serverId === undefined ? {} : { serverId }),
    source: requirePath(route.source, `${location}.source`),
  };
};

const parseRoutesList = (value: unknown, location: string): readonly ArtifactManifestRoute[] => {
  const routes = requireArray(value, location).map((candidate, index) => parseRoute(candidate, `${location}[${index}]`));
  requireSortedUnique(routes, location, (route) => route.id);
  return routes;
};

const parseServers = (value: unknown): readonly ArtifactManifestServer[] => {
  const servers = requireArray(value, 'routes.servers').map((candidate, index) => {
    const location = `routes.servers[${index}]`;
    const server = requireRecord(candidate, location);
    requireExactKeys(server, location, ['id', 'mode', 'name', 'routes']);
    const id = requireString(server.id, `${location}.id`);
    const routes = parseRoutesList(server.routes, `${location}.routes`);
    if (routes.some((route) => route.serverId !== id)) fail(`${location}.routes must belong to the server.`);
    return {
      id,
      mode: requireOneOf(server.mode, `${location}.mode`, serverModes),
      name: requireString(server.name, `${location}.name`),
      routes,
    } satisfies ArtifactManifestServer;
  });
  requireSortedUnique(servers, 'routes.servers', (server) => server.id);
  return servers;
};

const parseCliOptions = (value: unknown, location: string): readonly ArtifactManifestCliOption[] => {
  const options = requireArray(value, location).map((candidate, index) => {
    const optionLocation = `${location}[${index}]`;
    const option = requireRecord(candidate, optionLocation);
    requireExactKeys(
      option,
      optionLocation,
      ['key', 'kind', 'option', 'repeated', 'required'],
      ['aliases', 'choices', 'description', 'positional'],
    );
    if (
      option.positional !== undefined &&
      (!Number.isSafeInteger(option.positional) || (option.positional as number) < 0)
    ) {
      fail(`${optionLocation}.positional must be a non-negative safe integer.`);
    }
    return {
      ...(option.aliases === undefined ? {} : { aliases: parseStringList(option.aliases, `${optionLocation}.aliases`) }),
      ...(option.choices === undefined ? {} : { choices: parseStringList(option.choices, `${optionLocation}.choices`, false) }),
      ...(option.description === undefined ? {} : { description: requireString(option.description, `${optionLocation}.description`) }),
      key: requireString(option.key, `${optionLocation}.key`),
      kind: requireOneOf(option.kind, `${optionLocation}.kind`, cliOptionKinds),
      option: requireString(option.option, `${optionLocation}.option`),
      ...(option.positional === undefined ? {} : { positional: option.positional as number }),
      repeated: requireBoolean(option.repeated, `${optionLocation}.repeated`),
      required: requireBoolean(option.required, `${optionLocation}.required`),
    } satisfies ArtifactManifestCliOption;
  });
  requireSortedUnique(options, location, (option) => option.key);
  return options;
};

const parseCliProjection = (value: unknown, location: string): ArtifactManifestCliProjection => {
  const projection = requireRecord(value, location);
  requireExactKeys(projection, location, ['mapInput', 'module'], ['defaults', 'relaxed']);
  let defaults: Record<string, CliProjectionFlagDefault> | undefined;
  if (projection.defaults !== undefined) {
    const record = requireRecord(projection.defaults, `${location}.defaults`);
    const keys = Object.keys(record);
    if (keys.length === 0) fail(`${location}.defaults must name at least one flag.`);
    defaults = Object.fromEntries(keys.map((key) => [key, parseSchemaLiteral(record[key], `${location}.defaults.${key}`)]));
  }
  const relaxed = projection.relaxed === undefined ? undefined : parseStringList(projection.relaxed, `${location}.relaxed`);
  if (relaxed !== undefined && relaxed.length === 0) fail(`${location}.relaxed must name at least one key.`);
  return {
    ...(defaults === undefined ? {} : { defaults }),
    mapInput: requireBoolean(projection.mapInput, `${location}.mapInput`),
    module: requirePath(projection.module, `${location}.module`),
    ...(relaxed === undefined ? {} : { relaxed }),
  };
};

const parseCliCommands = (value: unknown, location: string): readonly ArtifactManifestCliCommand[] => {
  const commands = requireArray(value, location).map((candidate, index) => {
    const commandLocation = `${location}[${index}]`;
    const command = requireRecord(candidate, commandLocation);
    requireExactKeys(
      command,
      commandLocation,
      ['aliases', 'exitCode', 'options', 'path', 'routeId'],
      ['description', 'mcp', 'projection'],
    );
    let mcp: ArtifactManifestCliCommandMcp | undefined;
    if (command.mcp !== undefined) {
      const record = requireRecord(command.mcp, `${commandLocation}.mcp`);
      requireExactKeys(record, `${commandLocation}.mcp`, ['confirm', 'server', 'tool']);
      mcp = {
        confirm: requireBoolean(record.confirm, `${commandLocation}.mcp.confirm`),
        server: requireString(record.server, `${commandLocation}.mcp.server`),
        tool: requireString(record.tool, `${commandLocation}.mcp.tool`),
      };
    }
    const path = parseStringList(command.path, `${commandLocation}.path`, false);
    if (path.length === 0) fail(`${commandLocation}.path must name at least one segment.`);
    return {
      aliases: parseStringList(command.aliases, `${commandLocation}.aliases`),
      ...(command.description === undefined ? {} : { description: requireString(command.description, `${commandLocation}.description`) }),
      exitCode: requireOneOf(command.exitCode, `${commandLocation}.exitCode`, ['result', 'zero'] as const),
      ...(mcp === undefined ? {} : { mcp }),
      options: parseCliOptions(command.options, `${commandLocation}.options`),
      path,
      ...(command.projection === undefined ? {} : { projection: parseCliProjection(command.projection, `${commandLocation}.projection`) }),
      routeId: requireString(command.routeId, `${commandLocation}.routeId`),
    } satisfies ArtifactManifestCliCommand;
  });
  requireSortedUnique(commands, location, (command) => command.path.join(' '));
  return commands;
};

const parseCli = (value: unknown): ArtifactManifestCli => {
  const cli = requireRecord(value, 'routes.cli');
  requireExactKeys(cli, 'routes.cli', ['mode', 'routes'], ['commands']);
  const mode = requireOneOf(cli.mode, 'routes.cli.mode', cliModes);
  const routes = parseRoutesList(cli.routes, 'routes.cli.routes');
  // Custom `cli` routes, plus the MCP `tool` routes `routes.mcpCommands`
  // projects into the executable (they keep their kind and owning server).
  for (const route of routes) {
    if (route.kind === 'cli') continue;
    if (route.kind !== 'tool' || route.serverId === undefined) {
      fail(`routes.cli.routes[${route.id}] must be a cli route or a projected MCP tool route.`);
    }
  }
  if ((mode === 'generated') !== (cli.commands !== undefined)) {
    fail('routes.cli.commands is present exactly in generated mode.');
  }
  const commands = cli.commands === undefined ? undefined : parseCliCommands(cli.commands, 'routes.cli.commands');
  return {
    ...(commands === undefined ? {} : { commands }),
    mode,
    routes,
  };
};

const parseProviders = (value: unknown): readonly ArtifactManifestProvider[] => {
  const providers = requireArray(value, 'routes.providers').map((candidate, index) => {
    const location = `routes.providers[${index}]`;
    const provider = requireRecord(candidate, location);
    requireExactKeys(provider, location, ['id', 'name', 'source']);
    return {
      id: requireString(provider.id, `${location}.id`),
      name: requireString(provider.name, `${location}.name`),
      source: requirePath(provider.source, `${location}.source`),
    } satisfies ArtifactManifestProvider;
  });
  requireSortedUnique(providers, 'routes.providers', (provider) => provider.id);
  return providers;
};

const parseLayouts = (value: unknown): readonly ArtifactManifestLayout[] => {
  const layouts = requireArray(value, 'routes.layouts').map((candidate, index) => {
    const location = `routes.layouts[${index}]`;
    const layout = requireRecord(candidate, location);
    requireExactKeys(layout, location, ['id', 'scope', 'source'], ['serverId']);
    const scope = requireOneOf(layout.scope, `${location}.scope`, layoutScopes);
    const serverId = layout.serverId === undefined ? undefined : requireString(layout.serverId, `${location}.serverId`);
    if ((scope === 'server') !== (serverId !== undefined)) {
      fail(`${location}.serverId is present exactly for server-scoped layouts.`);
    }
    return {
      id: requireString(layout.id, `${location}.id`),
      scope,
      ...(serverId === undefined ? {} : { serverId }),
      source: requirePath(layout.source, `${location}.source`),
    } satisfies ArtifactManifestLayout;
  });
  requireSortedUnique(layouts, 'routes.layouts', (layout) => layout.id);
  return layouts;
};

const parseContracts = (value: unknown): readonly ArtifactManifestRouteContract[] => {
  const contracts = requireArray(value, 'routes.contracts').map((candidate, index) => {
    const location = `routes.contracts[${index}]`;
    const contract = requireRecord(candidate, location);
    requireExactKeys(contract, location, ['id', 'input', 'origin', 'routes']);
    const origin = requireRecord(contract.origin, `${location}.origin`);
    requireExactKeys(origin, `${location}.origin`, ['binding', 'module']);
    const routes = parseStringList(contract.routes, `${location}.routes`);
    if (routes.length === 0) fail(`${location}.routes must name at least one route.`);
    return {
      id: requireString(contract.id, `${location}.id`),
      input: parseInputSchema(contract.input, `${location}.input`),
      origin: {
        binding: requireString(origin.binding, `${location}.origin.binding`),
        module: requirePath(origin.module, `${location}.origin.module`),
      },
      routes,
    } satisfies ArtifactManifestRouteContract;
  });
  requireSortedUnique(contracts, 'routes.contracts', (contract) => contract.id);
  return contracts;
};

const parseRoutes = (value: unknown): ArtifactManifestRoutes => {
  const routes = requireRecord(value, 'routes');
  requireExactKeys(routes, 'routes', ['digest', 'events', 'layouts', 'providers', 'scripts', 'servers'], ['cli', 'contracts']);
  const events = parseRoutesList(routes.events, 'routes.events');
  if (events.some((route) => route.kind !== 'event-route')) fail('routes.events must hold event-route routes only.');
  const scripts = parseRoutesList(routes.scripts, 'routes.scripts');
  if (scripts.some((route) => route.kind !== 'script')) fail('routes.scripts must hold script routes only.');
  const servers = parseServers(routes.servers);
  const layouts = parseLayouts(routes.layouts);
  const providers = parseProviders(routes.providers);
  const providerKeys = new Set(providers.map((provider) => providerKeyFromName(provider.name)));
  for (const route of events) {
    for (const provider of route.execution?.providers ?? []) {
      if (!providerKeys.has(provider)) {
        fail(`routes.events[${route.id}].execution.providers names undeclared provider key ${JSON.stringify(provider)}.`);
      }
    }
  }
  const serverIds = new Set(servers.map((server) => server.id));
  if (layouts.some((layout) => layout.serverId !== undefined && !serverIds.has(layout.serverId))) {
    fail('routes.layouts names an undeclared server.');
  }
  const cli = routes.cli === undefined ? undefined : parseCli(routes.cli);
  const contracts = routes.contracts === undefined ? undefined : parseContracts(routes.contracts);
  // Every route's `contract` names a declared contract and every contract's
  // `routes` name declared routes; `contracts` is present exactly when a route
  // binds one, matching the compiler graph.
  const allRoutes = [...events, ...scripts, ...servers.flatMap((server) => server.routes), ...(cli?.routes ?? [])];
  const routeIds = new Set(allRoutes.map((route) => route.id));
  const contractIds = new Set((contracts ?? []).map((contract) => contract.id));
  const bound = allRoutes.filter((route) => route.contract !== undefined);
  if ((contracts !== undefined) !== (bound.length > 0)) {
    fail('routes.contracts is present exactly when a route binds a contract.');
  }
  for (const route of bound) {
    if (!contractIds.has(route.contract!)) fail(`routes route ${route.id} binds undeclared contract ${JSON.stringify(route.contract)}.`);
  }
  // The binding is reciprocal: a contract's `routes` are exactly the routes
  // whose `contract` names it (a projected CLI tool route repeats its server
  // route's id, so the comparison is over id sets).
  const boundByContract = new Map<string, Set<string>>();
  for (const route of bound) {
    const ids = boundByContract.get(route.contract!) ?? new Set<string>();
    ids.add(route.id);
    boundByContract.set(route.contract!, ids);
  }
  for (const contract of contracts ?? []) {
    for (const id of contract.routes) {
      if (!routeIds.has(id)) fail(`routes.contracts[${contract.id}].routes names undeclared route ${JSON.stringify(id)}.`);
    }
    const binding = boundByContract.get(contract.id) ?? new Set<string>();
    if (binding.size !== contract.routes.length || contract.routes.some((id) => !binding.has(id))) {
      fail(`routes.contracts[${contract.id}].routes must be exactly the routes whose contract names it.`);
    }
  }
  return {
    ...(cli === undefined ? {} : { cli }),
    ...(contracts === undefined ? {} : { contracts }),
    digest: requireHash(routes.digest, 'routes.digest'),
    events,
    layouts,
    providers,
    scripts,
    servers,
  };
};

const parseHosts = (value: unknown, location: string, hosts: ReadonlySet<string>): readonly string[] => {
  const list = parseStringList(value, location);
  if (list.length === 0) fail(`${location} must name at least one host.`);
  for (const host of list) {
    if (!hosts.has(host)) fail(`${location} names undeclared projection ${JSON.stringify(host)}.`);
  }
  return list;
};

const parseBins = (value: unknown, hosts: ReadonlySet<string>): readonly ArtifactManifestBin[] => {
  const bins = requireArray(value, 'executables.bins').map((candidate, index) => {
    const location = `executables.bins[${index}]`;
    const bin = requireRecord(candidate, location);
    requireExactKeys(bin, location, ['hosts', 'name', 'path'], ['worker']);
    return {
      hosts: parseHosts(bin.hosts, `${location}.hosts`, hosts),
      name: requireString(bin.name, `${location}.name`),
      path: requirePath(bin.path, `${location}.path`),
      ...(bin.worker === undefined ? {} : { worker: requirePath(bin.worker, `${location}.worker`) }),
    } satisfies ArtifactManifestBin;
  });
  requireSortedUnique(bins, 'executables.bins', (bin) => bin.name);
  return bins;
};

/** Orders hook rows by their explicit `(host, id)` tuple. */
export const compareArtifactManifestHooks = (
  left: Pick<ArtifactManifestHook, 'host' | 'id'>,
  right: Pick<ArtifactManifestHook, 'host' | 'id'>,
): number => left.host === right.host
  ? left.id.localeCompare(right.id)
  : left.host.localeCompare(right.host);

const parseHooks = (value: unknown, hosts: ReadonlySet<string>): readonly ArtifactManifestHook[] => {
  const hooks = requireArray(value, 'executables.hooks').map((candidate, index) => {
    const location = `executables.hooks[${index}]`;
    const hook = requireRecord(candidate, location);
    requireExactKeys(hook, location, ['event', 'host', 'id', 'kind', 'name', 'path'], ['routeId', 'timeout']);
    const host = requireString(hook.host, `${location}.host`);
    if (!hosts.has(host)) fail(`${location}.host names undeclared projection ${JSON.stringify(host)}.`);
    const kind = requireOneOf(hook.kind, `${location}.kind`, ['config', 'event-route'] as const);
    if ((kind === 'event-route') !== (hook.routeId !== undefined)) {
      fail(`${location}.routeId is present exactly for event-route hooks.`);
    }
    if (
      hook.timeout !== undefined &&
      (!Number.isSafeInteger(hook.timeout) || (hook.timeout as number) <= 0)
    ) {
      fail(`${location}.timeout must be a positive safe integer.`);
    }
    return {
      event: requireString(hook.event, `${location}.event`),
      host,
      id: requireString(hook.id, `${location}.id`),
      kind,
      name: requireString(hook.name, `${location}.name`),
      path: requirePath(hook.path, `${location}.path`),
      ...(hook.routeId === undefined ? {} : { routeId: requireString(hook.routeId, `${location}.routeId`) }),
      ...(hook.timeout === undefined ? {} : { timeout: hook.timeout as number }),
    } satisfies ArtifactManifestHook;
  });
  for (let index = 1; index < hooks.length; index += 1) {
    if (compareArtifactManifestHooks(hooks[index - 1]!, hooks[index]!) >= 0) {
      fail('executables.hooks must be sorted by host and id with no duplicate entries.');
    }
  }
  return hooks;
};

const parseMcpApps = (value: unknown, location: string): readonly ArtifactManifestMcpApp[] => {
  const apps = requireArray(value, location).map((candidate, index) => {
    const appLocation = `${location}[${index}]`;
    const app = requireRecord(candidate, appLocation);
    requireExactKeys(app, appLocation, ['id', 'name', 'resourceUri'], ['path', 'prebuilt']);
    if (app.prebuilt !== undefined && app.prebuilt !== true) fail(`${appLocation}.prebuilt must be true when present.`);
    if ((app.prebuilt === true) === (app.path !== undefined)) {
      fail(`${appLocation} carries a path exactly when it is not prebuilt.`);
    }
    return {
      id: requireString(app.id, `${appLocation}.id`),
      name: requireString(app.name, `${appLocation}.name`),
      ...(app.path === undefined ? {} : { path: requirePath(app.path, `${appLocation}.path`) }),
      ...(app.prebuilt === true ? { prebuilt: true as const } : {}),
      resourceUri: requireString(app.resourceUri, `${appLocation}.resourceUri`),
    } satisfies ArtifactManifestMcpApp;
  });
  requireSortedUnique(apps, location, (app) => app.id);
  return apps;
};

const parseMcpServers = (
  value: unknown,
  hosts: ReadonlySet<string>,
  launches: ReadonlyMap<string, ArtifactManifestLaunch>,
): readonly ArtifactManifestMcpServer[] => {
  const servers = requireArray(value, 'executables.mcpServers').map((candidate, index) => {
    const location = `executables.mcpServers[${index}]`;
    const server = requireRecord(candidate, location);
    requireExactKeys(server, location, ['apps', 'hosts', 'id', 'kind', 'name', 'transport'], ['launch']);
    const name = requireString(server.name, `${location}.name`);
    const launch = launches.get(name);
    return {
      apps: parseMcpApps(server.apps, `${location}.apps`),
      hosts: parseHosts(server.hosts, `${location}.hosts`, hosts),
      id: requireString(server.id, `${location}.id`),
      kind: requireOneOf(server.kind, `${location}.kind`, mcpServerKinds),
      ...(launch === undefined ? {} : { launch }),
      name,
      transport: requireString(server.transport, `${location}.transport`),
    } satisfies ArtifactManifestMcpServer;
  });
  requireSortedUnique(servers, 'executables.mcpServers', (server) => server.id);
  return servers;
};

const parseScripts = (value: unknown, hosts: ReadonlySet<string>): readonly ArtifactManifestScript[] => {
  const scripts = requireArray(value, 'executables.scripts').map((candidate, index) => {
    const location = `executables.scripts[${index}]`;
    const script = requireRecord(candidate, location);
    requireExactKeys(script, location, ['hosts', 'id', 'mode', 'name', 'path'], ['rendered', 'worker']);
    let rendered: ArtifactManifestScriptRendered | undefined;
    if (script.rendered !== undefined) {
      const record = requireRecord(script.rendered, `${location}.rendered`);
      requireExactKeys(record, `${location}.rendered`, ['routeId']);
      rendered = { routeId: requireString(record.routeId, `${location}.rendered.routeId`) };
    }
    return {
      hosts: parseHosts(script.hosts, `${location}.hosts`, hosts),
      id: requireString(script.id, `${location}.id`),
      mode: requireOneOf(script.mode, `${location}.mode`, ['bundle', 'copy'] as const),
      name: requireString(script.name, `${location}.name`),
      path: requirePath(script.path, `${location}.path`),
      ...(rendered === undefined ? {} : { rendered }),
      ...(script.worker === undefined ? {} : { worker: requirePath(script.worker, `${location}.worker`) }),
    } satisfies ArtifactManifestScript;
  });
  requireSortedUnique(scripts, 'executables.scripts', (script) => script.id);
  return scripts;
};

const parseExecutables = (value: unknown, hosts: ReadonlySet<string>): ArtifactManifestExecutables => {
  const executables = requireRecord(value, 'executables');
  requireExactKeys(executables, 'executables', ['bins', 'hooks', 'mcpServers', 'scripts']);
  return {
    bins: parseBins(executables.bins, hosts),
    hooks: parseHooks(executables.hooks, hosts),
    mcpServers: parseMcpServers(executables.mcpServers, hosts, parseServerLaunches(executables)),
    scripts: parseScripts(executables.scripts, hosts),
  };
};

const parsePayloads = (value: unknown, hosts: ReadonlySet<string>): readonly ArtifactManifestPayload[] => {
  const payloads = requireArray(value, 'distribution.payloads').map((candidate, index) => {
    const location = `distribution.payloads[${index}]`;
    const payload = requireRecord(candidate, location);
    requireExactKeys(payload, location, ['hosts', 'name', 'runtimeDependencies']);
    const name = requireString(payload.name, `${location}.name`);
    if (!isRelocatablePosixPath(name) || name.includes('/')) {
      fail(`${location}.name must be a single artifact-root directory name.`);
    }
    return {
      hosts: parseHosts(payload.hosts, `${location}.hosts`, hosts),
      name,
      runtimeDependencies: parseStringList(payload.runtimeDependencies, `${location}.runtimeDependencies`),
    } satisfies ArtifactManifestPayload;
  });
  requireSortedUnique(payloads, 'distribution.payloads', (payload) => payload.name);
  return payloads;
};

const parseDistribution = (value: unknown, hosts: ReadonlySet<string>): ArtifactManifestDistribution => {
  const distribution = requireRecord(value, 'distribution');
  requireExactKeys(distribution, 'distribution', ['channels', 'payloads'], ['install']);
  const channels = requireArray(distribution.channels, 'distribution.channels')
    .map((channel, index) => requireOneOf(channel, `distribution.channels[${index}]`, distributionChannels));
  requireSortedUnique(channels, 'distribution.channels', (channel) => channel);
  if (!channels.includes('local')) fail('distribution.channels must include "local".');
  let install: ArtifactManifestDistributionInstall | undefined;
  if (distribution.install !== undefined) {
    const record = requireRecord(distribution.install, 'distribution.install');
    requireExactKeys(record, 'distribution.install', [], ['instructions', 'script']);
    install = {
      ...(record.instructions === undefined ? {} : { instructions: requirePath(record.instructions, 'distribution.install.instructions') }),
      ...(record.script === undefined ? {} : { script: requirePath(record.script, 'distribution.install.script') }),
    };
    if (install.instructions === undefined && install.script === undefined) {
      fail('distribution.install must name at least one pointer.');
    }
  }
  return {
    channels,
    ...(install === undefined ? {} : { install }),
    payloads: parsePayloads(distribution.payloads, hosts),
  };
};

const parseValidation = (value: unknown): ArtifactManifestValidation => {
  const validation = requireRecord(value, 'compiler.validation');
  requireExactKeys(validation, 'compiler.validation', ['artifact', 'projections', 'source']);
  const projections = requireArray(validation.projections, 'compiler.validation.projections').map((candidate, index) => {
    const projection = requireRecord(candidate, `compiler.validation.projections[${index}]`);
    requireExactKeys(projection, `compiler.validation.projections[${index}]`, ['host', 'status']);
    const status = requireStatus({ status: projection.status }, `compiler.validation.projections[${index}]`);
    return {
      host: requireString(projection.host, `compiler.validation.projections[${index}].host`),
      status: status.status,
    } satisfies ArtifactManifestProjectionValidation;
  });
  requireSortedUnique(projections, 'compiler.validation.projections', (projection) => projection.host);
  return {
    artifact: requireStatus(validation.artifact, 'compiler.validation.artifact'),
    projections,
    source: requireStatus(validation.source, 'compiler.validation.source'),
  };
};

const parseRuntime = (value: unknown): ArtifactManifestRuntime => {
  const runtime = requireRecord(value, 'runtime');
  requireExactKeys(runtime, 'runtime', ['node']);
  const node = requireString(runtime.node, 'runtime.node');
  const version = parseRuntimeVersion(node);
  if (version === undefined) {
    return fail('runtime.node must be a canonical major.minor.patch version.');
  }
  if (formatRuntimeVersion(version) !== node) {
    fail('runtime.node must be a canonical major.minor.patch version.');
  }
  if (!satisfiesGeneratedRuntimeFloor(version)) {
    fail('runtime.node must satisfy the generated runtime floor.');
  }
  return { node };
};

/** Every root-relative file a manifest section points at, with its location for the failure message. */
const referencedPaths = (manifest: {
  readonly distribution: ArtifactManifestDistribution;
  readonly executables: ArtifactManifestExecutables;
  readonly projections: readonly ArtifactManifestProjection[];
}): readonly (readonly [string, string])[] => {
  const references: (readonly [string, string])[] = [];
  const reference = (location: string, path: string | undefined): void => {
    if (path !== undefined) references.push([location, path]);
  };
  for (const projection of manifest.projections) {
    const location = `projections[${projection.host}].documents`;
    reference(`${location}.plugin`, projection.documents.plugin);
    reference(`${location}.marketplace`, projection.documents.marketplace);
    reference(`${location}.mcp`, projection.documents.mcp);
    reference(`${location}.hooks`, projection.documents.hooks);
  }
  for (const bin of manifest.executables.bins) {
    reference(`executables.bins[${bin.name}].path`, bin.path);
    reference(`executables.bins[${bin.name}].worker`, bin.worker);
  }
  for (const hook of manifest.executables.hooks) {
    reference(`executables.hooks[${hook.host}/${hook.id}].path`, hook.path);
  }
  // Launch entries, workers, and artifact arguments are checked by `requireLaunchFiles`.
  for (const server of manifest.executables.mcpServers) {
    for (const app of server.apps) {
      reference(`executables.mcpServers[${server.id}].apps[${app.id}].path`, app.path);
    }
  }
  for (const script of manifest.executables.scripts) {
    reference(`executables.scripts[${script.id}].path`, script.path);
    reference(`executables.scripts[${script.id}].worker`, script.worker);
  }
  reference('distribution.install.instructions', manifest.distribution.install?.instructions);
  reference('distribution.install.script', manifest.distribution.install?.script);
  return references;
};

const launchesOf = (servers: readonly ArtifactManifestMcpServer[]): ReadonlyMap<string, ArtifactManifestLaunch> =>
  new Map(servers.flatMap((server) => server.launch === undefined ? [] : [[server.name, server.launch] as const]));

const parseWeb = (value: unknown, servers: readonly ArtifactManifestMcpServer[]): WebManifest | undefined => {
  if (value === undefined) return undefined;
  const web = parseWebManifest(value);
  requireLaunchReferences(web, launchesOf(servers));
  return web;
};

const requireExactSortedKeys = (
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void => {
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(message);
  }
};

const parseCompiler = (value: unknown, files: readonly ArtifactManifestFile[]): ArtifactManifestCompiler => {
  const compiler = requireRecord(value, 'compiler');
  requireExactKeys(compiler, 'compiler', [
    'adapters',
    'agentSkills',
    'producer',
    'project',
    'provenance',
    'recordVersion',
    'validation',
  ]);
  if (compiler.recordVersion !== artifactCompilerRecordVersion) {
    fail(`compiler.recordVersion must be ${artifactCompilerRecordVersion}.`);
  }

  const agentSkills = requireRecord(compiler.agentSkills, 'compiler.agentSkills');
  requireExactKeys(agentSkills, 'compiler.agentSkills', ['schemaSha256', 'sourceRevision', 'specification']);

  const producer = requireRecord(compiler.producer, 'compiler.producer');
  requireExactKeys(producer, 'compiler.producer', ['name', 'version']);
  if (producer.name !== 'agent-bundle') fail('compiler.producer.name must be "agent-bundle".');

  const project = requireRecord(compiler.project, 'compiler.project');
  requireExactKeys(
    project,
    'compiler.project',
    ['configDigest', 'configPath', 'modelDigest', 'revision', 'sourceInputs'],
    ['packageName', 'packageVersion'],
  );
  const packageName = project.packageName === undefined
    ? undefined
    : requireString(project.packageName, 'compiler.project.packageName');
  if (packageName !== undefined && !isValidPackageName(packageName)) {
    fail('compiler.project.packageName must be a valid npm package name.');
  }
  const packageVersion = project.packageVersion === undefined
    ? undefined
    : requireString(project.packageVersion, 'compiler.project.packageVersion');
  if (packageVersion !== undefined && !isValidPackageVersion(packageVersion)) {
    fail('compiler.project.packageVersion must be a valid semantic version.');
  }
  const sourceInputs = parseSourceInputs(project.sourceInputs, 'compiler.project.sourceInputs');
  const configPath = requirePath(project.configPath, 'compiler.project.configPath');
  const configDigest = requireHash(project.configDigest, 'compiler.project.configDigest');
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined || configInput.sha256 !== configDigest) {
    fail('compiler.project.configDigest must equal the declared configPath source input hash.');
  }
  const revision = requireHash(project.revision, 'compiler.project.revision');
  if (revision !== digest({ inputs: sourceInputs })) {
    fail('compiler.project.revision does not match compiler.project.sourceInputs.');
  }

  const provenance = parseProvenance(compiler.provenance);
  requireExactSortedKeys(
    provenance.map((entry) => entry.path),
    files.map((file) => file.path),
    'compiler.provenance paths must exactly match files.',
  );
  const projectInputPaths = new Set(sourceInputs.map((input) => input.path));
  for (const entry of provenance) {
    for (const sourceInput of entry.sourceInputs) {
      if (!projectInputPaths.has(sourceInput)) {
        fail(`compiler.provenance[${entry.path}].sourceInputs contains an undeclared project source input.`);
      }
    }
  }

  return {
    adapters: parseCompilerAdapters(compiler.adapters),
    agentSkills: {
      schemaSha256: requireHash(agentSkills.schemaSha256, 'compiler.agentSkills.schemaSha256'),
      sourceRevision: requireString(agentSkills.sourceRevision, 'compiler.agentSkills.sourceRevision'),
      specification: requireString(agentSkills.specification, 'compiler.agentSkills.specification'),
    },
    producer: {
      name: 'agent-bundle',
      version: requireString(producer.version, 'compiler.producer.version'),
    },
    project: {
      configDigest,
      configPath,
      modelDigest: requireHash(project.modelDigest, 'compiler.project.modelDigest'),
      ...(packageName === undefined ? {} : { packageName }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
      revision,
      sourceInputs,
    },
    provenance,
    recordVersion: artifactCompilerRecordVersion,
    validation: parseValidation(compiler.validation),
  };
};

const validateManifest = (value: unknown): ArtifactManifest => {
  const manifest = requireRecord(value, 'root');
  requireExactKeys(manifest, 'root', [
    'application',
    'compiler',
    'distribution',
    'executables',
    'files',
    'manifestVersion',
    'projections',
    'routes',
    'runtime',
  ], ['web']);
  requireManifestVersion(manifest);

  const files = parseFiles(manifest.files);
  const compiler = parseCompiler(manifest.compiler, files);
  const application = parseApplication(manifest.application);
  const projections = parseProjections(manifest.projections);
  const hostList = parseProjectionHosts(manifest.projections);
  const hosts = new Set(hostList);
  requireExactSortedKeys(
    compiler.adapters.map((adapter) => adapter.host),
    hostList,
    'compiler.adapters hosts must exactly match projections.',
  );
  requireExactSortedKeys(
    compiler.validation.projections.map((projection) => projection.host),
    hostList,
    'compiler.validation.projections hosts must exactly match projections.',
  );
  const routes = parseRoutes(manifest.routes);
  const executables = parseExecutables(manifest.executables, hosts);
  const distribution = parseDistribution(manifest.distribution, hosts);
  const scriptRouteIds = new Set(routes.scripts.map((route) => route.id));
  for (const script of executables.scripts) {
    if (script.rendered !== undefined && !scriptRouteIds.has(script.rendered.routeId)) {
      fail(`executables.scripts[${script.id}].rendered.routeId names an undeclared script route.`);
    }
  }
  const eventRouteIds = new Set(routes.events.map((route) => route.id));
  for (const hook of executables.hooks) {
    if (hook.routeId !== undefined && !eventRouteIds.has(hook.routeId)) {
      fail(`executables.hooks[${hook.host}/${hook.id}].routeId names an undeclared event route.`);
    }
  }
  const cliRouteIds = new Set(routes.cli?.routes.map((route) => route.id) ?? []);
  for (const command of routes.cli?.commands ?? []) {
    if (!cliRouteIds.has(command.routeId)) {
      fail(`routes.cli.commands[${command.path.join(' ')}].routeId names an undeclared CLI route.`);
    }
  }
  if (distribution.channels.includes('npm') !== (compiler.project.packageName !== undefined)) {
    fail('distribution.channels lists "npm" exactly when compiler.project.packageName is present.');
  }
  const web = parseWeb(manifest.web, executables.mcpServers);
  const filePaths = new Set(files.map((file) => file.path));
  for (const [index, payload] of distribution.payloads.entries()) {
    const prefix = `${payload.name}/`;
    if (!files.some((file) => file.kind === 'prebuilt' && file.path.startsWith(prefix))) {
      fail(`distribution.payloads[${index}].name names a directory with no prebuilt manifest file.`);
    }
  }
  for (const [location, path] of referencedPaths({ distribution, executables, projections })) {
    if (!filePaths.has(path)) fail(`${location} names ${JSON.stringify(path)}, which is not a manifest file.`);
  }
  requireLaunchFiles(launchesOf(executables.mcpServers), filePaths);

  return {
    application,
    compiler,
    distribution,
    executables,
    files,
    manifestVersion: artifactManifestVersion,
    projections,
    routes,
    runtime: parseRuntime(manifest.runtime),
    ...(web === undefined ? {} : { web }),
  };
};

const freezeDeep = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeDeep);
  }
  return Object.freeze(value);
};

const isDuplicateJsonKeyError = (error: unknown): boolean =>
  error instanceof SyntaxError && error.message.startsWith('JSON has duplicate key ');

const manifestJsonSyntaxError = (message: string): SyntaxError =>
  new SyntaxError(message, { cause: new SyntaxError('Artifact manifest JSON parsing failed.') });

export const parseArtifactManifest = (bytes: string): ArtifactManifest => {
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(bytes);
  } catch (error) {
    if (isDuplicateJsonKeyError(error)) {
      throw manifestJsonSyntaxError('Artifact manifest contains a duplicate JSON key.');
    }
    throw manifestJsonSyntaxError('Artifact manifest is not valid JSON.');
  }
  const manifest = validateManifest(value);
  if (bytes !== `${stableJson(manifest)}\n`) {
    fail('bytes are not canonical.');
  }
  return freezeDeep(manifest);
};

/**
 * Serializes a valid manifest. Caller arrays must already be sorted and unique;
 * this function validates rather than reordering them.
 */
export const serializeArtifactManifest = (manifest: ArtifactManifest): string => {
  const validated = validateManifest(manifest);
  return `${stableJson(validated)}\n`;
};

export const assembleArtifactManifest = (manifest: ArtifactManifest): AssembledArtifactManifest => {
  const bytes = serializeArtifactManifest(manifest);
  return Object.freeze({ bytes, manifest: parseArtifactManifest(bytes) });
};
