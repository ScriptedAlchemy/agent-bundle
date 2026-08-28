import { posix } from 'node:path';

import type { ValidateFunction } from 'ajv/dist/2020.js';

import { createTargetDiagnostics } from './diagnostics.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleHostConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import { createMcpPathTokenResolver, standardMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime, resolveTargetRelativeStdioArgument } from '../services/mcp-runtime.ts';
import capabilityTable from './capabilities/codex-0.147.0.json' with { type: 'json' };
import {
  mergeHookDocuments,
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  planHooks,
  readStandardNativeHookCommands,
  validatedNativeHookDocument,
  type TargetHookContract,
} from './hook-contract.ts';
import schemaProvenance from './schemas/codex/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/codex/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/codex/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/codex/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/codex/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  hasPathToken,
  schemaDescriptorsFrom,
  standardArtifactLayout,
  standardPluginArtifactPlan,
  validateJsonSchemaDocument,
  type TargetAdapter,
  type TargetArtifactPlan,
} from './types.ts';

export interface CodexConfigExtension {
  codex?: AgentBundleHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    codex?: AgentBundleHostConfig;
  }
}

const codexName = 'codex';
const validator = createAdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);
const hookContract = Object.freeze({
  commandRoot: '${PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: encodeNativeHookPlaygroundOutput,
  eventNames: capabilityTable.hooks.events,
  manifestPath: 'hooks/hooks.json',
  matchers: capabilityTable.hooks.matchers,
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Codex'),
} satisfies TargetHookContract);
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: capabilityTable.observedCliVersion,
  capabilitySha256: '4b08c8820ace59ca068677dcb1863a9fd4cb730b7e00733b994b0076958beaf0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});

const artifactValidation = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ path: 'hooks/hooks.json', required: false, schema: 'hooks' }),
    Object.freeze({ path: '.agents/plugins/marketplace.json', required: false, schema: 'marketplace' }),
    Object.freeze({ path: '.mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: '.codex-plugin/plugin.json', required: true, schema: 'plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateJsonSchemaDocument(validateMcp) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ]),
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: '.mcp.json',
  remoteTypes: ['streamable-http'],
  resolveStdioArgument: resolveTargetRelativeStdioArgument,
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: codexName,
    tokens: {},
  }),
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(codexName, 'Codex');


const hasLeadingPluginRoot = (value: string): boolean =>
  value === pathTokens.pluginRoot || value.startsWith(`${pathTokens.pluginRoot}/`);

