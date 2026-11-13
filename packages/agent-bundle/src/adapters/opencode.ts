import { createTargetDiagnostics } from './diagnostics.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import { deepFreeze } from '../core/freeze.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import { isPlainDataRecord } from '../core/strict-json.ts';
import {
  pathTokens,
  type NormalizedMcpServer,
  type NormalizedPlugin,
} from '../core/types.ts';
import { createMcpPathTokenResolver, standardMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import {
  capabilityEvidence,
  capabilityStateFromSupport,
  cliBinCapability,
  eventRouteCapabilitiesFrom,
  noticeDeliveryAdvertisementFrom,
  supportedCapability,
  supportedEventRouteNamesFrom,
  unavailableCapability,
  webSurfaceCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/opencode-2.2.6.json' with { type: 'json' };
import {
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  planHooks,
  type TargetHookContract,
  type TargetHookEntry,
} from './hook-contract.ts';
import schemaProvenance from './schemas/opencode/PROVENANCE.json' with { type: 'json' };
import configSchema from './schemas/opencode/config.schema.json' with { type: 'json' };
import mcpSchema from './schemas/opencode/mcp.schema.json' with { type: 'json' };
import modelSchema from './schemas/opencode/model-schema.json' with { type: 'json' };
import packageSchema from './schemas/opencode/package.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  payloadCopyEntries,
  schemaDescriptorsFrom,
  sortedEntries,
  sourceInputs,
  standardArtifactLayout,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
} from './types.ts';

const openCodeName = 'opencode';

/** OpenCode-native target configuration. V2 package loading needs no invented host extension fields. */
export type OpenCodeHostConfig = Readonly<Record<never, never>>;
export interface OpenCodeConfigExtension {
  readonly opencode?: OpenCodeHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    opencode?: OpenCodeHostConfig;
  }
}

export const openCodeArtifactPaths = Object.freeze({
  config: '.opencode/opencode.json',
  entry: 'index.js',
  mcp: 'agent-bundle.mcp.json',
  package: 'package.json',
});

const validator = createAdapterValidator();
validator.addSchema(modelSchema, 'https://models.dev/model-schema.json');
const validateConfig = validator.compile(configSchema);
const validateMcp = validator.compile(mcpSchema);
const validatePackage = validator.compile(packageSchema);
export const openCodeConfigValidator = validateConfig;
export const openCodeMcpValidator = validateMcp;
export const openCodePluginValidator = validatePackage;

const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});
const evidence = capabilityEvidence(openCodeName, metadata);
const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(openCodeName, 'OpenCode V2');

const eventRouteNames = supportedEventRouteNamesFrom(capabilityTable.hooks.eventRoutes);
const hookContract = Object.freeze({
  hostContractRevision: capabilityTable.observedCliVersion,
  commandRoot: '${PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: (result, event, nativeEvent) =>
    encodeNativeHookPlaygroundOutput(result, event, nativeEvent, 'codex'),
  eventNames: capabilityTable.hooks.events,
  eventRouteNames,
  manifestPath: 'agent-bundle.hooks.json',
  matchers: capabilityTable.hooks.matchers,
  registration: 'api',
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Codex'),
} satisfies TargetHookContract);

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: openCodeArtifactPaths.mcp,
  remoteTypes: ['streamable-http'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: openCodeName,
    tokens: {
      args: {
        [pathTokens.pluginRoot]: 'pluginRoot',
        [pathTokens.pluginData]: 'pluginData',
        [pathTokens.workspaceRoot]: 'workspaceRoot',
      },
      cwd: {
        [pathTokens.pluginRoot]: 'pluginRoot',
        [pathTokens.pluginData]: 'pluginData',
        [pathTokens.workspaceRoot]: 'workspaceRoot',
      },
      env: {
        [pathTokens.pluginRoot]: 'pluginRoot',
        [pathTokens.pluginData]: 'pluginData',
        [pathTokens.workspaceRoot]: 'workspaceRoot',
      },
      headers: {
        [pathTokens.pluginRoot]: 'pluginRoot',
        [pathTokens.pluginData]: 'pluginData',
        [pathTokens.workspaceRoot]: 'workspaceRoot',
      },
      url: {
        [pathTokens.pluginRoot]: 'pluginRoot',
        [pathTokens.pluginData]: 'pluginData',
        [pathTokens.workspaceRoot]: 'workspaceRoot',
      },
    },
  }),
});

