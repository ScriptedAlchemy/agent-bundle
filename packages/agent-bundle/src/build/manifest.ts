import { digest, stableJson } from '../core/digest.ts';
import {
  formatRuntimeVersion,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { isValidPackageName, isValidPackageVersion } from '../core/project-context.ts';
import { isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
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
 * byte-identical to its own serialization. `manifestVersion` bumps on a
 * rename or removal; an added optional key does not.
 */

export const artifactManifestName = 'agent-bundle.manifest.json';
export const artifactManifestVersion = 2;

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
 * `doctor`, and `uninstall` act on. Every host `plugin.json` repeats `name`
 * and `version` for its host, and the artifact validator proves they agree
 * (`AB6040`).
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
export interface ArtifactManifestProjection {
  readonly adapterRevision: string;
  readonly documents: ArtifactManifestProjectionDocuments;
  readonly host: string;
  /** The marketplace the projection's marketplace document registers; absent when none was emitted. */
  readonly marketplace?: ArtifactManifestProjectionMarketplace;
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

/** One compiled route of the Application IR, host-independent. */
export interface ArtifactManifestRoute {
  /** `config.description` when it is a string. */
  readonly description?: string;
  /** Canonical event identity; `event-route` routes only. */
  readonly event?: string;
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

/** One executable command compiled from a custom CLI route or projected MCP tool. */
export interface ArtifactManifestCliCommand {
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly exitCode: 'result' | 'zero';
  readonly mcp?: ArtifactManifestCliCommandMcp;
  readonly options: readonly ArtifactManifestCliOption[];
  readonly path: readonly string[];
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
export interface ArtifactManifestRoutes {
  readonly cli?: ArtifactManifestCli;
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

export interface ArtifactManifestMcpEntry {
  readonly path: string;
  readonly worker?: string;
}

/**
 * One MCP server the artifact declares: `compiled` servers have an `entry`
 * the artifact starts, `command` servers name a host-run command, `remote`
 * servers a URL — both live only in the host MCP documents.
 */
export interface ArtifactManifestMcpServer {
  readonly apps: readonly ArtifactManifestMcpApp[];
  readonly entry?: ArtifactManifestMcpEntry;
  readonly hosts: readonly string[];
  readonly id: string;
  readonly kind: 'command' | 'compiled' | 'remote';
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

/** How the artifact reaches a host (gap 7 of #592 step 3). */
export interface ArtifactManifestDistribution {
  /** `local` always; `npm` when the project carries a package identity. */
  readonly channels: readonly ArtifactManifestDistributionChannel[];
  readonly install?: ArtifactManifestDistributionInstall;
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

export interface ArtifactManifest {
  readonly agentSkills: ArtifactManifestAgentSkills;
  readonly application: ArtifactManifestApplication;
  readonly distribution: ArtifactManifestDistribution;
  readonly executables: ArtifactManifestExecutables;
  readonly files: readonly ArtifactManifestFile[];
  readonly manifestVersion: typeof artifactManifestVersion;
  readonly producer: ArtifactManifestProducer;
  readonly project: ArtifactManifestProject;
  readonly projections: readonly ArtifactManifestProjection[];
  readonly routes: ArtifactManifestRoutes;
  readonly runtime: ArtifactManifestRuntime;
  readonly validation: ArtifactManifestValidation;
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
  const segments = path.split('/');
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${location} must be a safe relative POSIX path.`);
  }
  return path;
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

const parseFileSourceInputs = (value: unknown, location: string): readonly string[] => {
  const sourceInputs = requireArray(value, location).map((input, index) =>
    requirePath(input, `${location}[${index}]`));
  requireSortedUnique(sourceInputs, location, (input) => input);
  return sourceInputs;
};

const parseFiles = (value: unknown): readonly ArtifactManifestFile[] => {
  const files = requireArray(value, 'files').map((candidate, index) => {
    const file = requireRecord(candidate, `files[${index}]`);
    requireExactKeys(file, `files[${index}]`, ['bytes', 'kind', 'path', 'sha256', 'sourceInputs'], ['mode']);
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
    return {
      bytes: file.bytes as number,
      kind: file.kind as ArtifactManifestFileKind,
      ...(file.mode === undefined ? {} : { mode: file.mode as number }),
      path,
      sha256: requireHash(file.sha256, `files[${index}].sha256`),
      sourceInputs: parseFileSourceInputs(file.sourceInputs, `files[${index}].sourceInputs`),
    } satisfies ArtifactManifestFile;
  });
  requireSortedUnique(files, 'files', (file) => file.path);
  return files;
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
      ['adapterRevision', 'documents', 'host', 'observedVersion', 'schemas'],
      ['marketplace'],
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
      adapterRevision: requireString(projection.adapterRevision, `${location}.adapterRevision`),
      documents,
      host: requireString(projection.host, `${location}.host`),
      ...(marketplace === undefined ? {} : { marketplace }),
      observedVersion: requireString(projection.observedVersion, `${location}.observedVersion`),
      schemas: parseProjectionSchemas(projection.schemas, `${location}.schemas`),
    } satisfies ArtifactManifestProjection;
  });
  requireSortedUnique(projections, 'projections', (projection) => projection.host);
  return projections;
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

const parseRoute = (value: unknown, location: string): ArtifactManifestRoute => {
  const route = requireRecord(value, location);
  requireExactKeys(
    route,
    location,
    ['id', 'kind', 'provenance', 'source'],
    ['description', 'event', 'inputSchema', 'serverId'],
  );
  const provenance = requireRecord(route.provenance, `${location}.provenance`);
  requireExactKeys(provenance, `${location}.provenance`, ['kind']);
  if (provenance.kind !== 'conventional') fail(`${location}.provenance.kind must be "conventional".`);
  const kind = requireOneOf(route.kind, `${location}.kind`, routeKinds);
  const event = route.event === undefined ? undefined : requireString(route.event, `${location}.event`);
  if ((kind === 'event-route') !== (event !== undefined)) {
    fail(`${location}.event is present exactly for event-route routes.`);
  }
  const serverId = route.serverId === undefined ? undefined : requireString(route.serverId, `${location}.serverId`);
  const isMcpKind = kind === 'app' || kind === 'prompt' || kind === 'resource' || kind === 'tool';
  if (isMcpKind !== (serverId !== undefined)) {
    fail(`${location}.serverId is present exactly for MCP route kinds.`);
  }
  return {
    ...(route.description === undefined ? {} : { description: requireString(route.description, `${location}.description`) }),
    ...(event === undefined ? {} : { event }),
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
      ['choices', 'description', 'positional'],
    );
    if (
      option.positional !== undefined &&
      (!Number.isSafeInteger(option.positional) || (option.positional as number) < 0)
    ) {
      fail(`${optionLocation}.positional must be a non-negative safe integer.`);
    }
    return {
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

const parseCliCommands = (value: unknown, location: string): readonly ArtifactManifestCliCommand[] => {
  const commands = requireArray(value, location).map((candidate, index) => {
    const commandLocation = `${location}[${index}]`;
    const command = requireRecord(candidate, commandLocation);
    requireExactKeys(
      command,
      commandLocation,
      ['aliases', 'exitCode', 'options', 'path', 'routeId'],
      ['description', 'mcp'],
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

const parseRoutes = (value: unknown): ArtifactManifestRoutes => {
  const routes = requireRecord(value, 'routes');
  requireExactKeys(routes, 'routes', ['digest', 'events', 'layouts', 'providers', 'scripts', 'servers'], ['cli']);
  const events = parseRoutesList(routes.events, 'routes.events');
  if (events.some((route) => route.kind !== 'event-route')) fail('routes.events must hold event-route routes only.');
  const scripts = parseRoutesList(routes.scripts, 'routes.scripts');
  if (scripts.some((route) => route.kind !== 'script')) fail('routes.scripts must hold script routes only.');
  const servers = parseServers(routes.servers);
  const layouts = parseLayouts(routes.layouts);
  const serverIds = new Set(servers.map((server) => server.id));
  if (layouts.some((layout) => layout.serverId !== undefined && !serverIds.has(layout.serverId))) {
    fail('routes.layouts names an undeclared server.');
  }
  return {
    ...(routes.cli === undefined ? {} : { cli: parseCli(routes.cli) }),
    digest: requireHash(routes.digest, 'routes.digest'),
    events,
    layouts,
    providers: parseProviders(routes.providers),
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

const parseMcpServers = (value: unknown, hosts: ReadonlySet<string>): readonly ArtifactManifestMcpServer[] => {
  const servers = requireArray(value, 'executables.mcpServers').map((candidate, index) => {
    const location = `executables.mcpServers[${index}]`;
    const server = requireRecord(candidate, location);
    requireExactKeys(server, location, ['apps', 'hosts', 'id', 'kind', 'name', 'transport'], ['entry']);
    const kind = requireOneOf(server.kind, `${location}.kind`, ['command', 'compiled', 'remote'] as const);
    if ((kind === 'compiled') !== (server.entry !== undefined)) {
      fail(`${location}.entry is present exactly for compiled servers.`);
    }
    let entry: ArtifactManifestMcpEntry | undefined;
    if (server.entry !== undefined) {
      const record = requireRecord(server.entry, `${location}.entry`);
      requireExactKeys(record, `${location}.entry`, ['path'], ['worker']);
      entry = {
        path: requirePath(record.path, `${location}.entry.path`),
        ...(record.worker === undefined ? {} : { worker: requirePath(record.worker, `${location}.entry.worker`) }),
      };
    }
    return {
      apps: parseMcpApps(server.apps, `${location}.apps`),
      ...(entry === undefined ? {} : { entry }),
      hosts: parseHosts(server.hosts, `${location}.hosts`, hosts),
      id: requireString(server.id, `${location}.id`),
      kind,
      name: requireString(server.name, `${location}.name`),
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
    mcpServers: parseMcpServers(executables.mcpServers, hosts),
    scripts: parseScripts(executables.scripts, hosts),
  };
};

const parseDistribution = (value: unknown): ArtifactManifestDistribution => {
  const distribution = requireRecord(value, 'distribution');
  requireExactKeys(distribution, 'distribution', ['channels'], ['install']);
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
  };
};

const parseValidation = (value: unknown): ArtifactManifestValidation => {
  const validation = requireRecord(value, 'validation');
  requireExactKeys(validation, 'validation', ['artifact', 'projections', 'source']);
  const projections = requireArray(validation.projections, 'validation.projections').map((candidate, index) => {
    const projection = requireRecord(candidate, `validation.projections[${index}]`);
    requireExactKeys(projection, `validation.projections[${index}]`, ['host', 'status']);
    const status = requireStatus({ status: projection.status }, `validation.projections[${index}]`);
    return {
      host: requireString(projection.host, `validation.projections[${index}].host`),
      status: status.status,
    } satisfies ArtifactManifestProjectionValidation;
  });
  requireSortedUnique(projections, 'validation.projections', (projection) => projection.host);
  return {
    artifact: requireStatus(validation.artifact, 'validation.artifact'),
    projections,
    source: requireStatus(validation.source, 'validation.source'),
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

/** Every root-relative path a manifest section points at, with its location for the failure message. */
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
  for (const server of manifest.executables.mcpServers) {
    reference(`executables.mcpServers[${server.id}].entry.path`, server.entry?.path);
    reference(`executables.mcpServers[${server.id}].entry.worker`, server.entry?.worker);
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

const validateManifest = (value: unknown): ArtifactManifest => {
  const manifest = requireRecord(value, 'root');
  requireExactKeys(manifest, 'root', [
    'agentSkills',
    'application',
    'distribution',
    'executables',
    'files',
    'manifestVersion',
    'producer',
    'project',
    'projections',
    'routes',
    'runtime',
    'validation',
  ]);
  if (manifest.manifestVersion !== artifactManifestVersion) {
    fail(`manifestVersion must be ${artifactManifestVersion}.`);
  }

  const agentSkills = requireRecord(manifest.agentSkills, 'agentSkills');
  requireExactKeys(agentSkills, 'agentSkills', ['schemaSha256', 'sourceRevision', 'specification']);

  const producer = requireRecord(manifest.producer, 'producer');
  requireExactKeys(producer, 'producer', ['name', 'version']);
  if (producer.name !== 'agent-bundle') fail('producer.name must be "agent-bundle".');

  const project = requireRecord(manifest.project, 'project');
  requireExactKeys(
    project,
    'project',
    ['configDigest', 'configPath', 'modelDigest', 'revision', 'sourceInputs'],
    ['packageName', 'packageVersion'],
  );
  const packageName = project.packageName === undefined
    ? undefined
    : requireString(project.packageName, 'project.packageName');
  if (packageName !== undefined && !isValidPackageName(packageName)) {
    fail('project.packageName must be a valid npm package name.');
  }
  const packageVersion = project.packageVersion === undefined
    ? undefined
    : requireString(project.packageVersion, 'project.packageVersion');
  if (packageVersion !== undefined && !isValidPackageVersion(packageVersion)) {
    fail('project.packageVersion must be a valid semantic version.');
  }
  const sourceInputs = parseSourceInputs(project.sourceInputs, 'project.sourceInputs');
  const configPath = requirePath(project.configPath, 'project.configPath');
  const configDigest = requireHash(project.configDigest, 'project.configDigest');
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined || configInput.sha256 !== configDigest) {
    fail('project.configDigest must equal the declared configPath source input hash.');
  }
  const revision = requireHash(project.revision, 'project.revision');
  if (revision !== digest({ inputs: sourceInputs })) fail('project.revision does not match project.sourceInputs.');

  const files = parseFiles(manifest.files);
  const projectInputPaths = new Set(sourceInputs.map((input) => input.path));
  for (const file of files) {
    for (const sourceInput of file.sourceInputs) {
      if (!projectInputPaths.has(sourceInput)) {
        fail(`files[${file.path}].sourceInputs contains an undeclared project source input.`);
      }
    }
  }

  const application = parseApplication(manifest.application);
  const projections = parseProjections(manifest.projections);
  const hosts = new Set(projections.map((projection) => projection.host));
  const routes = parseRoutes(manifest.routes);
  const executables = parseExecutables(manifest.executables, hosts);
  const distribution = parseDistribution(manifest.distribution);
  const validation = parseValidation(manifest.validation);
  const validationHosts = validation.projections.map((projection) => projection.host);
  if (
    validationHosts.length !== hosts.size ||
    [...hosts].some((host, index) => host !== validationHosts[index])
  ) {
    fail('validation.projections hosts must exactly match projections.');
  }
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
  if (distribution.channels.includes('npm') !== (packageName !== undefined)) {
    fail('distribution.channels lists "npm" exactly when project.packageName is present.');
  }
  const filePaths = new Set(files.map((file) => file.path));
  for (const [location, path] of referencedPaths({ distribution, executables, projections })) {
    if (!filePaths.has(path)) fail(`${location} names ${JSON.stringify(path)}, which is not a manifest file.`);
  }

  return {
    agentSkills: {
      schemaSha256: requireHash(agentSkills.schemaSha256, 'agentSkills.schemaSha256'),
      sourceRevision: requireString(agentSkills.sourceRevision, 'agentSkills.sourceRevision'),
      specification: requireString(agentSkills.specification, 'agentSkills.specification'),
    },
    application,
    distribution,
    executables,
    files,
    manifestVersion: artifactManifestVersion,
    producer: {
      name: 'agent-bundle',
      version: requireString(producer.version, 'producer.version'),
    },
    project: {
      configDigest,
      configPath,
      modelDigest: requireHash(project.modelDigest, 'project.modelDigest'),
      ...(packageName === undefined ? {} : { packageName }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
      revision,
      sourceInputs,
    },
    projections,
    routes,
    runtime: parseRuntime(manifest.runtime),
    validation,
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

/** The projection of one host, or undefined when the artifact was not built for it. */
export const projectionFor = (
  manifest: ArtifactManifest,
  host: string,
): ArtifactManifestProjection | undefined =>
  manifest.projections.find((projection) => projection.host === host);
