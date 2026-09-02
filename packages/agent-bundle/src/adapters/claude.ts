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
  unavailableCapability,
} from './capability-state.ts';
import capabilityTable from './capabilities/claude-2.1.250.json' with { type: 'json' };
import {
  createNativeEventStarter,
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
import lspSchema from './schemas/claude/lsp.schema.json' with { type: 'json' };
import marketplaceSchema from './schemas/claude/marketplace.schema.json' with { type: 'json' };
import mcpSchema from './schemas/claude/mcp.schema.json' with { type: 'json' };
import pluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import { stringify as stringifyYaml } from 'yaml';
import {
  commandWriteEntries,
  createAdapterValidator,
  hasPathToken,
  schemaDescriptorsFrom,
  sortedEntries,
  sourceInputs,
  standardArtifactLayout,
  standardPluginArtifactPlan,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  withPluginRootEnvAnchor,
  type TargetAdapter,
  type TargetArtifactCopy,
  type TargetArtifactLayout,
  type TargetArtifactPlan,
} from './types.ts';
import { withInstallSurface } from '../install/surface.ts';
import { deepFreeze } from '../core/freeze.ts';


/**
 * One Claude Code plugin LSP server. The binary is never vendored: Claude
 * Code resolves `command` on the user's PATH, so the bundle only wires the
 * connection. Only `command`, `args`, `env`, and `workspaceFolder`
 * substitute Agent Bundle path tokens, matching the placeholder table in the
 * Claude Code 2.1.x plugin reference; every other field passes through to
 * `.lsp.json` untouched.
 */
export interface ClaudeLspServerConfig {
  readonly args?: readonly string[];
  readonly command: string;
  /** Push diagnostics into Claude's context after edits. Claude Code defaults to true. */
  readonly diagnostics?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  /** File extension to LSP language identifier, for example `{ '.go': 'go' }`. */
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly initializationOptions?: unknown;
  readonly maxRestarts?: number;
  readonly restartOnCrash?: boolean;
  readonly settings?: unknown;
  readonly shutdownTimeout?: number;
  readonly startupTimeout?: number;
  /** Claude Code accepts `socket` but runs every server over stdio. */
  readonly transport?: 'socket' | 'stdio';
  readonly workspaceFolder?: string;
}

/**
 * Claude's host config. `lspServers` lives here rather than in a portable
 * top-level block because no other pinned host contract has an LSP surface;
 * the portable LSP component kind stays deferred.
 */
export interface ClaudeHostConfig extends AgentBundleHostConfig {
  /** Project-authored directory copied to the plugin-root `bin/` executable convention. */
  readonly bin?: string;
  readonly lspServers?: Readonly<Record<string, ClaudeLspServerConfig>>;
}

export interface ClaudeConfigExtension {
  claude?: ClaudeHostConfig;
}

declare module '../core/types.ts' {
  interface AgentBundleConfigExtensions {
    claude?: ClaudeHostConfig;
  }
}

const claudeName = 'claude';

/** Claude Code's conventional artifact document paths, shared with the unified bundle adapter. */
export const claudeArtifactPaths = Object.freeze({
  hooksManifest: 'hooks/hooks.json',
  lsp: '.lsp.json',
  marketplace: '.claude-plugin/marketplace.json',
  mcp: '.mcp.json',
  plugin: '.claude-plugin/plugin.json',
});
const validator = createAdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);
const validateLsp = validator.compile(lspSchema);