const relativePluginPath = (value: string): string | undefined => {
  const rest = value.slice(pathTokens.pluginRoot.length).replace(/^\/+/, '');
  const pluginRoot = '/agent-bundle-plugin-root';
  const resolved = posix.resolve(pluginRoot, rest);
  if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}/`)) return undefined;
  const relative = posix.relative(pluginRoot, resolved);
  return relative.length === 0 ? './' : `./${relative}`;
};

const convertCodexValue = (
  value: string,
  location: string,
  hasPluginRootCwd: boolean,
  diagnostics: Diagnostic[],
): string | undefined => {
  if (value.includes(pathTokens.pluginData)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-data.${location}`,
      `Codex MCP ${location} cannot use the plugin-data path token.`,
    ));
    return undefined;
  }
  if (value.includes(pathTokens.workspaceRoot)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.workspace-root.${location}`,
      `Codex MCP ${location} cannot use the workspace-root path token.`,
    ));
    return undefined;
  }
  if (!value.includes(pathTokens.pluginRoot)) return value;
  if (!hasLeadingPluginRoot(value)) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.embedded.${location}`,
      `Codex MCP ${location} embeds the plugin-root path token and cannot represent it natively.`,
    ));
    return undefined;
  }
  if (!hasPluginRootCwd) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.cwd.required.${location}`,
      `Codex MCP ${location} needs an explicit plugin-root cwd before it can be made relative.`,
    ));
    return undefined;
  }
  const relative = relativePluginPath(value);
  if (relative === undefined) {
    diagnostics.push(errorDiagnostic(
      `codex.mcp.token.plugin-root.escape.${location}`,
      `Codex MCP ${location} escapes the plugin-root cwd after canonical path resolution.`,
    ));
  }
  return relative;
};

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const diagnostics: Diagnostic[] = [];
  if (transport === 'stdio') {
    if (server.command === undefined) {
      diagnostics.push(errorDiagnostic(
        'codex.mcp.command.required',
        `Codex MCP server "${server.name}" requires a command.`,
      ));
      return { diagnostics };
    }

    const hasPluginRootCwd = server.cwd === pathTokens.pluginRoot || server.cwd === './';
    let cwd: string | undefined;
    if (server.cwd !== undefined) {
      if (server.cwd === pathTokens.pluginRoot) {
        cwd = './';
      } else {
        cwd = convertCodexValue(server.cwd, 'cwd', false, diagnostics);
      }
    }
    const command = convertCodexValue(server.command, 'command', hasPluginRootCwd, diagnostics);
    const args = server.args?.map((argument, index) =>
      convertCodexValue(argument, `args[${index}]`, hasPluginRootCwd, diagnostics));
    const nativeArgs = server.source === undefined
      ? args
      : args?.map((argument, index) =>
          index === 0 && typeof argument === 'string' && argument.startsWith('mcp/')
            ? `./${argument}`
            : argument);
    const env = server.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.env).map(([key, value]) => {
          if (hasPathToken(key)) {
            diagnostics.push(errorDiagnostic(
              'codex.mcp.token.env.key',
              `Codex MCP environment key "${key}" cannot use a path token.`,
            ));
          }
          return [key, convertCodexValue(value, `env.${key}`, hasPluginRootCwd, diagnostics)];
        }));

    if (diagnostics.length > 0 || command === undefined || nativeArgs?.some((value) => value === undefined) || Object.values(env ?? {}).some((value) => value === undefined)) {
      return { diagnostics };
    }
    return {
      diagnostics,
      value: {
        ...(nativeArgs === undefined ? {} : { args: nativeArgs }),
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        type: 'stdio',
      },
    };
  }

  if (server.url === undefined) {
    diagnostics.push(errorDiagnostic('codex.mcp.url.required', `Codex MCP server "${server.name}" requires a URL.`));
    return { diagnostics };
  }
  const url = convertCodexValue(server.url, 'url', false, diagnostics);
  const headers = server.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => {
        if (hasPathToken(key)) {
          diagnostics.push(errorDiagnostic('codex.mcp.token.headers.key', `Codex MCP header key "${key}" cannot use a path token.`));
        }
        return [key, convertCodexValue(value, `headers.${key}`, false, diagnostics)];
      }));
  if (diagnostics.length > 0 || url === undefined || Object.values(headers ?? {}).some((value) => value === undefined)) {
    return { diagnostics };
  }
  return {
    diagnostics,
    value: {
      ...(headers === undefined ? {} : { headers }),
      type: 'streamable-http',
      url,
    },
  };
};

export interface CodexArtifactPlanOptions {
  /** Artifact-relative path for the Codex MCP document; the unified bundle relocates it. */
  readonly mcpRelativePath?: string;
  /** Manifest validator override matching a relocated MCP pointer; defaults to the pinned host schema. */
  readonly pluginDocumentValidator?: ValidateFunction;
  /** Target name used for selection and provenance; native hooks stay keyed to Codex. */
  readonly targetName?: string;
}

export const planCodexArtifacts = (
  model: NormalizedPlugin,
  options: CodexArtifactPlanOptions = {},
): TargetArtifactPlan => {
  const targetName = options.targetName ?? codexName;
  const mcpRelativePath = options.mcpRelativePath ?? '.mcp.json';
  const isSelected = (targets: readonly string[]): boolean => targets.includes(targetName);
  const diagnostics: Diagnostic[] = [];
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!isSelected(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) servers[server.name] = serverPlan.value;
  }

  const mcp = Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
  const mcpValid = mcp !== undefined && validateMcp(mcp);
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', mcpValid, validateMcp.errors));
  const generatedHooks = planHooks(model, targetName, hookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  if (generatedHooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(generatedHooks.document), validateHooks.errors));
  }
  const nativeHooks = validatedNativeHookDocument(model, codexName, 'Codex', validateHooks, errorDiagnostic);
  diagnostics.push(...nativeHooks.diagnostics);
  const hookDocument = mergeHookDocuments(generatedHooks.document, nativeHooks.document);
  const hookDocumentValid = hookDocument !== undefined && validateHooks(hookDocument);

  const description = model.metadata.description ?? model.metadata.name;
  const interfaceMetadata = {
    capabilities: [
      ...(mcp === undefined ? [] : ['mcp']),
      ...(hookDocument === undefined ? [] : ['hooks']),
      ...(model.skills.some((skill) => isSelected(skill.targets)) ? ['skills'] : []),
    ],
    defaultPrompt: [`Help me use ${model.metadata.name}.`],
    developerName: model.metadata.name,
  };
  const plugin = {
    author: { name: model.metadata.name },
    description,
    interface: {
      ...interfaceMetadata,
      category: 'Productivity',
      displayName: model.metadata.name,
      longDescription: description,
      shortDescription: description,
    },
    ...(mcp === undefined ? {} : { mcpServers: `./${mcpRelativePath}` }),
    ...(hookDocument === undefined ? {} : { hooks: `./${hookContract.manifestPath}` }),
    name: model.metadata.name,
    skills: './skills/',
    version: model.metadata.version,
  };
  const pluginValidator = options.pluginDocumentValidator ?? validatePlugin;
  diagnostics.push(...schemaDiagnostics('plugin', pluginValidator(plugin), pluginValidator.errors));

  const marketplace = model.marketplace !== true ? undefined : {
    interface: { displayName: model.metadata.name },
    name: `${model.metadata.name}-marketplace`,
    plugins: [{
      category: 'Productivity',
      name: model.metadata.name,
      policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
      source: { path: './', source: 'local' },
    }],
  };
  const marketplaceValid = marketplace !== undefined && validateMarketplace(marketplace);
  if (marketplace !== undefined) {
    diagnostics.push(...schemaDiagnostics('marketplace', marketplaceValid, validateMarketplace.errors));
  }

  return standardPluginArtifactPlan({
    diagnostics,
    hookDocument,
    hookDocumentValid,
    hookEntries: generatedHooks.hookEntries,
    hookManifestPath: hookContract.manifestPath,
    isSelected,
    marketplace,
    marketplaceRelativePath: '.agents/plugins/marketplace.json',
    marketplaceValid,
    mcp,
    mcpRelativePath,
    mcpValid,
    model,
    nativeHookTargetNames: [codexName],
    plugin,
    pluginRelativePath: '.codex-plugin/plugin.json',
    targetName,
  });
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => planCodexArtifacts(model);

export const codexAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: standardArtifactLayout,
  capabilities: Object.freeze({
    marketplace: true,
    hooks: true,
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: codexName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: codexName,
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.codex?.nativeHooks,
  plan,
});
