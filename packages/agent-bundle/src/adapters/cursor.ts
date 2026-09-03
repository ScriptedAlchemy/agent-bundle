import { createTargetDiagnostics } from './diagnostics.ts';
import type { CapabilityEvidence, CapabilityState } from '../core/capabilities.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import { isPlainDataRecord, ownDataValue } from '../core/strict-json.ts';
import {
  pathTokens,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import {
  capabilityEvidence,
  capabilityStateFromSupport,
  eventRouteCapabilitiesFrom,
  cliBinCapability,
  supportedEventRouteNamesFrom,
  supportedCapability,
  unavailableCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/cursor-2026-08-28.json' with { type: 'json' };
import {
  createNativeEventStarter,
  cursorHookWrapperSource,
  encodeCursorPlaygroundInput,
  encodeCursorPlaygroundOutput,
  planHooks,
  readCursorNativeHookCommands,
  type TargetHookContract,
  type TargetHookDocumentEntryInput,
} from './hook-contract.ts';
import schemaProvenance from './schemas/cursor/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/cursor/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/cursor/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/cursor/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/cursor/plugin.schema.json' with { type: 'json' };
import {
  commandWriteEntries,
  createDraft7AdapterValidator,
  ruleWriteEntries,
  schemaDescriptorsFrom,
  sortedEntries,
  standardArtifactLayout,
  standardPluginArtifactPlan,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactLayout,
  type TargetArtifactPlan,
} from './types.ts';
import { pluginLogoManifestRef, withPluginLogoEntry } from './plugin-logo.ts';
import { withInstallSurface } from '../install/surface.ts';

const cursorName = 'cursor';

export interface CursorAuthorConfig {
  readonly email?: string;
  readonly name: string;
}

/**
 * Cursor-only authored manifest metadata layered onto the generated
 * `.cursor-plugin/plugin.json`. Every field is admitted by the pinned
 * cursor/plugins@0701892 plugin schema; `author.url` is not (the schema's
 * author object is closed), and Cursor documents no `nativeHooks` surface.
 */
export interface CursorHostConfig {
  readonly author?: CursorAuthorConfig;
  readonly category?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  /** Minimum client versions keyed by client identifier, e.g. `{ cursor: '3.13.0' }`. */
  readonly minClientVersions?: Readonly<Record<string, string>>;
  readonly publisher?: string;
  readonly repository?: string;
  readonly tags?: readonly string[];
}

export interface CursorConfigExtension {
  cursor?: CursorHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    cursor?: CursorHostConfig;
  }
}

/**
 * Cursor's local-plugin document paths, shared with the unified bundle
 * adapter. A known-loading physical install uses `.cursor-plugin/plugin.json`
 * with root `mcp.json` and `hooks/hooks.json`; the manifest keeps explicit
 * pointers so every declared component resolves from one plugin root.
 */
export const cursorArtifactPaths = Object.freeze({
  hooks: 'hooks/hooks.json',
  marketplace: '.cursor-plugin/marketplace.json',
  mcp: 'mcp.json',
  plugin: '.cursor-plugin/plugin.json',
});

const validator = createDraft7AdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateHooks = validator.compile(hooksSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
/**
 * The exact `format: "uri"` / `format: "email"` checks the pinned plugin
 * schema applies to `homepage`/`repository` and `author.email`, so metadata is
 * validated as the string that will be emitted rather than through a looser
 * local approximation (`new URL()` normalizes; a hand regex admits `a@b..c`).
 */
const validateSchemaUri = validator.compile({ type: 'string', format: 'uri' });
const validateSchemaEmail = validator.compile({ type: 'string', format: 'email' });

/** The pinned Cursor document validators, shared with the unified bundle adapter. */
export const cursorPluginValidator = validatePlugin;
export const cursorMcpValidator = validateMcp;
export const cursorHooksValidator = validateHooks;
export const cursorMarketplaceValidator = validateMarketplace;

const cursorNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const cursorNameMaxLength = 64;

const cursorVariablePattern = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/gu;
const cursorBuiltInVariables = new Set(['CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT']);
const portableAgentPluginTokens = ['${PLUGIN_DATA}', '${PLUGIN_ROOT}'] as const;

/** Builds the manifest variable schema required for custom MCP placeholders. */
export const cursorVariables = (mcp: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (mcp === undefined) return undefined;
  const names = new Set<string>();
  for (const match of JSON.stringify(mcp).matchAll(cursorVariablePattern)) {
    const name = match[1];
    if (name !== undefined && !cursorBuiltInVariables.has(name)) names.add(name);
  }
  if (names.size === 0) return undefined;
  return {
    properties: Object.fromEntries([...names].sort().map((name) => [name, { type: 'string' }])),
    type: 'object',
  };
};

/** True when a plugin name satisfies Cursor's lowercase kebab-case contract. */
export const isValidCursorPluginName = (name: string): boolean =>
  cursorNamePattern.test(name) && name.length <= cursorNameMaxLength;

/**
 * The pinned official schema constrains the name's charset but carries no
 * `maxLength`, so the 64-character bound only holds if both Cursor-producing
 * planners state it. They share this message so neither can drift.
 */
export const cursorPluginNameError = (name: string): string =>
  `Plugin name ${JSON.stringify(name)} is not a valid Cursor plugin name ` +
  `(lowercase kebab-case, at most ${cursorNameMaxLength} characters).`;

/** The schema-collision guard the bundle emits when no hook lowers to Cursor. */
export const emptyCursorHooksDocument = Object.freeze({ hooks: {}, version: 1 });

const cursorHookDocumentEntry = (input: TargetHookDocumentEntryInput): Record<string, unknown> => ({ ...input });

const cursorHookDocumentEnvelope = (hooks: Record<string, unknown[]>): Record<string, unknown> => ({ hooks, version: 1 });
const eventRouteNames = supportedEventRouteNamesFrom(capabilityTable.hooks.eventRoutes);

export interface CursorHookContractOptions {
  /** See TargetHookContract.indexedWrappers; the bundle's Cursor wrappers are document variants. */
  readonly indexedWrappers?: false;
  readonly manifestPath: string;
  readonly wrapperPath: TargetHookContract['wrapperPath'];
}

/**
 * Cursor hook lowering, shared with the unified bundle adapter: flat
 * `{ command, matcher?, timeout? }` entries under a `version: 1` envelope,
 * `${CURSOR_PLUGIN_ROOT}` command interpolation, and the dedicated Cursor
 * wrapper codec (Cursor's stdin/stdout envelope is not the shared
 * Claude/Codex format; see cursorHookWrapperSource).
 */
export const createCursorHookContract = (options: CursorHookContractOptions): TargetHookContract => Object.freeze({
  hostContractRevision: capabilityTable.observedCliVersion,
  commandRoot: '${CURSOR_PLUGIN_ROOT}',
  documentEntry: cursorHookDocumentEntry,
  documentEnvelope: cursorHookDocumentEnvelope,
  encodePlaygroundInput: encodeCursorPlaygroundInput,
  encodePlaygroundOutput: (result, canonicalEvent) => encodeCursorPlaygroundOutput(result, canonicalEvent),
  eventNames: capabilityTable.hooks.events,
  eventRouteNames,
  ...(options.indexedWrappers === false ? { indexedWrappers: false as const } : {}),
  manifestPath: options.manifestPath,
  matchers: capabilityTable.hooks.matchers,
  nativeEventStarter: (event) => {
    const nativeEvent = eventRouteNames[event];
    return nativeEvent === undefined ? undefined : createNativeEventStarter('cursor', event, nativeEvent);
  },
  readNativeCommands: readCursorNativeHookCommands,
  wrapperPath: options.wrapperPath,
  wrapperSource: cursorHookWrapperSource,
} satisfies TargetHookContract);

/**
 * Cursor documents `${env:NAME}` / `${workspaceFolder}` interpolation and
 * `${CURSOR_PLUGIN_ROOT}` for hook commands; the same root variable is the
 * best-documented spelling for plugin-contained MCP entry paths.
 */
export const expandCursorToken = (value: string): string => value
  .replaceAll(pathTokens.pluginRoot, '${CURSOR_PLUGIN_ROOT}')
  .replaceAll(pathTokens.workspaceRoot, '${workspaceFolder}');

export interface CursorMcpServerPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly value?: Record<string, unknown>;
}

export interface CursorMcpServerPlanContext {
  /** Diagnostic code prefix, e.g. `cursor` or the bundle's `plugin.cursor`. */
  readonly codePrefix: string;
  readonly errorDiagnostic: (code: string, message: string) => Diagnostic;
}

/** Lowers one normalized MCP server into Cursor's typeless document shape. */
export const planCursorMcpServer = (
  server: NormalizedMcpServer,
  { codePrefix, errorDiagnostic }: CursorMcpServerPlanContext,
): CursorMcpServerPlan => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const values = [server.command, ...(server.args ?? []), server.url, ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})];
  const portableToken = portableAgentPluginTokens.find((token) =>
    values.some((value) => value !== undefined && value.includes(token)));
  if (portableToken !== undefined) {
    return {
      diagnostics: [errorDiagnostic(
        `${codePrefix}.mcp.token`,
        `MCP server ${JSON.stringify(server.name)} uses Portable Agent Plugin token ${portableToken} in a full Cursor Plugin artifact.`,
      )],
    };
  }
  if (values.some((value) => value !== undefined && value.includes(pathTokens.pluginData))) {
    return {
      diagnostics: [errorDiagnostic(
        `${codePrefix}.mcp.token`,
        `MCP server ${JSON.stringify(server.name)} uses a plugin-data path token with no documented Cursor equivalent.`,
      )],
    };
  }
  if (transport === 'stdio') {
    if (server.command === undefined) {
      return {
        diagnostics: [errorDiagnostic(`${codePrefix}.mcp.command`, `MCP server ${JSON.stringify(server.name)} requires a command.`)],
      };
    }
    const args = server.args?.map(expandCursorToken);
    if (server.source !== undefined && server.cwd === pathTokens.pluginRoot && args?.[0] !== undefined) {
      args[0] = `\${CURSOR_PLUGIN_ROOT}/${args[0]}`;
    }
    const declaredEnv = server.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandCursorToken(value)]));
    return {
      diagnostics: [],
      value: {
        ...(args === undefined ? {} : { args }),
        command: expandCursorToken(server.command),
        env: withPluginRootEnvAnchor(declaredEnv, expandCursorToken(pathTokens.pluginRoot)),
      },
    };
  }
  if (server.url === undefined) {
    return {
      diagnostics: [errorDiagnostic(`${codePrefix}.mcp.url`, `MCP server ${JSON.stringify(server.name)} requires a URL.`)],
    };
  }
  const headers = server.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandCursorToken(value)]));
  return {
    diagnostics: [],
    value: {
      ...(headers === undefined ? {} : { headers }),
      url: expandCursorToken(server.url),
    },
  };
};

