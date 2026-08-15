import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleHostConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import capabilityTable from './capabilities/claude-2.1.232.json' with { type: 'json' };
import {
  mergeHookDocuments,
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  nativeHooksFor,
  planHooks,
  type TargetHookContract,
} from './hook-contract.ts';
import schemaProvenance from './schemas/claude/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/claude/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/claude/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/claude/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import type { TargetAdapter, TargetArtifactEntry, TargetArtifactPlan } from './types.ts';

export interface ClaudeConfigExtension {
  claude?: AgentBundleHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    claude?: AgentBundleHostConfig;
  }
}

const claudeName = 'claude';
const installFormats = addFormats as unknown as (target: Ajv2020) => void;
const validator = new Ajv2020({ allErrors: true, strict: false });
installFormats(validator);
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
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Claude'),
} satisfies TargetHookContract);
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: capabilityTable.observedCliVersion,
  capabilitySha256: 'fcc2626922c9b65e971c42e1485a1970b55804832fafceac65b1ee1be057ed0b',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: Object.freeze(
    Object.entries(schemaProvenance.schemas)
      .map(([fileName, schema]) => Object.freeze({
        name: fileName.replace(/\.schema\.json$/, ''),
        revision: schemaProvenance.observedCliVersion,
        sha256: schema.sha256,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  ),
});

const errorDiagnostic = (code: string, message: string): Diagnostic => ({
  code,
  message,
  severity: 'error',
  target: claudeName,
});

const schemaDiagnostics = (
  document: 'plugin' | 'mcp' | 'marketplace' | 'hooks',
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): Diagnostic[] => valid
  ? []
  : [errorDiagnostic(
      `claude.schema.${document}`,
      `Claude ${document}.json is invalid: ${(errors ?? [])
        .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
        .join('; ') || 'schema validation failed'}.`,
    )];

const selectedForClaude = (targets: readonly string[]): boolean => targets.includes(claudeName);

const sourceInputs = (...sources: readonly (string | undefined)[]): readonly string[] =>
  Object.freeze([...new Set(sources.filter((source): source is string => source !== undefined))]);

const sortedEntries = (entries: TargetArtifactEntry[]): readonly TargetArtifactEntry[] => Object.freeze(
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
);

const expandClaudeToken = (value: string): string => value
  .replaceAll(pathTokens.pluginRoot, '${CLAUDE_PLUGIN_ROOT}')
  .replaceAll(pathTokens.pluginData, '${CLAUDE_PLUGIN_DATA}')
  .replaceAll(pathTokens.workspaceRoot, '${CLAUDE_PROJECT_DIR}');

const hasPathToken = (value: string): boolean =>
  value.includes(pathTokens.pluginRoot) || value.includes(pathTokens.pluginData) || value.includes(pathTokens.workspaceRoot);

const headerKeyDiagnostic = (key: string): Diagnostic | undefined =>
  hasPathToken(key)
    ? errorDiagnostic('claude.mcp.token.headers.key', `Claude MCP header key "${key}" cannot use a path token.`)
    : undefined;

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const diagnostics: Diagnostic[] = [];
  if (server.transport === 'stdio') {
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
        const diagnostic = headerKeyDiagnostic(key);
        if (diagnostic !== undefined) diagnostics.push(diagnostic);
        return [key, expandClaudeToken(value)];
      }));
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    value: {
      ...(headers === undefined ? {} : { headers }),
      type: server.transport === 'streamable-http' ? 'http' : 'sse',
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
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', validateMcp(mcp), validateMcp.errors));
  const generatedHooks = planHooks(model, claudeName, hookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  if (generatedHooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(generatedHooks.document), validateHooks.errors));
  }
  const nativeHooks = nativeHooksFor(model, claudeName);
  let nativeHookDocument: Record<string, unknown> | undefined;
  if (nativeHooks?.issue === 'missing' || nativeHooks?.issue === 'parse') {
    diagnostics.push(errorDiagnostic(
      `claude.native-hooks.${nativeHooks.issue}`,
      `Claude native hooks file ${JSON.stringify(nativeHooks.source)} could not be ${nativeHooks.issue === 'missing' ? 'found' : 'parsed'}.`,
    ));
  } else if (nativeHooks?.document !== undefined) {
    if (!validateHooks(nativeHooks.document)) {
      diagnostics.push(errorDiagnostic(
        'claude.native-hooks.schema',
        `Claude native hooks file ${JSON.stringify(nativeHooks.source)} is invalid: ${(validateHooks.errors ?? [])
          .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
          .join('; ') || 'schema validation failed'}.`,
      ));
    } else {
      nativeHookDocument = nativeHooks.document as Record<string, unknown>;
    }
  }
  const hookDocument = mergeHookDocuments(generatedHooks.document, nativeHookDocument);

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
  if (marketplace !== undefined) {
    diagnostics.push(...schemaDiagnostics('marketplace', validateMarketplace(marketplace), validateMarketplace.errors));
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
  if (mcp !== undefined && validateMcp(mcp)) {
    entries.push({
      content: `${stableJson(mcp)}\n`,
      kind: 'write',
      relativePath: '.mcp.json',
      sourceInputs: sourceInputs(...targetSourceInputs, ...mcpSourceInputs),
    });
  }
  if (hookDocument !== undefined && validateHooks(hookDocument)) {
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
  if (marketplace !== undefined && validateMarketplace(marketplace)) {
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

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hookDocument !== undefined && validateHooks(hookDocument)
      ? generatedHooks.hookEntries
      : Object.freeze([]),
  });
};

export const claudeAdapter: TargetAdapter = Object.freeze({
  capabilities: Object.freeze({
    marketplace: true,
    hooks: true,
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    sse: capabilityTable.mcp.sse,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: claudeName }),
  hookContract,
  metadata,
  mcpPathTokens: Object.freeze({
    args: Object.freeze({
      '${CLAUDE_PLUGIN_DATA}': 'pluginData',
      '${CLAUDE_PLUGIN_ROOT}': 'pluginRoot',
      '${CLAUDE_PROJECT_DIR}': 'workspaceRoot',
    }),
    cwd: Object.freeze({
      '${CLAUDE_PLUGIN_DATA}': 'pluginData',
      '${CLAUDE_PLUGIN_ROOT}': 'pluginRoot',
      '${CLAUDE_PROJECT_DIR}': 'workspaceRoot',
    }),
    env: Object.freeze({
      '${CLAUDE_PLUGIN_DATA}': 'pluginData',
      '${CLAUDE_PLUGIN_ROOT}': 'pluginRoot',
      '${CLAUDE_PROJECT_DIR}': 'workspaceRoot',
    }),
  }),
  name: claudeName,
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.claude?.nativeHooks,
  plan,
  validateModel: (model: NormalizedPlugin) => [...plan(model).diagnostics],
});