export interface OpenCodeMcpRoots {
  readonly pluginData: string;
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
}

const replaceOpenCodeTokens = (value: string, roots: OpenCodeMcpRoots): string => value
  .replaceAll(pathTokens.pluginRoot, roots.pluginRoot)
  .replaceAll(pathTokens.pluginData, roots.pluginData)
  .replaceAll(pathTokens.workspaceRoot, roots.workspaceRoot);

/** Converts one entry in the compiler-owned table to the V2 transform's native local/remote shape. */
export const openCodeMcpServer = (
  server: Readonly<Record<string, unknown>>,
  roots: OpenCodeMcpRoots,
): Record<string, unknown> => {
  const resolveValue = (value: unknown): unknown => typeof value === 'string' ? replaceOpenCodeTokens(value, roots) : value;
  if (server['type'] === 'stdio') {
    return {
      ...(Array.isArray(server['args']) || typeof server['command'] === 'string'
        ? {
            command: [
              replaceOpenCodeTokens(String(server['command']), roots),
              ...(Array.isArray(server['args'])
                ? server['args'].map((argument) => replaceOpenCodeTokens(String(argument), roots))
                : []),
            ],
          }
        : {}),
      ...(server['cwd'] === undefined ? {} : { cwd: replaceOpenCodeTokens(String(server['cwd']), roots) }),
      ...(isPlainDataRecord(server['env'])
        ? { environment: Object.fromEntries(Object.entries(server['env']).map(([key, value]) => [key, resolveValue(value)])) }
        : {}),
      type: 'local',
    };
  }
  return {
    ...(isPlainDataRecord(server['headers'])
      ? { headers: Object.fromEntries(Object.entries(server['headers']).map(([key, value]) => [key, resolveValue(value)])) }
      : {}),
    type: 'remote',
    url: replaceOpenCodeTokens(String(server['url']), roots),
  };
};

const planMcpServer = (
  server: NormalizedMcpServer,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const transport = readMcpTransport(server);
  const transportDiagnostic = unsupportedMcpTransportDiagnostic(server, transport);
  if (transportDiagnostic !== undefined) return { diagnostics: [transportDiagnostic] };
  const values = transport === 'stdio'
    ? [server.command, ...(server.args ?? []), server.cwd, ...Object.values(server.env ?? {})]
    : [server.url, ...Object.values(server.headers ?? {})];
  const supportedTokens: readonly string[] = [pathTokens.pluginRoot, pathTokens.pluginData, pathTokens.workspaceRoot];
  for (const value of values) {
    if (value === undefined) continue;
    if (standardMcpPathTokens.some((token) => value.includes(token) && !supportedTokens.includes(token))) {
      return {
        diagnostics: [errorDiagnostic(
          'opencode.mcp.token',
          `MCP server ${JSON.stringify(server.name)} uses a host-specific path token; OpenCode V2 transforms accept only Agent Bundle plugin-root, plugin-data, and workspace-root tokens.`,
        )],
      };
    }
  }
  if (transport === 'stdio') {
    if (server.command === undefined) {
      return { diagnostics: [errorDiagnostic('opencode.mcp.command', `MCP server ${JSON.stringify(server.name)} requires a command.`)] };
    }
    return {
      diagnostics: [],
      value: {
        ...(server.args === undefined ? {} : { args: server.args }),
        command: server.command,
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        ...(server.env === undefined ? {} : { env: server.env }),
        type: 'stdio',
      },
    };
  }
  if (server.url === undefined) {
    return { diagnostics: [errorDiagnostic('opencode.mcp.url', `MCP server ${JSON.stringify(server.name)} requires a URL.`)] };
  }
  return {
    diagnostics: [],
    value: {
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      type: 'streamable-http',
      url: server.url,
    },
  };
};

