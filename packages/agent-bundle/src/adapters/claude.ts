import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { pathTokens, type NormalizedMcpServer, type NormalizedPlugin } from '../core/types.ts';
import capabilityTable from './capabilities/claude-2.1.232.json' with { type: 'json' };
import { planHooks } from './hook-contract.ts';
import hooksSchema from './schemas/claude/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/claude/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/claude/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import type { TargetAdapter, TargetArtifactEntry, TargetArtifactPlan } from './types.ts';

const claudeName = 'claude';
const installFormats = addFormats as unknown as (target: Ajv2020) => void;
const validator = new Ajv2020({ allErrors: true, strict: false });
installFormats(validator);
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);

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
  const hooks = planHooks(model, {
    commandRoot: '${CLAUDE_PLUGIN_ROOT}',
    eventNames: capabilityTable.hooks.events,
    matchers: capabilityTable.hooks.matchers,
    target: claudeName,
  });
  diagnostics.push(...hooks.diagnostics);
  if (hooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(hooks.document), validateHooks.errors));
  }

  const plugin = {
    author: { name: model.metadata.name },
    description: model.metadata.description ?? model.metadata.name,
    ...(hooks.document === undefined ? {} : { hooks: './hooks/hooks.json' }),
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

  const entries: TargetArtifactEntry[] = [{
    content: `${stableJson(plugin)}\n`,
    kind: 'write',
    relativePath: '.claude-plugin/plugin.json',
  }];
  if (mcp !== undefined && validateMcp(mcp)) {
    entries.push({ content: `${stableJson(mcp)}\n`, kind: 'write', relativePath: '.mcp.json' });
  }
  if (hooks.document !== undefined && validateHooks(hooks.document)) {
    entries.push({ content: `${stableJson(hooks.document)}\n`, kind: 'write', relativePath: 'hooks/hooks.json' });
  }
  if (marketplace !== undefined && validateMarketplace(marketplace)) {
    entries.push({ content: `${stableJson(marketplace)}\n`, kind: 'write', relativePath: '.claude-plugin/marketplace.json' });
  }
  for (const skill of model.skills) {
    if (!selectedForClaude(skill.targets)) continue;
    for (const resource of skill.resources) {
      entries.push({
        bytes: resource.bytes,
        kind: 'copy',
        relativePath: `skills/${skill.name}/${resource.relativePath}`,
        source: resource.source,
      });
    }
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hooks.document !== undefined && validateHooks(hooks.document)
      ? hooks.hookEntries
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
  name: claudeName,
  plan,
  validateModel: (model: NormalizedPlugin) => [...plan(model).diagnostics],
});
