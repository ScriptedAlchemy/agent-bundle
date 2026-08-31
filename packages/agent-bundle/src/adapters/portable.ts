import { createTargetDiagnostics } from './diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  pathTokens,
  type AgentBundlePortableConfig,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import capabilityTable from './capabilities/portable-1.0.0.json' with { type: 'json' };
import schemaProvenance from './schemas/portable/PROVENANCE.json' with { type: 'json' };
import mcpSchema from './schemas/portable/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/portable/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  payloadCopyEntries,
  schemaDescriptorsFrom,
  sourceInputs,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
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
const schemaValidator = createAdapterValidator();
const validatePlugin = schemaValidator.compile(pluginSchema);
const validateMcp = schemaValidator.compile(mcpSchema);
const metadata = Object.freeze({
  adapterRevision: '1.1.0',
  capabilityRevision: capabilityTable.observedSpecificationVersion,
  capabilitySha256: '642da9f921374a4d0143da21ed4b4b2260a2375a5eb33c4cbb4ef531f2bb7352',
  observedVersion: capabilityTable.observedSpecificationVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.version),
});

const artifactValidation = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ path: 'mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: 'plugin.json', required: true, schema: 'plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ]),
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: 'mcp.json',
  remoteTypes: ['streamable-http'],
  validatedButNonModernRemoteTypes: ['sse'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: portableName,
    tokens: allMcpPathTokenFields(Object.freeze({
      '${PLUGIN_DATA}': 'pluginData',
      '${PLUGIN_ROOT}': 'pluginRoot',
    })),
  }),
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

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(portableName, 'Portable');

const hasPortableTarget = (targets: readonly string[]): boolean =>
  targets.includes(portableName);

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const diagnostics: Diagnostic[] = [];

  if (transport === 'stdio') {
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
    const declaredEnv = server.env === undefined ? undefined : Object.fromEntries(
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
        env: withPluginRootEnvAnchor(declaredEnv, expandPortableToken(pathTokens.pluginRoot)),
        type: transport,
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
      type: 'streamable-http',
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
      sourceInputs: sourceInputs(
        model.metadata.provenance.sourcePath,
        ...model.targets.filter((target) => target.name === portableName).map((target) => target.provenance.sourcePath),
      ),
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
        sourceInputs: sourceInputs(skill.source, resource.source),
      });
    }
  }

  for (const asset of model.assets ?? []) {
    if (!hasPortableTarget(asset.targets)) continue;
    entries.push({
      bytes: asset.bytes,
      kind: 'copy',
      relativePath: `assets/${asset.relativePath}`,
      source: asset.source,
      sourceInputs: sourceInputs(asset.source),
    });
  }

  entries.push(...payloadCopyEntries(model, hasPortableTarget));

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
        sourceInputs: sourceInputs(...model.mcpServers
          .filter((server) => hasPortableTarget(server.targets))
          .map((server) => server.provenance.sourcePath)),
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
  artifactValidation,
  artifactLayout: Object.freeze({
    assets: 'assets',
    mcpApps: Object.freeze({ allowedSuffixes: Object.freeze(['.html']), directory: 'mcp-apps' }),
    mcpEntries: Object.freeze({ allowedSuffixes: Object.freeze(['.mjs']), directory: 'mcp' }),
    scripts: Object.freeze({ allowedSuffixes: Object.freeze(['.bash', '.mjs', '.py', '.sh']), directory: 'scripts' }),
    skills: 'skills',
  }),
  capabilities: Object.freeze({
    mcp: capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
    skills: capabilityTable.plugin.skills,
  }),
  configExtension: Object.freeze({ key: portableName }),
  metadata,
  mcpRuntime,
  name: portableName,
  plan,
});