export const openCodePluginPackage = (model: NormalizedPlugin): Record<string, unknown> => ({
  description: model.metadata.description ?? model.metadata.name,
  engines: { node: '>=22.19.0' },
  exports: { '.': './index.js' },
  name: model.metadata.name,
  type: 'module',
  version: model.metadata.version,
});

const setupSource = (
  model: NormalizedPlugin,
  mcp: Record<string, unknown> | undefined,
  hooks: readonly TargetHookEntry[],
): string => {
  const commands = (model.commands ?? []).filter((command) => command.targets.includes(openCodeName));
  const skills = model.skills.filter((skill) => skill.targets.includes(openCodeName));
  const hookDefinitions = hooks.map((entry) => ({
    event: entry.event,
    matcher: entry.nativeMatcher,
    nativeEvent: entry.nativeEvent,
    path: entry.relativePath,
  }));
  return [
    "import { spawn } from 'node:child_process';",
    "import { readFile } from 'node:fs/promises';",
    "import { dirname, resolve } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    `const pluginRoot = dirname(fileURLToPath(import.meta.url));`,
    `const pluginData = resolve(pluginRoot, 'state');`,
    `const hookDefinitions = Object.freeze(${JSON.stringify(hookDefinitions)});`,
    `const skillDefinitions = Object.freeze(${JSON.stringify(skills.map((skill) => ({
      description: skill.description,
      id: skill.name,
      name: typeof skill.frontmatter['name'] === 'string' ? skill.frontmatter['name'] : skill.name,
      path: `skills/${skill.name}/SKILL.md`,
    })))});`,
    `const commandDefinitions = Object.freeze(${JSON.stringify(commands.map((command) => ({
      description: typeof command.frontmatter['description'] === 'string' ? command.frontmatter['description'] : undefined,
      name: command.name,
      path: `commands/${command.name}.md`,
    })))});`,
    '',
    'const roots = (ctx) => Object.freeze({',
    '  pluginData,',
    '  pluginRoot,',
    '  workspaceRoot: ctx.location.directory,',
    '});',
    'const convertTokens = (value, roots) => value',
    `  .replaceAll(${JSON.stringify(pathTokens.pluginRoot)}, roots.pluginRoot)`,
    `  .replaceAll(${JSON.stringify(pathTokens.pluginData)}, roots.pluginData)`,
    `  .replaceAll(${JSON.stringify(pathTokens.workspaceRoot)}, roots.workspaceRoot);`,
    'const nativeServer = (server, roots) => {',
    '  if (server.type === "stdio") {',
    '    return {',
    '      type: "local",',
    '      command: [convertTokens(server.command, roots), ...(server.args ?? []).map((argument) => convertTokens(argument, roots))],',
    '      ...(server.cwd === undefined ? {} : { cwd: convertTokens(server.cwd, roots) }),',
    '      ...(server.env === undefined ? {} : { environment: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, convertTokens(value, roots)])) }),',
    '    };',
    '  }',
    '  return {',
    '    type: "remote",',
    '    url: convertTokens(server.url, roots),',
    '    ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, convertTokens(value, roots)])) }),',
    '  };',
    '};',
    'const commandText = (template, raw) => {',
    '  const args = [];',
    '  let current = "";',
    '  let quote;',
    '  for (const character of raw.trim()) {',
    '    if (quote !== undefined) {',
    '      if (character === quote) quote = undefined; else current += character;',
    '    } else if (character === "\\\"" || character === "\'") quote = character;',
    '    else if (/\\s/u.test(character)) { if (current !== "") { args.push(current); current = ""; } }',
    '    else current += character;',
    '  }',
    '  if (current !== "") args.push(current);',
    '  const highest = Math.max(0, ...[...template.matchAll(/\\$(\\d+)/gu)].map((match) => Number(match[1])));',
    '  let text = template.replaceAll("$ARGUMENTS", raw);',
    '  for (let index = 1; index <= highest; index += 1) {',
    '    const value = index === highest ? args.slice(index - 1).join(" ") : args[index - 1];',
    '    text = text.replaceAll(`$${index}`, value ?? "");',
    '  }',
    '  if (!template.includes("$ARGUMENTS") && highest === 0 && raw.trim() !== "") text += `\\n\\n${raw}`;',
    '  return text;',
    '};',
    'const runHook = async (definition, native, signal) => {',
    "  const child = spawn('node', [resolve(pluginRoot, definition.path)], { signal, stdio: [\"pipe\", \"pipe\", \"pipe\"] });",
    '  const stdout = [];',
    '  const stderr = [];',
    '  child.stdout.on("data", (chunk) => stdout.push(chunk));',
    '  child.stderr.on("data", (chunk) => stderr.push(chunk));',
    '  child.stdin.end(JSON.stringify(native));',
    '  const code = await new Promise((resolveExit, reject) => {',
    '    child.once("error", reject);',
    '    child.once("close", resolveExit);',
    '  });',
    '  const errors = Buffer.concat(stderr).toString("utf8");',
    '  if (code !== 0) throw new Error(errors.trim() || `OpenCode hook exited with ${String(code)}.`);',
    '  if (errors !== "") process.stderr.write(errors);',
    '  const output = Buffer.concat(stdout).toString("utf8");',
    '  return output === "" ? undefined : JSON.parse(output);',
    '};',
    'const matches = (definition, tool) => definition.matcher === undefined || new RegExp(definition.matcher, "u").test(tool);',
    `const mcpDocument = ${mcp === undefined ? 'undefined' : JSON.stringify(mcp)};`,
    '',
    'export default {',
    `  id: ${JSON.stringify(model.metadata.name)},`,
    '  async setup(ctx) {',
    '    const cleanup = [];',
    '    const pluginRoots = roots(ctx);',
    '    if (mcpDocument !== undefined) {',
    '      cleanup.push(await ctx.mcp.transform((editor) => {',
    '        for (const [name, server] of Object.entries(mcpDocument.mcpServers)) editor.set(name, nativeServer(server, pluginRoots));',
    '      }));',
    '    }',
    '    if (skillDefinitions.length > 0) {',
    '      const skills = await Promise.all(skillDefinitions.map(async (definition) => ({',
    '        ...definition,',
    '        path: resolve(pluginRoot, definition.path),',
    '        content: await readFile(resolve(pluginRoot, definition.path), "utf8"),',
    '      })));',
    '      cleanup.push(await ctx.skill.transform((editor) => {',
    '        for (const skill of skills) editor.add(skill);',
    '      }));',
    '    }',
    '    if (commandDefinitions.length > 0) {',
    '      const commands = await Promise.all(commandDefinitions.map(async (definition) => ({',
    '        ...definition,',
    '        template: await readFile(resolve(pluginRoot, definition.path), "utf8"),',
    '      })));',
    '      cleanup.push(await ctx.command.transform((editor) => {',
    '        for (const command of commands) {',
    '          editor.add({',
    '            name: command.name,',
    '            ...(command.description === undefined ? {} : { description: command.description }),',
    '            execute: async ({ sessionID, prompt, delivery }) => {',
    '              await ctx.session.prompt({ ...prompt, sessionID, text: commandText(command.template, prompt.text), delivery });',
    '            },',
    '          });',
    '        }',
    '      }));',
    '    }',
    '    for (const definition of hookDefinitions) {',
    '      if (definition.nativeEvent === "tool.execute.before") {',
    '        cleanup.push(await ctx.tool.hook("execute.before", async (event) => {',
    '          if (!matches(definition, event.tool)) return;',
    '          await runHook(definition, { hook_event_name: definition.nativeEvent, session_id: event.sessionID, cwd: ctx.location.directory, tool_input: event.input, tool_name: event.tool, tool_use_id: event.id }, new AbortController().signal);',
    '        }));',
    '      } else if (definition.nativeEvent === "tool.execute.after") {',
    '        cleanup.push(await ctx.tool.hook("execute.after", async (event) => {',
    '          if (!matches(definition, event.tool)) return;',
    '          await runHook(definition, { hook_event_name: definition.nativeEvent, session_id: event.sessionID, cwd: ctx.location.directory, tool_input: event.input, tool_name: event.tool, tool_response: event.status === "completed" ? event.result : event.error, tool_use_id: event.id }, new AbortController().signal);',
    '        }));',
    '      } else if (definition.nativeEvent === "session.prompt") {',
    '        cleanup.push(await ctx.session.hook("prompt", async (event) => {',
    '          await runHook(definition, { hook_event_name: definition.nativeEvent, session_id: event.sessionID, cwd: ctx.location.directory, prompt: event.prompt.text }, new AbortController().signal);',
    '        }));',
    '      } else if (definition.nativeEvent === "session.experimental.idle") {',
    '        cleanup.push(await ctx.session.hook("experimental.idle", async (event) => {',
    '          await runHook(definition, { hook_event_name: definition.nativeEvent, session_id: event.sessionID, cwd: ctx.location.directory }, new AbortController().signal);',
    '        }));',
    '      }',
    '    }',
    '    return async () => {',
    '      for (const registration of cleanup.reverse()) await registration.dispose();',
    '    };',
    '  },',
    '};',
    '',
  ].join('\n');
};

