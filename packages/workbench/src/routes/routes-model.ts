import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type { JsonObject, JsonValue } from '../../../agent-bundle/src/contracts/runtime.ts';
import type {
  RouteManifest,
  RouteManifestCliCommand,
  RouteManifestConfigEntry,
  RouteManifestKind,
  RouteManifestRoute,
  RouteManifestServerMode,
  RouteManifestState,
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
} from '../../../agent-bundle/src/contracts/routes.ts';

/**
 * The catalog's freshness against the published build. `stale` means the dev
 * server has compiled newer source than the epoch the rest of the Workbench
 * is scoped to; the catalog stays readable and says so rather than vanishing.
 */
export type RouteCatalogState = 'current' | 'stale' | 'unavailable';

/** The catalog group kinds the compiled graph can populate, in navigation order. */
export const routeCatalogKinds = Object.freeze([
  'tool',
  'resource',
  'prompt',
  'app',
  'event-route',
  'cli',
  'script',
] as const satisfies readonly RouteManifestKind[]);

export interface RouteCatalogEntry {
  readonly command?: RouteManifestCliCommand;
  readonly config: readonly RouteManifestConfigEntry[];
  readonly contract?: {
    readonly id: string;
    readonly origin: {
      readonly binding: string;
      readonly module: string;
    };
    readonly sharedWith: readonly string[];
  };
  readonly description?: string;
  readonly event?: string;
  readonly id: string;
  readonly inputSchema?: RouteInputSchema;
  readonly kind: RouteManifestKind;
  readonly provenance: 'conventional';
  readonly source: string;
}

/**
 * One catalog section. MCP kinds carry the owning server; `cli` and `script`
 * are project-level surfaces, so their `server` stays undefined.
 */
export interface RouteCatalogGroup {
  readonly entries: readonly RouteCatalogEntry[];
  readonly kind: RouteManifestKind;
  readonly label: string;
  readonly mode?: string;
  readonly server?: string;
  readonly serverId?: string;
}

export interface RouteCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

/** One declared MCP server, including externally packaged surfaces with no manifest routes. */
export interface RouteCatalogServer {
  readonly id: string;
  readonly mode: RouteManifestServerMode;
  readonly name: string;
  readonly routeCount: number;
}

export interface RouteCatalog {
  readonly diagnostics: readonly Diagnostic[];
  readonly digest: string;
  readonly groups: readonly RouteCatalogGroup[];
  /** Present only when the catalog could not be read; `state` is `unavailable`. */
  readonly message?: string;
  readonly providers: readonly RouteCatalogProvider[];
  readonly routeCount: number;
  readonly servers: readonly RouteCatalogServer[];
  readonly sourceRevision?: string;
  readonly state: RouteCatalogState;
  readonly stateDefinition?: RouteManifestState;
}

export type RouteInputDraftValue = boolean | string | readonly (boolean | string)[];
export type RouteInputDraft = Readonly<Record<string, RouteInputDraftValue>>;
export type RouteInputArguments = JsonObject;

export interface RouteInputValidation {
  readonly arguments?: RouteInputArguments;
  readonly errors: Readonly<Record<string, string>>;
}

export interface RawRouteInputValidation {
  readonly arguments?: RouteInputArguments;
  readonly error?: string;
}

export interface RouteEditorState {
  readonly attempted: boolean;
  readonly arguments?: RouteInputArguments;
  readonly argv?: string;
  readonly draft: RouteInputDraft;
  readonly errors: Readonly<Record<string, string>>;
  readonly raw: string;
  readonly rawError?: string;
}

export interface McpToolPrefill {
  readonly arguments: RouteInputArguments;
  readonly serverName: string;
  readonly toolName: string;
}

/** Hash-navigation envelope used by the current main.tsx until L5 rewrites the shell. */
export interface McpToolPrefillNavigationState {
  readonly mcpToolPrefill: McpToolPrefill;
}

const kindLabels: Readonly<Record<RouteManifestKind, string>> = Object.freeze({
  app: 'MCP Apps',
  cli: 'CLI commands',
  'event-route': 'Event routes',
  prompt: 'Prompts',
  resource: 'Resources',
  script: 'Scripts',
  tool: 'Tools',
});

