import { createTargetDiagnostics } from './diagnostics.ts';
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
  supportedEventRouteNamesFrom,
  supportedCapability,
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

/** Builds the `.cursor-plugin/plugin.json` manifest with explicit document pointers. */
export const cursorManifest = (
  model: NormalizedPlugin,
  pointers: CursorManifestPointers,
): Record<string, unknown> => ({
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

const metadata = Object.freeze({
  adapterRevision: '1.7.0',
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
  const plugin = cursorManifest(model, {
    ...(selectedCommands.length === 0 ? {} : { commands: './commands/' }),
    ...(hookDocument !== undefined && hookDocumentValid ? { hooks: `./${cursorArtifactPaths.hooks}` } : {}),
    ...(mcp !== undefined && mcpValid ? { mcp: `./${cursorArtifactPaths.mcp}` } : {}),
    ...(selectedRules.length === 0 ? {} : { rules: './rules/' }),
    ...(model.skills.some((skill) => isSelected(skill.targets)) ? { skills: './skills/' } : {}),
    ...(variables === undefined ? {} : { variables }),
  });
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  const basePlan = standardPluginArtifactPlan({
    additionalPluginSourceInputs: [
      ...selectedCommands.map((command) => command.source),
      ...selectedRules.map((rule) => rule.source),
      ...(model.metadata.logo === undefined ? [] : [model.metadata.logo.source]),
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

export const cursorAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
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
  hookContract,
  metadata,
  mcpRuntime,
  name: cursorName,
  plan: planCursorArtifacts,
});
