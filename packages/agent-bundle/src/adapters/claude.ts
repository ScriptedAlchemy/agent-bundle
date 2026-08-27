import { createTargetDiagnostics } from './diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleHostConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import capabilityTable from './capabilities/claude-2.1.232.json' with { type: 'json' };
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
import schemaProvenance from './schemas/claude/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/claude/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/claude/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/claude/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  hasPathToken,
  schemaDescriptorsFrom,
  sortedEntries,
  sourceInputs,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
} from './types.ts';

export interface ClaudeConfigExtension {
  claude?: AgentBundleHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    claude?: AgentBundleHostConfig;
  }
}

const claudeName = 'claude';
const validator = createAdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);
const hookContract = Object.freeze({
  commandRoot: '${CLAUDE_PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: encodeNativeHookPlaygroundOutput,
  eventNames: capabilityTable.hooks.events,
  manifestPath: 'hooks/hooks.json',
  matchers: capabilityTable.hooks.matchers,
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Claude'),
} satisfies TargetHookContract);
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: capabilityTable.observedCliVersion,
  capabilitySha256: 'ebab02950c9b5b82f9eed7210b8b12b0ba11dc6271d1e93155bd25a2b42377c3',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});

const artifactValidation = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ path: 'hooks/hooks.json', required: false, schema: 'hooks' }),
    Object.freeze({ path: '.claude-plugin/marketplace.json', required: false, schema: 'marketplace' }),
    Object.freeze({ path: '.mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: '.claude-plugin/plugin.json', required: true, schema: 'plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ]),
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: '.mcp.json',
  remoteTypes: ['http'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: claudeName,
    tokens: allMcpPathTokenFields(Object.freeze({
      '${CLAUDE_PLUGIN_DATA}': 'pluginData',
      '${CLAUDE_PLUGIN_ROOT}': 'pluginRoot',
      '${CLAUDE_PROJECT_DIR}': 'workspaceRoot',
    })),
  }),
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(claudeName, 'Claude');

const selectedForClaude = (targets: readonly string[]): boolean => targets.includes(claudeName);