export const planOpenCodeArtifacts = (model: NormalizedPlugin): TargetArtifactPlan => {
  const isSelected = (targets: readonly string[]): boolean => targets.includes(openCodeName);
  const diagnostics: Diagnostic[] = [];
  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const server of model.mcpServers) {
    if (!isSelected(server.targets)) continue;
    const planned = planMcpServer(server);
    diagnostics.push(...planned.diagnostics);
    if (planned.value !== undefined) servers[server.name] = planned.value;
  }
  const mcp = Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
  const mcpValid = mcp !== undefined && validateMcp(mcp);
  if (mcp !== undefined) diagnostics.push(...schemaDiagnostics('mcp', mcpValid, validateMcp.errors));
  const plugin = openCodePluginPackage(model);
  diagnostics.push(...schemaDiagnostics('package', validatePackage(plugin), validatePackage.errors));
  const config = {
    $schema: 'https://opencode.ai/config.json',
    plugins: ['..'],
  };
  diagnostics.push(...schemaDiagnostics('config', validateConfig(config), validateConfig.errors));
  for (const hook of model.hooks) {
    if (isSelected(hook.targets) && hook.prebuiltPath !== undefined) {
      diagnostics.push(errorDiagnostic(
        'opencode.hook.prebuilt',
        `OpenCode hook ${JSON.stringify(hook.name)} is prebuilt; native V2 API registration currently requires a compiled wrapper with OpenCode's event ABI.`,
      ));
    }
  }
  const generatedHooks = planHooks(model, openCodeName, hookContract);
  diagnostics.push(...generatedHooks.diagnostics);

  const entries: TargetArtifactEntry[] = [{
    content: `${stableJson(config)}\n`,
    kind: 'write',
    relativePath: openCodeArtifactPaths.config,
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath),
  }, {
    content: `${stableJson(plugin)}\n`,
    kind: 'write',
    relativePath: openCodeArtifactPaths.package,
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath),
  }, {
    content: setupSource(model, mcpValid ? mcp : undefined, generatedHooks.hookEntries),
    kind: 'write',
    relativePath: openCodeArtifactPaths.entry,
    sourceInputs: sourceInputs(
      model.metadata.provenance.sourcePath,
      ...model.commands?.filter((command) => isSelected(command.targets)).map((command) => command.source) ?? [],
      ...model.skills.filter((skill) => isSelected(skill.targets)).map((skill) => skill.source),
      ...model.mcpServers.filter((server) => isSelected(server.targets)).map((server) => server.provenance.sourcePath),
      ...model.hooks.filter((hook) => isSelected(hook.targets)).map((hook) => hook.provenance.sourcePath),
    ),
  }];
  if (mcp !== undefined && mcpValid) {
    entries.push({
      content: `${stableJson(mcp)}\n`,
      kind: 'write',
      relativePath: openCodeArtifactPaths.mcp,
      sourceInputs: sourceInputs(...model.mcpServers
        .filter((server) => isSelected(server.targets))
        .map((server) => server.provenance.sourcePath)),
    });
  }
  for (const skill of model.skills) {
    if (!isSelected(skill.targets)) continue;
    if (skill.markdown !== undefined) {
      entries.push({
        content: skill.markdown,
        kind: 'write',
        relativePath: `skills/${skill.name}/SKILL.md`,
        sourceInputs: sourceInputs(skill.source),
      });
    }
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
  for (const command of model.commands ?? []) {
    if (!isSelected(command.targets)) continue;
    entries.push({
      content: command.body,
      kind: 'write',
      relativePath: `commands/${command.name}.md`,
      sourceInputs: sourceInputs(command.source),
    });
  }
  for (const asset of model.assets ?? []) {
    if (!isSelected(asset.targets)) continue;
    entries.push({
      bytes: asset.bytes,
      kind: 'copy',
      relativePath: `assets/${asset.relativePath}`,
      source: asset.source,
      sourceInputs: sourceInputs(asset.source),
    });
  }
  entries.push(...payloadCopyEntries(model, isSelected));
  return deepFreeze({
    diagnostics,
    documents: { entry: openCodeArtifactPaths.entry, plugin: openCodeArtifactPaths.package },
    entries: sortedEntries(entries),
    hookEntries: generatedHooks.hookEntries,
  });
};