/** The pinned Claude hooks validator, shared with the unified bundle adapter. */
export const claudeHooksValidator = validateHooks;
const eventRouteNames = supportedEventRouteNamesFrom(capabilityTable.hooks.eventRoutes);
const hookContract = Object.freeze({
  hostContractRevision: capabilityTable.observedCliVersion,
  commandRoot: '${CLAUDE_PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: (result, event, nativeEvent) =>
    encodeNativeHookPlaygroundOutput(result, event, nativeEvent, 'claude'),
  eventNames: capabilityTable.hooks.events,
  eventRouteNames,
  manifestPath: 'hooks/hooks.json',
  matchers: capabilityTable.hooks.matchers,
  nativeEventStarter: (event) => {
    const nativeEvent = eventRouteNames[event];
    return nativeEvent === undefined ? undefined : createNativeEventStarter('claude', event, nativeEvent);
  },
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedPlugin['hooks'][number]) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Claude'),
} satisfies TargetHookContract);
const metadata = Object.freeze({
  adapterRevision: '1.6.0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});
const evidence = capabilityEvidence(claudeName, metadata);

const artifactValidation = deepFreeze({
  documents: [
    Object.freeze({ path: 'hooks/hooks.json', required: false, schema: 'hooks' }),
    Object.freeze({ path: claudeArtifactPaths.lsp, required: false, schema: 'lsp' }),
    Object.freeze({ path: '.claude-plugin/marketplace.json', required: false, schema: 'marketplace' }),
    Object.freeze({ path: '.mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: '.claude-plugin/plugin.json', required: true, schema: 'plugin' }),
  ],
  schemas: [
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'lsp', validate: validateJsonSchemaDocument(validateLsp) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
  ],
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: '.mcp.json',
  remoteTypes: ['http'],
  validatedButNonModernRemoteTypes: ['sse'],
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

const claudeCommandMarkdown = (
  command: NonNullable<NormalizedPlugin['commands']>[number],
): string => {
  const fields = [
    ['allowed-tools', command.frontmatter.allowedTools],
    ['argument-hint', command.frontmatter.argumentHint],
    ['description', command.frontmatter.description],
    ['disable-model-invocation', command.frontmatter.disableModelInvocation],
    ['model', command.frontmatter.model],
  ].filter((entry): entry is [string, unknown] => entry[1] !== undefined);
  if (fields.length === 0) return command.body;
  return `---\n${stringifyYaml(Object.fromEntries(fields))}---\n${command.body}`;
};

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
    const declaredEnv = server.env === undefined
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
    const args = server.args?.map(expandClaudeToken);
    // Claude Code currently ignores stdio cwd at runtime (see
    // anthropics/claude-code#17565), so the absolute entry path stays as the
    // script-resolution hedge and the env anchor carries the working
    // plugin-root guarantee; cwd is still emitted below as documented,
    // schema-valid future-proofing.
    if (server.source !== undefined && server.cwd === pathTokens.pluginRoot && args?.[0] !== undefined) {
      args[0] = `${hookContract.commandRoot}/${args[0]}`;
    }
    return {
      diagnostics,
      value: {
        ...(args === undefined ? {} : { args }),
        command: expandClaudeToken(server.command),
        ...(server.cwd === undefined ? {} : { cwd: expandClaudeToken(server.cwd) }),
        env: withPluginRootEnvAnchor(declaredEnv, expandClaudeToken(pathTokens.pluginRoot)),
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

/**
 * Every field the pinned Claude LSP contract documents for one server. The
 * emitted document copies this allowlist rather than the declared record, so
 * a misspelled field is a build diagnostic instead of a silently shipped key
 * that Claude Code would reject at startup.
 */
const lspServerFields: ReadonlySet<string> = new Set([
  'args',
  'command',
  'diagnostics',
  'env',
  'extensionToLanguage',
  'initializationOptions',
  'maxRestarts',
  'restartOnCrash',
  'settings',
  'shutdownTimeout',
  'startupTimeout',
  'transport',
  'workspaceFolder',
]);

/** Normalized config extension values are already strict JSON, so a plain shape test is enough. */
const isDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const expandLspToken = (value: unknown): unknown =>
  typeof value === 'string' ? expandClaudeToken(value) : value;

const planLspServer = (
  name: string,
  declared: unknown,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const diagnostics: Diagnostic[] = [];
  if (!isDataRecord(declared)) {
    diagnostics.push(errorDiagnostic(
      'claude.lsp.server.invalid',
      `Claude LSP server "${name}" must be an LSP server configuration object.`,
    ));
    return { diagnostics };
  }
  for (const field of Object.keys(declared).sort()) {
    if (lspServerFields.has(field)) continue;
    diagnostics.push(errorDiagnostic(
      'claude.lsp.field.unknown',
      `Claude LSP server "${name}" declares unknown field "${field}".`,
    ));
  }
  const command = declared['command'];
  if (typeof command !== 'string' || command.length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.lsp.command.required',
      `Claude LSP server "${name}" requires a command. Claude Code resolves it on the user's PATH; the bundle never vendors the language-server binary.`,
    ));
  }
  const extensionToLanguage = declared['extensionToLanguage'];
  if (!isDataRecord(extensionToLanguage) || Object.keys(extensionToLanguage).length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.lsp.extensions.required',
      `Claude LSP server "${name}" requires a nonempty extensionToLanguage map; a server that claims no extension never starts.`,
    ));
  }
  const env = declared['env'];
  if (isDataRecord(env)) {
    for (const key of Object.keys(env).sort()) {
      if (!hasPathToken(key)) continue;
      diagnostics.push(errorDiagnostic(
        'claude.lsp.token.env.key',
        `Claude LSP environment key "${key}" cannot use a path token.`,
      ));
    }
  }
  if (diagnostics.length > 0) return { diagnostics };

  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of Object.keys(declared)) {
    if (!lspServerFields.has(field)) continue;
    value[field] = declared[field];
  }
  value['command'] = expandLspToken(value['command']);
  if (Array.isArray(value['args'])) value['args'] = value['args'].map(expandLspToken);
  if (isDataRecord(value['env'])) {
    value['env'] = Object.fromEntries(Object.entries(value['env']).map(([key, entry]) => [key, expandLspToken(entry)]));
  }
  if (value['workspaceFolder'] !== undefined) value['workspaceFolder'] = expandLspToken(value['workspaceFolder']);
  return { diagnostics, value };
};

interface ClaudeLspPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly sourceInputs: readonly string[];
}

const noLspPlan: ClaudeLspPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

/**
 * Lowers `claude.lspServers` into the plugin-root `.lsp.json` document
 * Claude Code discovers by convention, the same way `.mcp.json` is
 * discovered. The manifest deliberately keeps no `lspServers` pointer at
 * `./.lsp.json`: both locations register servers, and Claude Code starts
 * only the first server registered for a file extension, so pointing the
 * manifest at the conventional file risks a self-collision for no gain.
 *
 * The Claude host config is the source of truth for both the `claude`
 * target and the Claude half of the unified `plugin` bundle, because no
 * other pinned host contract has an LSP surface to select.
 */
export const planClaudeLsp = (model: NormalizedPlugin): ClaudeLspPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noLspPlan;
  const declared = extension.value['lspServers'];
  if (declared === undefined) return noLspPlan;
  const diagnostics: Diagnostic[] = [];
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isDataRecord(declared) || Object.keys(declared).length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.lsp.declaration.invalid',
      'Claude lspServers must be a nonempty record of server name to LSP server configuration.',
    ));
    return { diagnostics, sourceInputs: inputs };
  }

  const servers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  // Claude Code starts only the first server registered for an extension and
  // warns about the rest, so a bundle that claims one extension twice is an
  // authoring error rather than a shippable document.
  const claimedExtensions = new Map<string, string>();
  let conflicted = false;
  for (const name of Object.keys(declared).sort()) {
    const serverPlan = planLspServer(name, declared[name]);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value === undefined) continue;
    servers[name] = serverPlan.value;
    const extensions = serverPlan.value['extensionToLanguage'];
    if (!isDataRecord(extensions)) continue;
    for (const fileExtension of Object.keys(extensions).sort()) {
      const owner = claimedExtensions.get(fileExtension);
      if (owner === undefined) {
        claimedExtensions.set(fileExtension, name);
        continue;
      }
      diagnostics.push(errorDiagnostic(
        'claude.lsp.extension.conflict',
        `Claude LSP servers "${owner}" and "${name}" both claim extension "${fileExtension}"; Claude Code starts only the first server registered for an extension.`,
      ));
      conflicted = true;
    }
  }
  if (conflicted) return { diagnostics, sourceInputs: inputs };
  if (Object.keys(servers).length === 0) return { diagnostics, sourceInputs: inputs };
  const valid = validateLsp(servers);
  diagnostics.push(...schemaDiagnostics('lsp', valid, validateLsp.errors));
  return { diagnostics, ...(valid ? { document: servers } : {}), sourceInputs: inputs };
};

