import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import {
  pathTokens,
  type AgentBundlePortableConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import capabilityTable from './capabilities/portable-1.0.0.json' with { type: 'json' };
import schemaProvenance from './schemas/portable/PROVENANCE.json' with { type: 'json' };
import mcpSchema from './schemas/portable/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/portable/plugin.schema.json' with { type: 'json' };
import type {
  TargetAdapter,
  TargetArtifactEntry,
  TargetArtifactPlan,
} from './types.ts';

export interface PortableConfigExtension {
  portable?: AgentBundlePortableConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    portable?: AgentBundlePortableConfig;
  }
}

const portablePluginSchema =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const portableMcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const portableName = 'portable';
const schemaValidator = new Ajv2020({ allErrors: true, strict: false });
const validatePlugin = schemaValidator.compile(pluginSchema);
const validateMcp = schemaValidator.compile(mcpSchema);
const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: capabilityTable.observedSpecificationVersion,
  capabilitySha256: '84d75e50296ed0acf393742bd3934f90ff756bbd4fe5684a01b3fb4a284ee819',
  observedVersion: capabilityTable.observedSpecificationVersion,
  schemas: Object.freeze(
    Object.entries(schemaProvenance.schemas)
      .map(([fileName, schema]) => Object.freeze({
        name: fileName.replace(/\.schema\.json$/, ''),
        revision: schemaProvenance.version,
        sha256: schema.sha256,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  ),
});

const errorDiagnostic = (code: string, message: string): Diagnostic => ({
  code,
  message,
  severity: 'error',
  target: portableName,
});

const containsToken = (value: string): boolean =>
  Object.values(pathTokens).some((token) => value.includes(token));

const expandPortableToken = (value: string): string =>
  value
    .replaceAll(pathTokens.pluginRoot, '${PLUGIN_ROOT}')
    .replaceAll(pathTokens.pluginData, '${PLUGIN_DATA}');

const unsupportedTokenDiagnostic = (
  value: string,
  location: string,
): Diagnostic | undefined => {
  if (value.includes(pathTokens.workspaceRoot)) {
    return errorDiagnostic(
      'portable.mcp.token.workspace-root',
      `Portable MCP ${location} cannot use the workspace-root path token.`,
    );
  }

  if (!containsToken(value)) {
    return undefined;
  }

  return errorDiagnostic(
    `portable.mcp.token.${location}`,
    `Portable MCP ${location} cannot use a path token.`,
  );
};

const schemaDiagnostics = (
  name: 'plugin' | 'mcp',
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): Diagnostic[] =>
  valid
    ? []
    : [
        errorDiagnostic(
          `portable.schema.${name}`,
          `Portable ${name}.json is invalid: ${(errors ?? [])
            .map(
              (error) =>
                `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`,
            )
            .join('; ') || 'schema validation failed'}.`,
        ),
      ];

const hasPortableTarget = (targets: readonly string[]): boolean =>
  targets.includes(portableName);

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const diagnostics: Diagnostic[] = [];

  if (server.transport === 'stdio') {
    const args = server.args?.map((argument, index) => {
      if (argument.includes(pathTokens.workspaceRoot)) {
        diagnostics.push(
          errorDiagnostic(
            'portable.mcp.token.workspace-root',
            `Portable MCP args[${index}] cannot use the workspace-root path token.`,
          ),
        );
      }
      return expandPortableToken(argument);
    });
    if (server.command === undefined) {
      diagnostics.push(
        errorDiagnostic('portable.mcp.command.required', `Portable MCP server "${server.name}" requires a command.`),
      );
    } else {
      const diagnostic = unsupportedTokenDiagnostic(server.command, 'command');
      if (diagnostic !== undefined) diagnostics.push(diagnostic);
    }
    const env = server.env === undefined ? undefined : Object.fromEntries(
      Object.entries(server.env).map(([key, value]) => {
        const keyDiagnostic = unsupportedTokenDiagnostic(key, 'env-key');
        if (keyDiagnostic !== undefined) diagnostics.push(keyDiagnostic);
        if (value.includes(pathTokens.workspaceRoot)) {
          diagnostics.push(
            errorDiagnostic(
              'portable.mcp.token.workspace-root',
              `Portable MCP env value for "${key}" cannot use the workspace-root path token.`,
            ),
          );
        }
        return [key, expandPortableToken(value)];
      }),
    );
    const cwd = server.cwd === undefined ? undefined : expandPortableToken(server.cwd);
    if (server.cwd?.includes(pathTokens.workspaceRoot)) {
      diagnostics.push(
        errorDiagnostic(
          'portable.mcp.token.workspace-root',
          'Portable MCP cwd cannot use the workspace-root path token.',
        ),
      );
    }

    if (diagnostics.length > 0 || server.command === undefined) {
      return { diagnostics };
    }

    return {
      diagnostics,
      value: {
        ...(args === undefined ? {} : { args }),
        command: server.command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        type: server.transport,
      },
    };
  }

  if (server.url === undefined) {
    diagnostics.push(
      errorDiagnostic('portable.mcp.url.required', `Portable MCP server "${server.name}" requires a URL.`),
    );
  } else {
    const diagnostic = unsupportedTokenDiagnostic(server.url, 'url');
    if (diagnostic !== undefined) diagnostics.push(diagnostic);
  }

  if (server.headers !== undefined) {
    for (const [key, value] of Object.entries(server.headers)) {
      const keyDiagnostic = unsupportedTokenDiagnostic(key, 'headers');
      const valueDiagnostic = unsupportedTokenDiagnostic(value, 'headers');
      if (keyDiagnostic !== undefined) diagnostics.push(keyDiagnostic);
      if (valueDiagnostic !== undefined) diagnostics.push(valueDiagnostic);
    }
  }

  if (diagnostics.length > 0 || server.url === undefined) {
    return { diagnostics };
  }

  return {
    diagnostics,
    value: {
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      type: server.transport,
      url: server.url,
    },
  };
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  const plugin = {
    $schema: portablePluginSchema,
    ...(model.metadata.description === undefined
      ? {}
      : { description: model.metadata.description }),
    name: model.metadata.name,
    version: model.metadata.version,
  };
  const entries: TargetArtifactEntry[] = [
    {
      content: `${stableJson(plugin)}\n`,
      kind: 'write',
      relativePath: 'plugin.json',
    },
  ];
  diagnostics.push(...schemaDiagnostics('plugin', validatePlugin(plugin), validatePlugin.errors));

  for (const skill of model.skills) {
    if (!hasPortableTarget(skill.targets)) continue;
    for (const resource of skill.resources) {
      entries.push({
        bytes: resource.bytes,
        kind: 'copy',
        relativePath: `skills/${skill.name}/${resource.relativePath}`,
        source: resource.source,
      });
    }
  }

  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const server of model.mcpServers) {
    if (!hasPortableTarget(server.targets)) continue;
    const serverPlan = planMcpServer(server);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) {
      servers[server.name] = serverPlan.value;
    }
  }

  if (Object.keys(servers).length > 0) {
    const mcp = { $schema: portableMcpSchema, mcpServers: servers };
    const mcpDiagnostics = schemaDiagnostics('mcp', validateMcp(mcp), validateMcp.errors);
    diagnostics.push(...mcpDiagnostics);
    if (mcpDiagnostics.length === 0) {
      entries.push({
        content: `${stableJson(mcp)}\n`,
        kind: 'write',
        relativePath: 'mcp.json',
      });
    }
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: Object.freeze(entries),
    hookEntries: Object.freeze([]),
  });
};

export const portableAdapter: TargetAdapter = Object.freeze({
  capabilities: Object.freeze({
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    sse: capabilityTable.mcp.sse,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: portableName }),
  metadata,
  mcpPathTokens: Object.freeze({
    args: Object.freeze({ '${PLUGIN_DATA}': 'pluginData', '${PLUGIN_ROOT}': 'pluginRoot' }),
    cwd: Object.freeze({ '${PLUGIN_DATA}': 'pluginData', '${PLUGIN_ROOT}': 'pluginRoot' }),
    env: Object.freeze({ '${PLUGIN_DATA}': 'pluginData', '${PLUGIN_ROOT}': 'pluginRoot' }),
  }),
  name: portableName,
  plan,
  validateModel: (model: NormalizedPlugin) => plan(model).diagnostics.slice(),
});