export const routeKindLabel = (kind: RouteManifestKind): string => kindLabels[kind];

const byId = (left: RouteCatalogEntry, right: RouteCatalogEntry): number => left.id.localeCompare(right.id);

type ManifestContract = NonNullable<RouteManifest['contracts']>[number];

const entryFor = (
  route: RouteManifestRoute,
  contracts: ReadonlyMap<string, ManifestContract>,
  command?: RouteManifestCliCommand,
): RouteCatalogEntry => {
  const contract = route.contract === undefined ? undefined : contracts.get(route.contract);
  return Object.freeze({
    ...(command === undefined ? {} : { command }),
    config: route.config,
    ...(contract === undefined ? {} : {
      contract: Object.freeze({
        id: contract.id,
        origin: Object.freeze({ ...contract.origin }),
        sharedWith: Object.freeze(contract.routes.filter((routeId) => routeId !== route.id)),
      }),
    }),
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.event === undefined ? {} : { event: route.event }),
    id: route.id,
    ...(route.inputSchema === undefined ? {} : { inputSchema: route.inputSchema }),
    kind: route.kind,
    provenance: route.provenance.kind,
    source: route.source,
  });
};

const groupFor = (
  kind: RouteManifestKind,
  entries: readonly RouteCatalogEntry[],
  server?: Readonly<{ id: string; mode: string; name: string }>,
): RouteCatalogGroup => Object.freeze({
  entries: Object.freeze([...entries].sort(byId)),
  kind,
  label: server === undefined ? kindLabels[kind] : `${server.name} · ${kindLabels[kind]}`,
  ...(server === undefined ? {} : { mode: server.mode, server: server.name, serverId: server.id }),
});