export interface CursorManifestPointers {
  readonly commands?: string;
  readonly hooks?: string;
  readonly mcp?: string;
  readonly rules?: string;
  readonly skills?: string;
  readonly variables?: Record<string, unknown>;
}

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isAbsoluteUrl = (value: unknown): value is string => {
  if (!isNonemptyString(value) || !validateSchemaUri(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const isEmail = (value: unknown): value is string =>
  isNonemptyString(value) && validateSchemaEmail(value) === true;

const isNonemptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonemptyString);

/** The pinned schema's strict `X.Y.Z[-prerelease]` semver for `minClientVersions` values. */
const cursorSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/u;

const cursorManifestMetadataFields = Object.freeze([
  'author',
  'category',
  'homepage',
  'keywords',
  'license',
  'minClientVersions',
  'publisher',
  'repository',
  'tags',
] as const);

export interface CursorManifestMetadataPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Readonly<Record<string, unknown>>;
  readonly sourceInputs: readonly string[];
}

const noManifestMetadataPlan: CursorManifestMetadataPlan = Object.freeze({
  diagnostics: Object.freeze([]),
  sourceInputs: Object.freeze([]),
});

export interface CursorManifestMetadataPlanContext {
  /** Diagnostic code prefix, e.g. `cursor` or the bundle's `plugin.cursor`. */
  readonly codePrefix: string;
  readonly errorDiagnostic: (code: string, message: string) => Diagnostic;
}

/**
 * Validates the authored `cursor.*` manifest metadata against the pinned
 * plugin schema's field shapes. A diagnostic never yields a partial document:
 * either every authored field is valid and emitted verbatim, or none is.
 */
export const planCursorManifestMetadata = (
  model: NormalizedPlugin,
  { codePrefix, errorDiagnostic }: CursorManifestMetadataPlanContext,
): CursorManifestMetadataPlan => {
  const extension = model.extensions[cursorName];
  if (extension === undefined || !isPlainDataRecord(extension.value)) return noManifestMetadataPlan;
  const value = extension.value;
  const diagnostics: Diagnostic[] = [];
  const sourceInputs = Object.freeze([extension.provenance.sourcePath]);
  const unknownFields = Object.keys(value).filter((field) =>
    !(cursorManifestMetadataFields as readonly string[]).includes(field));
  if (unknownFields.length > 0) {
    diagnostics.push(errorDiagnostic(
      `${codePrefix}.manifest.field.unknown`,
      `Cursor config declares unsupported field${unknownFields.length === 1 ? '' : 's'} ${unknownFields.map((field) => JSON.stringify(field)).join(', ')}; the pinned Cursor plugin schema admits only ${cursorManifestMetadataFields.join(', ')} here.`,
    ));
  }
  const document: Record<string, unknown> = {};
  const author = value['author'];
  if (author !== undefined) {
    if (!isPlainDataRecord(author)) {
      diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.author.invalid`, 'Cursor author must be a plain object with name and optional email.'));
    } else {
      const extra = Object.keys(author).filter((field) => !['email', 'name'].includes(field));
      if (extra.length > 0) {
        diagnostics.push(errorDiagnostic(
          `${codePrefix}.manifest.author.invalid`,
          `Cursor author contains unsupported field${extra.length === 1 ? '' : 's'} ${extra.map((field) => JSON.stringify(field)).join(', ')}; the pinned Cursor plugin schema admits only name and email.`,
        ));
      }
      if (!isNonemptyString(author['name'])) {
        diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.author.name.invalid`, 'Cursor author.name must be a nonempty string.'));
      }
      if (author['email'] !== undefined && !isEmail(author['email'])) {
        diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.author.email.invalid`, "Cursor author.email must be an email address the pinned schema's email format admits."));
      }
      if (extra.length === 0 && isNonemptyString(author['name']) && (author['email'] === undefined || isEmail(author['email']))) {
        document['author'] = Object.freeze({
          ...(author['email'] === undefined ? {} : { email: author['email'] }),
          name: author['name'],
        });
      }
    }
  }
  for (const field of ['homepage', 'repository'] as const) {
    const url = value[field];
    if (url === undefined) continue;
    if (isAbsoluteUrl(url)) document[field] = url;
    else diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.${field}.invalid`, `Cursor ${field} must be an absolute HTTP or HTTPS URL written exactly as the pinned schema's uri format admits (no surrounding whitespace or unescaped characters).`));
  }
  for (const field of ['category', 'license', 'publisher'] as const) {
    const text = value[field];
    if (text === undefined) continue;
    if (isNonemptyString(text)) document[field] = text;
    else diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.${field}.invalid`, `Cursor ${field} must be a nonempty string.`));
  }
  for (const field of ['keywords', 'tags'] as const) {
    const list = value[field];
    if (list === undefined) continue;
    if (isNonemptyStringArray(list)) document[field] = Object.freeze([...list]);
    else diagnostics.push(errorDiagnostic(`${codePrefix}.manifest.${field}.invalid`, `Cursor ${field} must be an array of nonempty strings.`));
  }
  const minClientVersions = value['minClientVersions'];
  if (minClientVersions !== undefined) {
    const entries = isPlainDataRecord(minClientVersions) ? Object.entries(minClientVersions) : undefined;
    const invalid = entries?.filter(([client, version]) => !isNonemptyString(client) || !isNonemptyString(version) || !cursorSemverPattern.test(version));
    if (entries === undefined || entries.length === 0) {
      diagnostics.push(errorDiagnostic(
        `${codePrefix}.manifest.minClientVersions.invalid`,
        'Cursor minClientVersions must be a plain object with at least one client identifier, e.g. { cursor: "3.13.0" }.',
      ));
    } else if (invalid !== undefined && invalid.length > 0) {
      diagnostics.push(errorDiagnostic(
        `${codePrefix}.manifest.minClientVersions.invalid`,
        `Cursor minClientVersions ${invalid.map(([client]) => JSON.stringify(client)).join(', ')} must be strict X.Y.Z semver strings with an optional prerelease suffix.`,
      ));
    } else {
      document['minClientVersions'] = Object.freeze(Object.fromEntries(entries.slice().sort(([left], [right]) => left.localeCompare(right))));
    }
  }
  if (diagnostics.length > 0) return Object.freeze({ diagnostics: Object.freeze(diagnostics), sourceInputs });
  if (Object.keys(document).length === 0) return Object.freeze({ diagnostics: Object.freeze([]), sourceInputs });
  return Object.freeze({ diagnostics: Object.freeze([]), document: Object.freeze(document), sourceInputs });
};

/** Builds the `.cursor-plugin/plugin.json` manifest with explicit document pointers. */
export const cursorManifest = (
  model: NormalizedPlugin,
  pointers: CursorManifestPointers,
  manifestMetadata?: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...(manifestMetadata ?? {}),
  ...(pointers.commands === undefined ? {} : { commands: pointers.commands }),
  description: model.metadata.description ?? model.metadata.name,
  displayName: model.metadata.name,
  ...(pointers.hooks === undefined ? {} : { hooks: pointers.hooks }),
  ...(model.metadata.logo === undefined ? {} : { logo: pluginLogoManifestRef(model.metadata.logo.path) }),
  ...(pointers.mcp === undefined ? {} : { mcpServers: pointers.mcp }),
  name: model.metadata.name,
  ...(pointers.rules === undefined ? {} : { rules: pointers.rules }),
  ...(pointers.skills === undefined ? {} : { skills: pointers.skills }),
  ...(pointers.variables === undefined ? {} : { variables: pointers.variables }),
  version: model.metadata.version,
});

interface CapabilityTableRow {
  readonly reason?: string;
  /** JSON imports widen literals; unsupported table states fail closed below. */
  readonly state: string;
}

/** Converts one dated capability-table row into the shared four-state contract. */
const rowCapability = (row: CapabilityTableRow, evidence: CapabilityEvidence): CapabilityState => {
  switch (row.state) {
    case 'supported':
      return supportedCapability(evidence);
    case 'degraded':
      return Object.freeze({ evidence, reason: row.reason ?? 'The pinned Cursor contract degrades this surface.', state: 'degraded' });
    case 'unavailable':
      return unavailableCapability(row.reason ?? 'The pinned Cursor contract does not support this surface.');
    case 'prohibited':
      return Object.freeze({ reason: row.reason ?? 'The pinned Cursor contract prohibits this surface.', state: 'prohibited' });
    default:
      throw new TypeError(`Unsupported Cursor capability table state ${JSON.stringify(row.state)}.`);
  }
};

const metadata = Object.freeze({
  adapterRevision: '1.9.0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});
const evidence = capabilityEvidence(cursorName, metadata);

const hookContract = createCursorHookContract({
  manifestPath: cursorArtifactPaths.hooks,
  wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
});

const artifactValidation = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ path: cursorArtifactPaths.hooks, required: false, schema: 'hooks' }),
    Object.freeze({ path: cursorArtifactPaths.marketplace, required: false, schema: 'marketplace' }),
    Object.freeze({ path: cursorArtifactPaths.mcp, required: false, schema: 'mcp' }),
    Object.freeze({ path: cursorArtifactPaths.plugin, required: true, schema: 'plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ]),
});

/**
 * Cursor's MCP document is shape-discriminated: stdio entries declare a
 * `command` and remote entries declare a `url`; the format has no `type`
 * field. A record declaring both (or neither) has no defined transport.
 */
const cursorServerType = (server: unknown): string | undefined => {
  if (!isPlainDataRecord(server)) return undefined;
  const command = ownDataValue(server, 'command');
  const url = ownDataValue(server, 'url');
  if (command === undefined || url === undefined) return undefined;
  if (command.found === url.found) return undefined;
  if (command.found) return typeof command.value === 'string' ? 'stdio' : undefined;
  return typeof url.value === 'string' ? 'streamable-http' : undefined;
};

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: cursorArtifactPaths.mcp,
  readServerType: cursorServerType,
  remoteTypes: ['streamable-http'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: Object.freeze([...standardMcpPathTokens, '${CURSOR_PLUGIN_ROOT}', '${workspaceFolder}']),
    target: cursorName,
    tokens: allMcpPathTokenFields(Object.freeze({
      '${CURSOR_PLUGIN_ROOT}': 'pluginRoot',
      '${workspaceFolder}': 'workspaceRoot',
    })),
  }),
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(cursorName, 'Cursor');

const mcpPlanContext: CursorMcpServerPlanContext = Object.freeze({ codePrefix: cursorName, errorDiagnostic });

const artifactLayout: TargetArtifactLayout = Object.freeze({
  ...standardArtifactLayout,
  commands: Object.freeze({
    allowedSuffixes: Object.freeze(['.md']),
    directory: 'commands',
  }),
  rules: Object.freeze({
    allowedSuffixes: Object.freeze(['.mdc']),
    directory: 'rules',
  }),
});

export interface CursorMarketplacePlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly valid: boolean;
}

/** Builds and validates Cursor's official `.cursor-plugin/marketplace.json` document. */
export const planCursorMarketplace = (model: NormalizedPlugin): CursorMarketplacePlan => {
  if (model.marketplace !== true) {
    return Object.freeze({ diagnostics: Object.freeze([]), valid: false });
  }
  const document = {
    name: `${model.metadata.name}-marketplace`,
    owner: { name: model.metadata.name },
    plugins: [{
      description: model.metadata.description ?? model.metadata.name,
      name: model.metadata.name,
      source: './',
    }],
  };
  const valid = validateMarketplace(document);
  return Object.freeze({
    diagnostics: Object.freeze(schemaDiagnostics('marketplace', valid, validateMarketplace.errors)),
    document,
    valid,
  });
};

export const planCursorArtifacts = (model: NormalizedPlugin): TargetArtifactPlan => {
  const isSelected = (targets: readonly string[]): boolean => targets.includes(cursorName);
  const selectedCommands = (model.commands ?? []).filter((command) => isSelected(command.targets));
  const selectedRules = (model.rules ?? []).filter((rule) => isSelected(rule.targets));
  const diagnostics: Diagnostic[] = [];
  if (!isValidCursorPluginName(model.metadata.name)) {
    diagnostics.push(errorDiagnostic('cursor.name', cursorPluginNameError(model.metadata.name)));
  }
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!isSelected(server.targets)) continue;
    const serverPlan = planCursorMcpServer(server, mcpPlanContext);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) servers[server.name] = serverPlan.value;
  }
  const mcp = Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
  const mcpValid = mcp !== undefined && validateMcp(mcp);
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', mcpValid, validateMcp.errors));

  const generatedHooks = planHooks(model, cursorName, hookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  const hookDocument = generatedHooks.document;
  const hookDocumentValid = hookDocument !== undefined && validateHooks(hookDocument);
  if (hookDocument !== undefined) diagnostics.push(...schemaDiagnostics('hooks', hookDocumentValid, validateHooks.errors));

  const variables = cursorVariables(mcp);
  const marketplacePlan = planCursorMarketplace(model);
  diagnostics.push(...marketplacePlan.diagnostics);
  const manifestMetadata = planCursorManifestMetadata(model, mcpPlanContext);
  diagnostics.push(...manifestMetadata.diagnostics);
  const plugin = cursorManifest(model, {
    ...(selectedCommands.length === 0 ? {} : { commands: './commands/' }),
    ...(hookDocument !== undefined && hookDocumentValid ? { hooks: `./${cursorArtifactPaths.hooks}` } : {}),
    ...(mcp !== undefined && mcpValid ? { mcp: `./${cursorArtifactPaths.mcp}` } : {}),
    ...(selectedRules.length === 0 ? {} : { rules: './rules/' }),
    ...(model.skills.some((skill) => isSelected(skill.targets)) ? { skills: './skills/' } : {}),
    ...(variables === undefined ? {} : { variables }),
  }, manifestMetadata.document);
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  const basePlan = standardPluginArtifactPlan({
    additionalPluginSourceInputs: [
      ...selectedCommands.map((command) => command.source),
      ...selectedRules.map((rule) => rule.source),
      ...(model.metadata.logo === undefined ? [] : [model.metadata.logo.source]),
      ...manifestMetadata.sourceInputs,
    ],
    diagnostics,
    hookDocument,
    hookDocumentValid,
    hookEntries: generatedHooks.hookEntries,
    hookManifestPath: cursorArtifactPaths.hooks,
    isSelected,
    marketplace: marketplacePlan.document,
    marketplaceRelativePath: cursorArtifactPaths.marketplace,
    marketplaceValid: marketplacePlan.valid,
    mcp,
    mcpRelativePath: cursorArtifactPaths.mcp,
    mcpValid,
    model,
    plugin,
    pluginRelativePath: cursorArtifactPaths.plugin,
    targetName: cursorName,
  });
  return withInstallSurface(Object.freeze({
    ...basePlan,
    entries: sortedEntries(withPluginLogoEntry([
      ...basePlan.entries,
      ...commandWriteEntries(model, isSelected, (command) =>
        command.markdown === command.body ? command.markdown : command.body),
      ...ruleWriteEntries(model, isSelected),
    ], model)),
  }), model, 'cursor');
};

const { distributionPolicy, formats } = capabilityTable.plugin;
const hookOptions = capabilityTable.hooks.options;

/**
 * Cursor-only capability rows (#189 contract matrix). Each key maps to one
 * dated row in the pinned table so inspect and the composite bundle read the
 * same judgment; the plugin adapter mirrors every key with an honest
 * unavailable intersection for the hosts that lack the surface.
 */
export const cursorContractCapabilityRows = Object.freeze({
  agentPluginFormat: formats.agentPlugin,
  agents: capabilityTable.plugin.agents.component,
  canvases: capabilityTable.plugin.canvases,
  componentDiscovery: capabilityTable.plugin.componentDiscovery,
  cursorPluginFormat: formats.cursorPlugin,
  hookFailClosed: hookOptions.failClosed,
  hookLoopLimit: hookOptions.loopLimit,
  hookMatchers: hookOptions.matcher,
  hookTimeout: hookOptions.timeout,
  installModes: distributionPolicy.installModes,
  localPluginImports: distributionPolicy.localPluginImports,
  localSymlinkInstall: distributionPolicy.localSymlinkInstall,
  manifestMetadata: capabilityTable.plugin.manifestMetadata,
  marketplaceAccess: distributionPolicy.marketplaceAccess,
  marketplaceAutoRefresh: distributionPolicy.autoRefresh,
  marketplaceManifest: capabilityTable.plugin.marketplaceManifest,
  marketplaceReview: distributionPolicy.marketplaceReview,
  promptHooks: hookOptions.prompt,
  rootSkill: capabilityTable.plugin.rootSkill,
  teamMarketplaces: distributionPolicy.teamMarketplaces,
  variables: capabilityTable.plugin.variables,
} satisfies Readonly<Record<string, CapabilityTableRow>>);

const contractCapabilities = Object.freeze(Object.fromEntries(
  Object.entries(cursorContractCapabilityRows).map(([capability, row]) => [capability, rowCapability(row, evidence)]),
));

export const cursorAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: Object.freeze({
    ...contractCapabilities,
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
    // The routed CLI bin rides the same plugin-root directory the pinned
    // contract already executes `mcp/` and `scripts/` files from (#387).
    [cliBinCapability]: supportedCapability(evidence),
    commands: capabilityStateFromSupport(
      capabilityTable.plugin.commands,
      evidence,
      'The pinned Cursor Plugin contract does not support commands.',
    ),
    hooks: supportedCapability(evidence),
    install: supportedCapability(evidence),
    marketplace: supportedCapability(evidence),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'The pinned Cursor Plugin contract does not support both required modern MCP transports.',
    ),
    rules: capabilityStateFromSupport(
      capabilityTable.plugin.rules,
      evidence,
      'The pinned Cursor Plugin contract does not support rules.',
    ),
    skills: capabilityStateFromSupport(
      capabilityTable.plugin.skills,
      evidence,
      'The pinned Cursor Plugin contract does not support skills.',
    ),
  }),
  configExtension: Object.freeze({ key: cursorName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: cursorName,
  plan: planCursorArtifacts,
});