const artifactValidation = deepFreeze({
  documents: [
    { path: openCodeArtifactPaths.config, required: true, schema: 'config' },
    { path: openCodeArtifactPaths.mcp, required: false, schema: 'mcp' },
    { path: openCodeArtifactPaths.package, required: true, schema: 'package' },
  ],
  schemas: [
    { name: 'config', validate: validateJsonSchemaDocument(validateConfig) },
    { name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) },
    { name: 'package', validate: validateJsonSchemaDocument(validatePackage) },
  ],
});

export const openCodeAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout: Object.freeze({
    ...standardArtifactLayout,
    commands: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'commands' }),
    rootDocuments: Object.freeze(['INSTALL.md', openCodeArtifactPaths.mcp, openCodeArtifactPaths.entry, openCodeArtifactPaths.package]),
  }),
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
    agents: unavailableCapability(capabilityTable.plugin.agents.reason),
    [cliBinCapability]: supportedCapability(evidence),
    [webSurfaceCapability]: unavailableCapability(capabilityTable.plugin.web.reason),
    commands: supportedCapability(evidence),
    hooks: supportedCapability(evidence),
    'hooks.timeout': unavailableCapability(capabilityTable.hooks.features.timeout.reason),
    'hooks.toolMatchers': supportedCapability(evidence),
    install: supportedCapability(evidence),
    lsp: unavailableCapability('OpenCode V2 plugin packages expose no LSP component at this pin.'),
    marketplace: unavailableCapability(capabilityTable.plugin.marketplace.reason),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'OpenCode V2 supports both local and remote MCP transforms.',
    ),
    nativeDiagnostics: unavailableCapability('OpenCode V2 exposes no plugin-shipped diagnostics-provider component.'),
    nativeExtension: unavailableCapability('OpenCode V2 GUI/TUI extensions are separate package parts, not generated by this server target.'),
    rules: unavailableCapability(capabilityTable.plugin.rules.reason),
    skills: supportedCapability(evidence),
    'skills.hostFrontmatter': Object.freeze({
      evidence,
      reason: capabilityTable.skills.hostFrontmatter.reason,
      state: 'degraded',
    }),
    'skills.markdownTokens': unavailableCapability(capabilityTable.skills.markdownTokens.reason),
  }),
  configExtension: Object.freeze({ key: openCodeName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: openCodeName,
  noticeDelivery: noticeDeliveryAdvertisementFrom(openCodeName, capabilityTable.noticeDelivery),
  plan: planOpenCodeArtifacts,
});