const serverGroups = (
  manifest: RouteManifest,
  contracts: ReadonlyMap<string, ManifestContract>,
): readonly RouteCatalogGroup[] =>
  [...manifest.servers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((server) => routeCatalogKinds
      .map((kind) => Object.freeze({
        entries: server.routes.filter((route) => route.kind === kind).map((route) => entryFor(route, contracts)),
        kind,
      }))
      .filter((group) => group.entries.length > 0)
      .map((group) => groupFor(group.kind, group.entries, { id: server.id, mode: server.mode, name: server.name })));

const cliGroups = (
  manifest: RouteManifest,
  contracts: ReadonlyMap<string, ManifestContract>,
): readonly RouteCatalogGroup[] => {
  const cli = manifest.cli;
  if (cli === undefined || cli.routes.length === 0) return [];
  const commands = new Map((cli.commands ?? []).map((command) => [command.routeId, command]));
  return [Object.freeze({
    entries: Object.freeze(cli.routes.map((route) => entryFor(route, contracts, commands.get(route.id))).sort(byId)),
    kind: 'cli' as const,
    label: kindLabels.cli,
    mode: cli.mode,
  })];
};

const projectGroups = (
  manifest: RouteManifest,
  contracts: ReadonlyMap<string, ManifestContract>,
): readonly RouteCatalogGroup[] => [
  ...(manifest.events.length === 0
    ? []
    : [groupFor('event-route', manifest.events.map((route) => entryFor(route, contracts)))]),
  ...cliGroups(manifest, contracts),
  ...(manifest.scripts.length === 0
    ? []
    : [groupFor('script', manifest.scripts.map((route) => entryFor(route, contracts)))]),
];

/**
 * Projects the compiled route manifest into the Workbench catalog. `epochSourceRevision`
 * is the published build's project revision: an unequal manifest revision is normal
 * mid-rebuild drift, reported as `stale` rather than an error.
 */
export const routeCatalogFor = (
  manifest: RouteManifest,
  epochSourceRevision?: string,
): RouteCatalog => {
  const contracts = new Map((manifest.contracts ?? []).map((contract) => [contract.id, contract]));
  const groups = Object.freeze([
    ...serverGroups(manifest, contracts),
    ...projectGroups(manifest, contracts),
  ]);
  return Object.freeze({
    diagnostics: manifest.diagnostics,
    digest: manifest.digest,
    groups,
    providers: Object.freeze([...manifest.providers]
      .map((provider) => Object.freeze({ id: provider.id, name: provider.name, source: provider.source }))
      .sort((left, right) => left.name.localeCompare(right.name))),
    routeCount: groups.reduce((total, group) => total + group.entries.length, 0),
    servers: Object.freeze([...manifest.servers]
      .map((server) => Object.freeze({ id: server.id, mode: server.mode, name: server.name, routeCount: server.routes.length }))
      .sort((left, right) => left.name.localeCompare(right.name))),
    sourceRevision: manifest.sourceRevision,
    state: epochSourceRevision === undefined || epochSourceRevision === manifest.sourceRevision ? 'current' : 'stale',
    ...(manifest.state === undefined ? {} : { stateDefinition: manifest.state }),
  });
};

export const unavailableRouteCatalog = (message: string): RouteCatalog => Object.freeze({
  diagnostics: Object.freeze([]),
  digest: '',
  groups: Object.freeze([]),
  message,
  providers: Object.freeze([]),
  routeCount: 0,
  servers: Object.freeze([]),
  state: 'unavailable',
});

/** True when the compiled graph itself declares this kind, whatever configuration adds beside it. */
export const routeCatalogHasKind = (catalog: RouteCatalog, kind: RouteManifestKind): boolean =>
  catalog.groups.some((group) => group.kind === kind && group.entries.length > 0);

export const routeCatalogServerCount = (catalog: RouteCatalog): number =>
  catalog.servers.length;

/**
 * An optional boolean without a schema default stays out of the draft: a
 * `false` initialization would submit `{ key: false }` where the author's
 * handler observes an omitted property, defeating optional semantics.
 */
const defaultDraftValue = (
  schema: RouteInputPropertySchema,
  required: boolean,
): RouteInputDraftValue | undefined => {
  if (schema.default !== undefined) {
    if (Array.isArray(schema.default)) {
      return Object.freeze(schema.default.map((value) => typeof value === 'boolean' ? value : String(value)));
    }
    return typeof schema.default === 'boolean' ? schema.default : String(schema.default);
  }
  if (schema.type === 'boolean') return required ? false : undefined;
  if (schema.type === 'array') return Object.freeze([]);
  return '';
};

export const createRouteInputDraft = (schema: RouteInputSchema): RouteInputDraft => {
  const required = new Set(schema.required ?? []);
  return Object.freeze(Object.fromEntries(
    Object.keys(schema.properties).sort().flatMap((key) => {
      const value = defaultDraftValue(schema.properties[key]!, required.has(key));
      return value === undefined ? [] : [[key, value] as const];
    }),
  ));
};

export const initialRouteEditorState = (schema?: RouteInputSchema): RouteEditorState => Object.freeze({
  attempted: false,
  draft: schema === undefined ? Object.freeze({}) : createRouteInputDraft(schema),
  errors: Object.freeze({}),
  raw: '{}',
});

export const routeInputLabel = (key: string): string => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ')
    .trim();
  return words.length === 0 ? key : `${words[0]!.toUpperCase()}${words.slice(1)}`;
};

const scalarArgument = (
  schema: RouteInputArrayItemSchema | Exclude<RouteInputPropertySchema, { readonly type: 'array' }>,
  value: RouteInputDraftValue | undefined,
): boolean | number | string | undefined => {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'number':
      return typeof value === 'string' && value.trim().length > 0 ? Number(value) : undefined;
    case 'string':
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    default: {
      const unreachable: never = schema;
      throw new TypeError(`Unhandled route input scalar ${String(unreachable)}.`);
    }
  }
};