const expandClaudeToken = (value: string): string => value
  .replaceAll(pathTokens.pluginRoot, '${CLAUDE_PLUGIN_ROOT}')
  .replaceAll(pathTokens.pluginData, '${CLAUDE_PLUGIN_DATA}')
  .replaceAll(pathTokens.workspaceRoot, '${CLAUDE_PROJECT_DIR}');

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const diagnostics: Diagnostic[] = [];
  if (transport === 'stdio') {
    if (server.command === undefined) {
      diagnostics.push(errorDiagnostic('claude.mcp.command.required', `Claude MCP server "${server.name}" requires a command.`));
      return { diagnostics };
    }
    const env = server.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.env).map(([key, value]) => {
          if (hasPathToken(key)) {
            diagnostics.push(errorDiagnostic(
              'claude.mcp.token.env.key',
              `Claude MCP environment key "${key}" cannot use a path token.`,
            ));
          }
          return [key, expandClaudeToken(value)];
        }));
    if (diagnostics.length > 0) return { diagnostics };
    return {
      diagnostics,
      value: {
        ...(server.args === undefined ? {} : { args: server.args.map(expandClaudeToken) }),
        command: expandClaudeToken(server.command),
        ...(server.cwd === undefined ? {} : { cwd: expandClaudeToken(server.cwd) }),
        ...(env === undefined ? {} : { env }),
        type: 'stdio',
      },
    };
  }

  if (server.url === undefined) {
    diagnostics.push(errorDiagnostic('claude.mcp.url.required', `Claude MCP server "${server.name}" requires a URL.`));
    return { diagnostics };
  }
  const headers = server.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => {
        if (hasPathToken(key)) {
          diagnostics.push(errorDiagnostic(
            'claude.mcp.token.headers.key',
            `Claude MCP header key "${key}" cannot use a path token.`,
          ));
        }
        return [key, expandClaudeToken(value)];
      }));
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    value: {
      ...(headers === undefined ? {} : { headers }),
      type: 'http',
      url: expandClaudeToken(server.url),
    },
  };
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!selectedForClaude(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) servers[server.name] = serverPlan.value;
  }
  const mcp = Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
  const mcpValid = mcp !== undefined && validateMcp(mcp);
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', mcpValid, validateMcp.errors));
  const generatedHooks = planHooks(model, claudeName, hookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  if (generatedHooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(generatedHooks.document), validateHooks.errors));
  }
  const nativeHooks = validatedNativeHookDocument(model, claudeName, 'Claude', validateHooks, errorDiagnostic);
  diagnostics.push(...nativeHooks.diagnostics);
  const hookDocument = mergeHookDocuments(generatedHooks.document, nativeHooks.document);
  const hookDocumentValid = hookDocument !== undefined && validateHooks(hookDocument);

  const plugin = {
    author: { name: model.metadata.name },
    description: model.metadata.description ?? model.metadata.name,
    ...(hookDocument === undefined ? {} : { hooks: `./${hookContract.manifestPath}` }),
    name: model.metadata.name,
    version: model.metadata.version,
  };
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  const marketplace = model.marketplace !== true ? undefined : {
    description: model.metadata.description ?? model.metadata.name,
    name: `${model.metadata.name}-marketplace`,
    owner: { name: model.metadata.name },
    plugins: [{
      description: model.metadata.description ?? model.metadata.name,
      name: model.metadata.name,
      source: './',
      version: model.metadata.version,
    }],
  };
  const marketplaceValid = marketplace !== undefined && validateMarketplace(marketplace);
  if (marketplace !== undefined) {
    diagnostics.push(...schemaDiagnostics('marketplace', marketplaceValid, validateMarketplace.errors));
  }

  const targetSourceInputs = model.targets
    .filter((target) => target.name === claudeName)
    .map((target) => target.provenance.sourcePath);
  const mcpSourceInputs = model.mcpServers
    .filter((server) => selectedForClaude(server.targets))
    .map((server) => server.provenance.sourcePath);
  const hookSourceInputs = model.hooks
    .filter((hook) => selectedForClaude(hook.targets))
    .map((hook) => hook.provenance.sourcePath);
  const nativeHookSourceInputs = model.nativeHooks
    ?.filter((hook) => hook.target === claudeName)
    .flatMap((hook) => [hook.provenance.sourcePath, hook.source]) ?? [];
  const skillSourceInputs = model.skills
    .filter((skill) => selectedForClaude(skill.targets))
    .map((skill) => skill.source);

  const entries: TargetArtifactEntry[] = [{
    content: `${stableJson(plugin)}\n`,
    kind: 'write',
    relativePath: '.claude-plugin/plugin.json',
    sourceInputs: sourceInputs(
      model.metadata.provenance.sourcePath,
      ...targetSourceInputs,
      ...mcpSourceInputs,
      ...hookSourceInputs,
      ...nativeHookSourceInputs,
      ...skillSourceInputs,
    ),
  }];
  if (mcp !== undefined && mcpValid) {
    entries.push({
      content: `${stableJson(mcp)}\n`,
      kind: 'write',
      relativePath: '.mcp.json',
      sourceInputs: sourceInputs(...targetSourceInputs, ...mcpSourceInputs),
    });
  }
  if (hookDocument !== undefined && hookDocumentValid) {
    entries.push({
      content: `${stableJson(hookDocument)}\n`,
      kind: 'write',
      relativePath: hookContract.manifestPath,
      sourceInputs: sourceInputs(
        ...targetSourceInputs,
        ...hookSourceInputs,
        ...nativeHookSourceInputs,
      ),
    });
  }
  if (marketplace !== undefined && marketplaceValid) {
    entries.push({
      content: `${stableJson(marketplace)}\n`,
      kind: 'write',
      relativePath: '.claude-plugin/marketplace.json',
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
    });
  }
  for (const skill of model.skills) {
    if (!selectedForClaude(skill.targets)) continue;
    for (const resource of skill.resources) {
      entries.push({
        bytes: resource.bytes,
        kind: 'copy',
        relativePath: `skills/${skill.name}/${resource.relativePath}`,
        source: resource.source,
        sourceInputs: sourceInputs(skill.source, resource.source),
      });
    }
  }

  for (const asset of model.assets ?? []) {
    if (!selectedForClaude(asset.targets)) continue;
    entries.push({
      bytes: asset.bytes,
      kind: 'copy',
      relativePath: `assets/${asset.relativePath}`,
      source: asset.source,
      sourceInputs: sourceInputs(asset.source),
    });
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hookDocumentValid ? generatedHooks.hookEntries : Object.freeze([]),
  });
};

export const claudeAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: Object.freeze({
    hookWrappers: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'hooks' }),
    mcpApps: Object.freeze({ allowedSuffixes: Object.freeze(['.html']), directory: 'mcp-apps' }),
    mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
    scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.bash', '.mjs', '.py', '.sh']), directory: 'scripts' }),
    skills: 'skills',
  }),
  capabilities: Object.freeze({
    marketplace: true,
    hooks: true,
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: claudeName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: claudeName,
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.claude?.nativeHooks,
  plan,
});
