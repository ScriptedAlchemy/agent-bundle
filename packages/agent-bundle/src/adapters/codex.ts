import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { posix } from 'node:path';

import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import {
  pathTokens,
  type AgentBundleHostConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import capabilityTable from './capabilities/codex-0.147.0.json' with { type: 'json' };
import { mergeHookDocuments, nativeHooksFor, planHooks } from './hook-contract.ts';
import schemaProvenance from './schemas/codex/PROVENANCE.json' with { type: 'json' };
import hooksSchema from './schemas/codex/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/codex/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/codex/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/codex/plugin.schema.json' with { type: 'json' };
import type { TargetAdapter, TargetArtifactEntry, TargetArtifactPlan } from './types.ts';

export interface CodexConfigExtension {
  codex?: AgentBundleHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    codex?: AgentBundleHostConfig;
  }
}

const codexName = 'codex';
const installFormats = addFormats as unknown as (target: Ajv2020) => void;
const validator = new Ajv2020({ allErrors: true, strict: false });
installFormats(validator);
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: capabilityTable.observedCliVersion,
  capabilitySha256: '1110ec8e35904d69f86ad8b9d5b886fa9fb4f0647876e6b79d4287aa4513e484',
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
  target: codexName,
});

const schemaDiagnostics = (
  document: 'plugin' | 'mcp' | 'marketplace' | 'hooks',
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): Diagnostic[] => valid
  ? []
  : [errorDiagnostic(
      `codex.schema.${document}`,
      `Codex ${document}.json is invalid: ${(errors ?? [])
        .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
        .join('; ') || 'schema validation failed'}.`,
    )];

const selectedForCodex = (targets: readonly string[]): boolean => targets.includes(codexName);

const sourceInputs = (...sources: readonly (string | undefined)[]): readonly string[] =>
  Object.freeze([...new Set(sources.filter((source): source is string => source !== undefined))]);

const sortedEntries = (entries: TargetArtifactEntry[]): readonly TargetArtifactEntry[] => Object.freeze(
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
);

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
  const diagnostics: Diagnostic[] = [];
  if (server.transport === 'sse') {
    diagnostics.push(errorDiagnostic(
      'codex.mcp.transport.sse',
      `Codex CLI ${capabilityTable.observedCliVersion} does not support SSE MCP server "${server.name}".`,
    ));
    return { diagnostics };
  }

  if (server.transport === 'stdio') {
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
          if (key.includes(pathTokens.pluginRoot) || key.includes(pathTokens.pluginData) || key.includes(pathTokens.workspaceRoot)) {
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
        if (key.includes(pathTokens.pluginRoot) || key.includes(pathTokens.pluginData) || key.includes(pathTokens.workspaceRoot)) {
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

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!selectedForCodex(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) servers[server.name] = serverPlan.value;
  }

  const mcp = Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', validateMcp(mcp), validateMcp.errors));
  const generatedHooks = planHooks(model, {
    commandRoot: '${PLUGIN_ROOT}',
    eventNames: capabilityTable.hooks.events,
    matchers: capabilityTable.hooks.matchers,
    target: codexName,
  });
  diagnostics.push(...generatedHooks.diagnostics);
  if (generatedHooks.document !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', validateHooks(generatedHooks.document), validateHooks.errors));
  }
  const nativeHooks = nativeHooksFor(model, codexName);
  let nativeHookDocument: Record<string, unknown> | undefined;
  if (nativeHooks?.issue !== undefined) {
    diagnostics.push(errorDiagnostic(
      `codex.native-hooks.${nativeHooks.issue}`,
      `Codex native hooks file ${JSON.stringify(nativeHooks.source)} could not be ${nativeHooks.issue === 'missing' ? 'found' : 'parsed'}.`,
    ));
  } else if (nativeHooks?.document !== undefined) {
    if (!validateHooks(nativeHooks.document)) {
      diagnostics.push(errorDiagnostic(
        'codex.native-hooks.schema',
        `Codex native hooks file ${JSON.stringify(nativeHooks.source)} is invalid: ${(validateHooks.errors ?? [])
          .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
          .join('; ') || 'schema validation failed'}.`,
      ));
    } else {
      nativeHookDocument = nativeHooks.document as Record<string, unknown>;
    }
  }
  const hookDocument = mergeHookDocuments(generatedHooks.document, nativeHookDocument);

  const description = model.metadata.description ?? model.metadata.name;
  const interfaceMetadata = {
    capabilities: [
      ...(mcp === undefined ? [] : ['mcp']),
      ...(hookDocument === undefined ? [] : ['hooks']),
      ...(model.skills.some((skill) => selectedForCodex(skill.targets)) ? ['skills'] : []),
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
    ...(mcp === undefined ? {} : { mcpServers: './.mcp.json' }),
    ...(hookDocument === undefined ? {} : { hooks: './hooks/hooks.json' }),
    name: model.metadata.name,
    skills: './skills/',
    version: model.metadata.version,
  };
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

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
  if (marketplace !== undefined) {
    diagnostics.push(...schemaDiagnostics('marketplace', validateMarketplace(marketplace), validateMarketplace.errors));
  }

  const targetSourceInputs = model.targets
    .filter((target) => target.name === codexName)
    .map((target) => target.provenance.sourcePath);
  const mcpSourceInputs = model.mcpServers
    .filter((server) => selectedForCodex(server.targets))
    .map((server) => server.provenance.sourcePath);
  const hookSourceInputs = model.hooks
    .filter((hook) => selectedForCodex(hook.targets))
    .map((hook) => hook.provenance.sourcePath);
  const nativeHookSourceInputs = model.nativeHooks
    ?.filter((hook) => hook.target === codexName)
    .flatMap((hook) => [hook.provenance.sourcePath, hook.source]) ?? [];
  const skillSourceInputs = model.skills
    .filter((skill) => selectedForCodex(skill.targets))
    .map((skill) => skill.source);

  const entries: TargetArtifactEntry[] = [{
    content: `${stableJson(plugin)}\n`,
    kind: 'write',
    relativePath: '.codex-plugin/plugin.json',
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
      relativePath: 'hooks/hooks.json',
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
      relativePath: '.agents/plugins/marketplace.json',
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
    });
  }
  for (const skill of model.skills) {
    if (!selectedForCodex(skill.targets)) continue;
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

export const codexAdapter: TargetAdapter = Object.freeze({
  capabilities: Object.freeze({
    marketplace: true,
    hooks: true,
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    sse: capabilityTable.mcp.sse,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: codexName }),
  metadata,
  mcpPathTokens: Object.freeze({
    args: Object.freeze({}),
    cwd: Object.freeze({}),
    env: Object.freeze({}),
  }),
  name: codexName,
  nativeHookSource: (config) => config.codex?.nativeHooks,
  plan,
  validateModel: (model: NormalizedPlugin) => [...plan(model).diagnostics],
});