const scalarError = (
  schema: RouteInputArrayItemSchema | Exclude<RouteInputPropertySchema, { readonly type: 'array' }>,
  value: RouteInputDraftValue | undefined,
  label: string,
): string | undefined => {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${label} must be true or false.`;
    case 'number':
      return typeof value !== 'string' || value.trim().length === 0 || !Number.isFinite(Number(value))
        ? `${label} must be a number.`
        : undefined;
    case 'string': {
      if (typeof value !== 'string' || value.length === 0) return `${label} is required.`;
      return schema.enum !== undefined && !schema.enum.includes(value)
        ? `${label} must be one of: ${schema.enum.join(', ')}.`
        : undefined;
    }
    default: {
      const unreachable: never = schema;
      throw new TypeError(`Unhandled route input scalar ${String(unreachable)}.`);
    }
  }
};

export const validateRouteInput = (
  schema: RouteInputSchema,
  draft: RouteInputDraft,
): RouteInputValidation => {
  const argumentsValue: Record<string, boolean | number | string | readonly (boolean | number | string)[]> = {};
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties).sort()) {
    const property = schema.properties[key]!;
    const value = draft[key];
    const label = routeInputLabel(key);
    if (property.type === 'array') {
      if (!Array.isArray(value)) {
        if (required.has(key)) errors[key] = `${label} is required.`;
        continue;
      }
      if (value.length === 0) {
        if (required.has(key)) errors[key] = `${label} is required.`;
        continue;
      }
      const parsed: (boolean | number | string)[] = [];
      for (const [index, item] of value.entries()) {
        const error = scalarError(property.items, item, `${label} item ${String(index + 1)}`);
        if (error !== undefined) {
          errors[key] = error;
          break;
        }
        parsed.push(scalarArgument(property.items, item)!);
      }
      if (errors[key] === undefined) argumentsValue[key] = parsed;
      continue;
    }
    const absent = property.type === 'boolean'
      ? typeof value !== 'boolean'
      : typeof value !== 'string' || value.length === 0;
    if (absent && !required.has(key)) continue;
    const error = scalarError(property, value, label);
    if (error !== undefined) {
      errors[key] = error;
      continue;
    }
    argumentsValue[key] = scalarArgument(property, value)!;
  }
  return Object.keys(errors).length > 0
    ? { errors }
    : { arguments: Object.freeze(argumentsValue), errors };
};

export const validateRawRouteInput = (text: string): RawRouteInputValidation => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'Enter a valid JSON object.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'Arguments must be a JSON object.' };
  }
  return { arguments: Object.freeze(value as JsonObject) };
};

const cliOperand = (option: RouteManifestCliCommand['options'][number]): string => {
  const kind = option.kind === 'enum' ? option.choices?.join('|') ?? 'string' : option.kind;
  return `<${kind}>`;
};

export const cliCommandUsage = (command: RouteManifestCliCommand): string => {
  const positionals = command.options.filter((option) => option.positional !== undefined)
    .toSorted((left, right) => left.positional! - right.positional!)
    .map((option) => option.required
      ? `<${option.option}${option.repeated ? '...' : ''}>`
      : `[${option.option}${option.repeated ? '...' : ''}]`);
  const flags = command.options.filter((option) => option.positional === undefined)
    .map((option) => {
      // Booleans are flags and the grammar rejects boolean arrays, so only
      // value-carrying options can repeat; ` ...` mirrors cli-entry help rows.
      const value = option.kind === 'boolean'
        ? `--${option.option}`
        : `--${option.option} ${cliOperand(option)}${option.repeated ? ' ...' : ''}`;
      return option.required ? value : `[${value}]`;
    });
  return [...command.path, ...positionals, ...flags].join(' ');
};

const shellToken = (value: unknown): string => {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
};

export const cliCommandInvocation = (
  command: RouteManifestCliCommand,
  argumentsValue: RouteInputArguments,
): string | undefined => {
  const argv = [...command.path];
  const appendValues = (option: RouteManifestCliCommand['options'][number], positional: boolean): boolean => {
    const value = argumentsValue[option.key];
    if (option.kind === 'boolean') {
      if (value === true && !positional) argv.push(`--${option.option}`);
      return value !== undefined || !option.required;
    }
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (values.length === 0) return !option.required;
    for (const item of values) {
      if (!positional) argv.push(`--${option.option}`);
      argv.push(shellToken(item));
    }
    return true;
  };
  const positionals = command.options.filter((option) => option.positional !== undefined)
    .toSorted((left, right) => left.positional! - right.positional!);
  if (positionals.some((option) => !appendValues(option, true))) return undefined;
  for (const option of command.options.filter((candidate) => candidate.positional === undefined)) {
    if (!appendValues(option, false)) return undefined;
  }
  return argv.join(' ');
};

const routeEditorArgv = (
  command: RouteManifestCliCommand | undefined,
  argumentsValue: RouteInputArguments | undefined,
): string | undefined => argumentsValue === undefined || command === undefined
  ? undefined
  : cliCommandInvocation(command, argumentsValue);

export const setRouteEditorDraftValue = (
  state: RouteEditorState,
  schema: RouteInputSchema | undefined,
  command: RouteManifestCliCommand | undefined,
  key: string,
  value: RouteInputDraftValue | undefined,
): RouteEditorState => {
  const entries = { ...state.draft };
  if (value === undefined) {
    delete entries[key];
  } else {
    entries[key] = value;
  }
  const draft = Object.freeze(entries);
  if (!state.attempted || schema === undefined) return Object.freeze({ ...state, draft });
  const validated = validateRouteInput(schema, draft);
  return Object.freeze({
    ...state,
    arguments: validated.arguments,
    argv: routeEditorArgv(command, validated.arguments),
    draft,
    errors: Object.freeze({ ...validated.errors }),
  });
};

export const setRouteEditorRaw = (
  state: RouteEditorState,
  raw: string,
): RouteEditorState => {
  if (!state.attempted) return Object.freeze({ ...state, raw });
  const validated = validateRawRouteInput(raw);
  return Object.freeze({
    ...state,
    arguments: validated.arguments,
    raw,
    rawError: validated.error,
  });
};

export const validateRouteEditor = (
  state: RouteEditorState,
  schema: RouteInputSchema | undefined,
  command: RouteManifestCliCommand | undefined,
): RouteEditorState => {
  if (schema === undefined) {
    const validated = validateRawRouteInput(state.raw);
    return Object.freeze({
      ...state,
      arguments: validated.arguments,
      argv: routeEditorArgv(command, validated.arguments),
      attempted: true,
      rawError: validated.error,
    });
  }
  const validated = validateRouteInput(schema, state.draft);
  return Object.freeze({
    ...state,
    arguments: validated.arguments,
    argv: routeEditorArgv(command, validated.arguments),
    attempted: true,
    errors: Object.freeze({ ...validated.errors }),
  });
};

export const mcpToolPrefillFor = (
  group: RouteCatalogGroup,
  entry: RouteCatalogEntry,
  argumentsValue: RouteInputArguments,
): McpToolPrefill | undefined => {
  if (entry.kind !== 'tool' || group.serverId?.startsWith('mcp:') !== true) return undefined;
  const slash = entry.id.lastIndexOf('/');
  if (slash < 0 || slash === entry.id.length - 1) return undefined;
  return Object.freeze({
    arguments: argumentsValue,
    serverName: group.serverId.slice('mcp:'.length),
    toolName: entry.id.slice(slash + 1),
  });
};

const navigationJsonValue = (value: unknown, ancestors = new WeakSet<object>()): value is JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => navigationJsonValue(entry, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((entry) => navigationJsonValue(entry, ancestors));
  } finally {
    ancestors.delete(value);
  }
};

const navigationJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && navigationJsonValue(value);

export const mcpToolPrefillNavigationState = (
  prefill: McpToolPrefill,
): McpToolPrefillNavigationState => Object.freeze({ mcpToolPrefill: prefill });

export const mcpToolPrefillFromNavigationState = (value: unknown): McpToolPrefill | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prefill = Reflect.get(value, 'mcpToolPrefill') as unknown;
  if (typeof prefill !== 'object' || prefill === null || Array.isArray(prefill)) return undefined;
  const argumentsValue = Reflect.get(prefill, 'arguments') as unknown;
  const serverName = Reflect.get(prefill, 'serverName') as unknown;
  const toolName = Reflect.get(prefill, 'toolName') as unknown;
  if (
    typeof serverName !== 'string' || serverName.length === 0 ||
    typeof toolName !== 'string' || toolName.length === 0 ||
    !navigationJsonObject(argumentsValue)
  ) return undefined;
  return Object.freeze({
    arguments: argumentsValue,
    serverName,
    toolName,
  });
};