interface ClaudeBinPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactCopy[];
}

const planClaudeBin = (model: NormalizedPlugin, targetName: string): ClaudeBinPlan => {
  const diagnostics: Diagnostic[] = [];
  const entries: TargetArtifactCopy[] = [];
  for (const bin of model.hostBins ?? []) {
    if (bin.target !== targetName) continue;
    if (bin.issue !== undefined) {
      switch (bin.issue) {
        case 'missing':
          diagnostics.push({
            ...errorDiagnostic(
              'claude.bin.directory.missing',
              `Claude bin directory ${JSON.stringify(bin.source)} does not exist.`,
            ),
            recovery: 'Create the configured Claude bin directory and add at least one executable, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        case 'empty':
          diagnostics.push({
            ...errorDiagnostic(
              'claude.bin.directory.empty',
              `Claude bin directory ${JSON.stringify(bin.source)} contains no files.`,
            ),
            recovery: 'Add at least one file to the configured Claude bin directory, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        case 'not-directory':
          diagnostics.push({
            ...errorDiagnostic(
              'claude.bin.directory.invalid',
              `Claude bin source ${JSON.stringify(bin.source)} must name a directory.`,
            ),
            recovery: 'Set claude.bin to a nonempty directory path relative to the config file, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        case 'outside':
          diagnostics.push({
            ...errorDiagnostic(
              'claude.bin.directory.outside',
              `Claude bin directory ${JSON.stringify(bin.source)} must resolve inside the project root.`,
            ),
            recovery: 'Move the executable directory inside the project and update claude.bin, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        case 'source-error':
          diagnostics.push({
            ...errorDiagnostic('claude.bin.source.error', 'Claude bin source resolution failed.'),
            recovery: 'Correct the claude.bin declaration so the adapter can read it, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        case 'source-invalid':
          diagnostics.push({
            ...errorDiagnostic('claude.bin.source.invalid', 'Claude bin must be a nonempty directory path.'),
            recovery: 'Set claude.bin to a nonempty directory path relative to the config file, then rebuild.',
            sourcePath: bin.provenance.sourcePath,
          });
          break;
        default: {
          const exhaustive: never = bin.issue;
          return exhaustive;
        }
      }
      continue;
    }
    const nonExecutable = bin.files.filter((file) =>
      !file.executable && !file.relativePath.includes('/'));
    if (nonExecutable.length > 0) {
      diagnostics.push({
        ...errorDiagnostic(
          'claude.bin.executable.required',
          `Claude bin top-level file${nonExecutable.length === 1 ? '' : 's'} ${nonExecutable
            .map((file) => JSON.stringify(file.relativePath))
            .join(', ')} must be executable.`,
        ),
        recovery: 'Run chmod +x on every top-level file in the configured Claude bin directory, then rebuild.',
        sourcePath: bin.provenance.sourcePath,
      });
      continue;
    }
    entries.push(...bin.files.map((file): TargetArtifactCopy => ({
      bytes: file.bytes,
      kind: 'copy',
      prebuilt: true,
      relativePath: `bin/${file.relativePath}`,
      source: file.source,
      sourceInputs: sourceInputs(bin.provenance.sourcePath, file.source),
    })));
  }
  return deepFreeze({ diagnostics, entries });
};

export interface ClaudeArtifactPlanOptions {
  /** Target name used for selection and provenance; native hooks stay keyed to Claude. */
  readonly targetName?: string;
}

export const planClaudeArtifacts = (
  model: NormalizedPlugin,
  options: ClaudeArtifactPlanOptions = {},
): TargetArtifactPlan => {
  const targetName = options.targetName ?? claudeName;
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
  const lsp = planClaudeLsp(model);
  diagnostics.push(...lsp.diagnostics);
  const bin = planClaudeBin(model, targetName);
  diagnostics.push(...bin.diagnostics);
  const generatedHooks = planHooks(model, targetName, hookContract);
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

  const marketplace = {
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
  const marketplaceValid = validateMarketplace(marketplace);
  diagnostics.push(...schemaDiagnostics('marketplace', marketplaceValid, validateMarketplace.errors));

  const basePlan = standardPluginArtifactPlan({
    diagnostics,
    ...(lsp.document === undefined ? {} : {
      hostDocuments: [{
        document: lsp.document,
        relativePath: claudeArtifactPaths.lsp,
        sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...lsp.sourceInputs),
      }],
    }),
    hookDocument,
    hookDocumentValid,
    hookEntries: generatedHooks.hookEntries,
    hookManifestPath: hookContract.manifestPath,
    isSelected,
    marketplace,
    marketplaceRelativePath: claudeArtifactPaths.marketplace,
    marketplaceValid,
    mcp,
    mcpValid,
    model,
    plugin,
    pluginRelativePath: claudeArtifactPaths.plugin,
    targetName,
  });
  return withInstallSurface(Object.freeze({
    ...basePlan,
    entries: sortedEntries([
      ...basePlan.entries,
      ...bin.entries,
      ...commandWriteEntries(model, isSelected, claudeCommandMarkdown),
    ]),
  }), model, targetName === 'plugin' ? 'plugin' : 'claude');
};

const artifactLayout: TargetArtifactLayout = Object.freeze({
  ...standardArtifactLayout,
  bin: 'bin',
  commands: Object.freeze({
    allowedSuffixes: Object.freeze(['.md']),
    directory: 'commands',
  }),
});

export const claudeAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: Object.freeze({
    ...eventRouteCapabilitiesFrom(capabilityTable.hooks.eventRoutes, evidence),
    bin: capabilityStateFromSupport(
      capabilityTable.plugin.bin.directory === 'bin' &&
        capabilityTable.plugin.bin.bashPath &&
        capabilityTable.plugin.bin.bareCommands &&
        capabilityTable.plugin.bin.enabledOnly &&
        capabilityTable.plugin.bin.organizationDistributionProhibited,
      evidence,
      'The pinned Claude plugin contract does not document the plugin-root bin executable surface.',
    ),
    commands: capabilityStateFromSupport(
      capabilityTable.plugin.commands,
      evidence,
      'The pinned Claude Code plugin contract does not support commands.',
    ),
    install: supportedCapability(evidence),
    marketplace: supportedCapability(evidence),
    hooks: supportedCapability(evidence),
    lsp: capabilityStateFromSupport(
      capabilityTable.plugin.lsp.config === claudeArtifactPaths.lsp &&
        capabilityTable.plugin.lsp.manifestField === 'lspServers',
      evidence,
      'The pinned Claude plugin contract does not document the plugin-root .lsp.json LSP surface.',
    ),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'The pinned Claude contract does not support both required modern MCP transports.',
    ),
    rules: unavailableCapability(
      'The pinned Claude Code plugin contract (2.1.250) defines no rules component; project guidance ships through CLAUDE.md memory, not a rules directory.',
    ),
    skills: capabilityStateFromSupport(
      capabilityTable.plugin.skills,
      evidence,
      'The pinned Claude plugin contract does not support skills.',
    ),
  }),
  configExtension: Object.freeze({ key: claudeName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: claudeName,
  binSource: (config: Readonly<AgentBundleConfig>) => config.claude?.bin,
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.claude?.nativeHooks,
  plan: planClaudeArtifacts,
});
