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
  supportedCapability,
  unavailableCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/cursor-2026-08-28.json' with { type: 'json' };
import {
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
import mcpSchema from './schemas/cursor/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/cursor/plugin.schema.json' with { type: 'json' };
import {
  createDraft7AdapterValidator,
  schemaDescriptorsFrom,
  standardArtifactLayout,
  standardPluginArtifactPlan,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactPlan,
} from './types.ts';

const cursorName = 'cursor';

/**
 * Cursor's local-plugin document paths, shared with the unified bundle
 * adapter. A known-loading physical install uses `.cursor-plugin/plugin.json`
 * with root `mcp.json` and `hooks/hooks.json`; the manifest keeps explicit
 * pointers so every declared component resolves from one plugin root.
 */
export const cursorArtifactPaths = Object.freeze({
  hooks: 'hooks/hooks.json',
  mcp: 'mcp.json',
  plugin: '.cursor-plugin/plugin.json',
});

const validator = createDraft7AdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateHooks = validator.compile(hooksSchema);

/** The pinned Cursor document validators, shared with the unified bundle adapter. */
export const cursorPluginValidator = validatePlugin;
export const cursorMcpValidator = validateMcp;
export const cursorHooksValidator = validateHooks;

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
  commandRoot: '${CURSOR_PLUGIN_ROOT}',
  documentEntry: cursorHookDocumentEntry,
  documentEnvelope: cursorHookDocumentEnvelope,
  encodePlaygroundInput: encodeCursorPlaygroundInput,
  encodePlaygroundOutput: (result, canonicalEvent) => encodeCursorPlaygroundOutput(result, canonicalEvent),
  eventNames: capabilityTable.hooks.events,
  ...(options.indexedWrappers === false ? { indexedWrappers: false as const } : {}),
  manifestPath: options.manifestPath,
  matchers: capabilityTable.hooks.matchers,
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
  readonly hooks?: string;
  readonly mcp?: string;
  readonly skills?: string;
  readonly variables?: Record<string, unknown>;
}

/** Builds the `.cursor-plugin/plugin.json` manifest with explicit document pointers. */
export const cursorManifest = (
  model: NormalizedPlugin,
  pointers: CursorManifestPointers,
): Record<string, unknown> => ({
  description: model.metadata.description ?? model.metadata.name,
  displayName: model.metadata.name,
  ...(pointers.hooks === undefined ? {} : { hooks: pointers.hooks }),
  ...(pointers.mcp === undefined ? {} : { mcpServers: pointers.mcp }),
  name: model.metadata.name,
  ...(pointers.skills === undefined ? {} : { skills: pointers.skills }),
  ...(pointers.variables === undefined ? {} : { variables: pointers.variables }),
  version: model.metadata.version,
});

const metadata = Object.freeze({
  adapterRevision: '1.3.0',
  capabilityRevision: capabilityTable.observedCliVersion,
  capabilitySha256: '20fc70ad5ba67d984826c3ac917fca66f28e61a8c74edb65dace53c29cc67279',
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
    Object.freeze({ path: cursorArtifactPaths.mcp, required: false, schema: 'mcp' }),
    Object.freeze({ path: cursorArtifactPaths.plugin, required: true, schema: 'plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
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

export const planCursorArtifacts = (model: NormalizedPlugin): TargetArtifactPlan => {
  const isSelected = (targets: readonly string[]): boolean => targets.includes(cursorName);
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
  const plugin = cursorManifest(model, {
    ...(hookDocument !== undefined && hookDocumentValid ? { hooks: `./${cursorArtifactPaths.hooks}` } : {}),
    ...(mcp !== undefined && mcpValid ? { mcp: `./${cursorArtifactPaths.mcp}` } : {}),
    ...(model.skills.some((skill) => isSelected(skill.targets)) ? { skills: './skills/' } : {}),
    ...(variables === undefined ? {} : { variables }),
  });
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  return standardPluginArtifactPlan({
    diagnostics,
    hookDocument,
    hookDocumentValid,
    hookEntries: generatedHooks.hookEntries,
    hookManifestPath: cursorArtifactPaths.hooks,
    isSelected,
    marketplaceRelativePath: '.cursor-plugin/marketplace.json',
    marketplaceValid: false,
    mcp,
    mcpRelativePath: cursorArtifactPaths.mcp,
    mcpValid,
    model,
    plugin,
    pluginRelativePath: cursorArtifactPaths.plugin,
    targetName: cursorName,
  });
};

export const cursorAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: standardArtifactLayout,
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
    hooks: supportedCapability(evidence),
    marketplace: unavailableCapability('The pinned Cursor Plugin contract does not define a marketplace document.'),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'The pinned Cursor Plugin contract does not support both required modern MCP transports.',
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
