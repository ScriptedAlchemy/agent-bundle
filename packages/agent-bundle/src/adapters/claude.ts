import { createTargetDiagnostics } from './diagnostics.ts';
import { hasErrors, type Diagnostic } from '../core/diagnostics.ts';
import { readMcpTransport, unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleHostConfig,
  type NormalizedMcpServer,
  type NormalizedHostPayloadDirectory,
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
import monitorsSchema from './schemas/claude/monitors.schema.json' with { type: 'json' };
import pluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import settingsSchema from './schemas/claude/settings.schema.json' with { type: 'json' };
import themeSchema from './schemas/claude/theme.schema.json' with { type: 'json' };
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
  type StandardPluginHostDocument,
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

export type ClaudeUserConfigOptionType = 'boolean' | 'directory' | 'file' | 'number' | 'string';

/**
 * One enable-time option declared in a Claude Code plugin manifest.
 *
 * Sensitive values are masked and stored in secure storage rather than
 * settings.json. On macOS that means Keychain with credentials-file fallback;
 * the Keychain is shared with OAuth tokens and has an approximately 2 KB total
 * budget, so sensitive values must stay small.
 *
 * Do not place `${user_config.*}` in shell-form hook commands, monitor
 * commands, or MCP `headersHelper`: Claude Code rejects those shell execution
 * fields. Use exec-form hook args, `CLAUDE_PLUGIN_OPTION_<KEY>`, or a config
 * file as appropriate.
 */
export interface ClaudeUserConfigOption {
  readonly default?: string | number | boolean | readonly string[];
  readonly description: string;
  readonly max?: number;
  readonly min?: number;
  readonly multiple?: boolean;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly title: string;
  readonly type: ClaudeUserConfigOptionType;
}

/** One Claude Code message channel bound to an MCP server supplied by this plugin. */
export interface ClaudeChannelConfig {
  readonly server: string;
  readonly userConfig?: Readonly<Record<string, ClaudeUserConfigOption>>;
}

/**
 * One Claude Code subagent status line: the command object documented for
 * `subagentStatusLine`, which renders a custom row body for each subagent in
 * the agent panel. Only `type` and `command` are admitted; `statusLine`'s
 * optional `padding` is documented for the user status line, not for the
 * plugin default, so it is not part of this pinned shape.
 */
export interface ClaudeSubagentStatusLineConfig {
  /** A path to an executable or an inline command; Claude Code runs it once per refresh tick. */
  readonly command: string;
  readonly type: 'command';
}

/**
 * Default configuration Claude Code applies when the plugin is enabled,
 * emitted as `settings.json` at the plugin root. The pinned 2.1.250 contract
 * supports exactly two keys, and `settings.json` takes priority over
 * `settings` declared in the manifest.
 *
 * `agent` activates one of the plugin's own agents as the main thread. The
 * plugin `agents/` component is deferred by the #100 stage-2 G5 gate (merged
 * PR #220), so this compiler emits no `agents/` tree: a declared `agent`
 * resolves only when the author ships that agent by other means, such as a
 * prebuilt payload. Declaring it raises the `claude.settings.agent.deferred`
 * warning rather than silently emitting a dangling reference.
 *
 * Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` and its siblings only in
 * the components its placeholder table names (Skill and agent content, hook
 * and monitor commands, MCP servers, LSP servers). `settings.json` is absent
 * from that table, so Agent Bundle path tokens are rejected here instead of
 * being emitted as placeholders the host never resolves.
 */
export interface ClaudeSettingsConfig {
  /** Name of a plugin agent to activate as the main thread. */
  readonly agent?: string;
  readonly subagentStatusLine?: ClaudeSubagentStatusLineConfig;
}

/** One experimental Claude Code color theme emitted under the plugin-root `themes/` directory. */
export interface ClaudeThemeConfig {
  /** Built-in preset inherited before sparse token overrides are applied. */
  readonly base: string;
  /** Display name shown in `/theme`; defaults to the declaration key. */
  readonly name?: string;
  /** Sparse color-token overrides. Values stay host-defined strings rather than being narrowed to hex colors. */
  readonly overrides?: Readonly<Record<string, string>>;
}

/** One experimental Claude Code background monitor emitted in `monitors/monitors.json`. */
export interface ClaudeMonitorConfig {
  readonly command: string;
  readonly description: string;
  /** Identifier unique within this plugin. */
  readonly name: string;
  readonly when?: string;
}

/**
 * One Claude Code plugin dependency. Without `marketplace`, Claude resolves
 * the name in the declaring plugin's marketplace. Cross-marketplace
 * dependencies require the target marketplace in the root marketplace's
 * `allowCrossMarketplaceDependenciesOn`; only the root allowlist is consulted,
 * so trust does not chain.
 *
 * Version ranges resolve against git tags named `{name}--v{version}`. Git
 * sources fetch the highest satisfying tag; npm, archive, and command sources
 * are only checked after loading. Command-source dependencies and dependencies
 * that require `headersHelper` are never auto-installed. Pre-releases are
 * excluded unless the range opts in with a suffix such as `^2.0.0-0`.
 */
export interface ClaudeDependencyConfig {
  readonly marketplace?: string;
  readonly name: string;
  readonly version?: string;
}

/**
 * Claude's host config. `lspServers` lives here rather than in a portable
 * top-level block because no other pinned host contract has an LSP surface;
 * the portable LSP component kind stays deferred. `settings` is host-scoped
 * for the same reason: no other pinned contract ships plugin defaults.
 */
export interface ClaudeHostConfig extends AgentBundleHostConfig {
  /** Project-authored directory copied to the plugin-root `bin/` executable convention. */
  readonly bin?: string;
  /** Message channels whose server names must resolve in this plugin's emitted `.mcp.json`. */
  readonly channels?: readonly ClaudeChannelConfig[];
  /** Whether a newly installed plugin starts enabled when no stronger host state exists. */
  readonly defaultEnabled?: boolean;
  /**
   * Plugins Claude Code resolves and auto-installs. A bare name uses the
   * declaring plugin's marketplace; the object form adds a semver range or an
   * explicitly allowlisted cross-marketplace source.
   */
  readonly dependencies?: readonly (string | ClaudeDependencyConfig)[];
  /** Human-readable plugin name shown in Claude Code UI surfaces. */
  readonly displayName?: string;
  readonly lspServers?: Readonly<Record<string, ClaudeLspServerConfig>>;
  /** Free-form catalog or entitlement data that Claude Code preserves but does not interpret. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Experimental session-lifetime background monitors discovered from `monitors/monitors.json`. */
  readonly monitors?: readonly ClaudeMonitorConfig[];
  /** Project-authored Markdown files copied to the plugin-root `output-styles/` convention. */
  readonly outputStyles?: string;
  readonly settings?: ClaudeSettingsConfig;
  /** Experimental color themes emitted one file per declaration key under `themes/`. */
  readonly themes?: Readonly<Record<string, ClaudeThemeConfig>>;
  /** Enable-time options copied into `.claude-plugin/plugin.json`. */
  readonly userConfig?: Readonly<Record<string, ClaudeUserConfigOption>>;
  /** Project-authored script files copied to the plugin-root `workflows/` convention. */
  readonly workflows?: string;
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
  monitors: 'monitors/monitors.json',
  plugin: '.claude-plugin/plugin.json',
  settings: 'settings.json',
  themes: 'themes/*.json',
});
const validator = createAdapterValidator();
const validatePlugin = validator.compile(pluginSchema);
const validateMcp = validator.compile(mcpSchema);
const validateMarketplace = validator.compile(marketplaceSchema);
const validateHooks = validator.compile(hooksSchema);
const validateLsp = validator.compile(lspSchema);
const validateMonitors = validator.compile(monitorsSchema);
const validateSettings = validator.compile(settingsSchema);
const validateTheme = validator.compile(themeSchema);

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
  adapterRevision: '1.14.0',
  observedVersion: capabilityTable.observedCliVersion,
  schemas: schemaDescriptorsFrom(schemaProvenance, schemaProvenance.observedCliVersion),
});
const evidence = capabilityEvidence(claudeName, metadata);
const distributionPolicy = capabilityTable.plugin.distributionPolicy;

const artifactValidation = deepFreeze({
  documents: [
    Object.freeze({ path: 'hooks/hooks.json', required: false, schema: 'hooks' }),
    Object.freeze({ path: claudeArtifactPaths.lsp, required: false, schema: 'lsp' }),
    Object.freeze({ path: '.claude-plugin/marketplace.json', required: false, schema: 'marketplace' }),
    Object.freeze({ path: '.mcp.json', required: false, schema: 'mcp' }),
    Object.freeze({ path: claudeArtifactPaths.monitors, required: false, schema: 'monitors' }),
    Object.freeze({ path: '.claude-plugin/plugin.json', required: true, schema: 'plugin' }),
    Object.freeze({ path: claudeArtifactPaths.settings, required: false, schema: 'settings' }),
    Object.freeze({ path: claudeArtifactPaths.themes, required: false, schema: 'theme' }),
  ],
  schemas: [
    Object.freeze({ name: 'hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'lsp', validate: validateJsonSchemaDocument(validateLsp) }),
    Object.freeze({ name: 'marketplace', validate: validateJsonSchemaDocument(validateMarketplace) }),
    Object.freeze({ name: 'mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateMcp)) }),
    Object.freeze({ name: 'monitors', validate: validateJsonSchemaDocument(validateMonitors) }),
    Object.freeze({ name: 'plugin', validate: validateJsonSchemaDocument(validatePlugin) }),
    Object.freeze({ name: 'settings', validate: validateJsonSchemaDocument(validateSettings) }),
    Object.freeze({ name: 'theme', validate: validateJsonSchemaDocument(validateTheme) }),
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

const { errorDiagnostic, schemaDiagnostics, warningDiagnostic } = createTargetDiagnostics(claudeName, 'Claude');

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

const isPlainDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isDataRecord(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const dependencyFields: ReadonlySet<string> = new Set(['marketplace', 'name', 'version']);
const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const numericSemverIdentifier = '(?:0|[1-9][0-9]*)';
const prereleaseSemverIdentifier = '(?:0|[1-9][0-9]*|[A-Za-z-][0-9A-Za-z-]*)';
const semverSuffix = `(?:-${prereleaseSemverIdentifier}(?:\\.${prereleaseSemverIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
const fullSemverVersion = `${numericSemverIdentifier}\\.${numericSemverIdentifier}\\.${numericSemverIdentifier}${semverSuffix}`;
const partialSemverVersion = `${numericSemverIdentifier}(?:\\.${numericSemverIdentifier})?`;
const wildcardSemverVersion = `${numericSemverIdentifier}\\.(?:[xX*]|${numericSemverIdentifier}\\.[xX*])`;
const semverRangeVersion = `(?:${fullSemverVersion}|${wildcardSemverVersion}|${partialSemverVersion})`;
const hyphenRangePattern = new RegExp(`^${semverRangeVersion}\\s+-\\s+${semverRangeVersion}$`, 'u');
const comparatorPattern = new RegExp(`(?:~|\\^|>=|<=|>|<|=)?\\s*${semverRangeVersion}`, 'uy');

/**
 * Validates npm-style dependency range syntax without resolving versions.
 * Accepted clauses are bare/partial versions, x-wildcards, `~`, `^`, `>=`,
 * `<=`, `>`, `<`, and `=` comparators, space-separated intersections, hyphen
 * ranges, `||` unions, and semver pre-release/build suffixes.
 */
export const isValidClaudeDependencyRange = (value: string): boolean => {
  if (value.length === 0 || value.trim() !== value) return false;
  for (const clause of value.split('||')) {
    const range = clause.trim();
    if (range.length === 0) return false;
    if (hyphenRangePattern.test(range)) continue;
    let offset = 0;
    let comparators = 0;
    while (offset < range.length) {
      comparatorPattern.lastIndex = offset;
      const match = comparatorPattern.exec(range);
      if (match === null || match.index !== offset) return false;
      comparators += 1;
      offset = comparatorPattern.lastIndex;
      if (offset === range.length) break;
      const whitespace = /^\s+/u.exec(range.slice(offset));
      if (whitespace === null) return false;
      offset += whitespace[0].length;
    }
    if (comparators === 0) return false;
  }
  return true;
};

interface ClaudeDependenciesPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: readonly (string | Readonly<Record<string, string>>)[];
  readonly sourceInputs: readonly string[];
}

const noDependenciesPlan: ClaudeDependenciesPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

const dependencyDiagnostic = (code: string, message: string, recovery: string): Diagnostic => ({
  ...errorDiagnostic(code, message),
  recovery,
});

const planClaudeDependencies = (model: NormalizedPlugin): ClaudeDependenciesPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noDependenciesPlan;
  const declared = extension.value['dependencies'];
  if (declared === undefined) return noDependenciesPlan;
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!Array.isArray(declared) || declared.length === 0) {
    return {
      diagnostics: [dependencyDiagnostic(
        'claude.dependencies.declaration.invalid',
        'Claude dependencies must be a nonempty array of plugin names or dependency objects.',
        'Declare at least one dependency as a nonempty plugin name or { name, version?, marketplace? } object, then rebuild.',
      )],
      sourceInputs: inputs,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const document: (string | Readonly<Record<string, string>>)[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of declared.entries()) {
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        diagnostics.push(dependencyDiagnostic(
          'claude.dependencies.entry.invalid',
          `Claude dependency at index ${index} must be a nonempty plugin name or dependency object.`,
          'Replace the entry with a nonempty plugin name or { name, version?, marketplace? } object, then rebuild.',
        ));
        continue;
      }
      if (!pluginNamePattern.test(entry)) {
        diagnostics.push(dependencyDiagnostic(
          'claude.dependencies.name.invalid',
          `Claude dependency name ${JSON.stringify(entry)} must match the plugin-name pattern ${pluginNamePattern.source}.`,
          'Use a lowercase kebab-case Claude plugin name, then rebuild.',
        ));
        continue;
      }
      if (entry === model.metadata.name) {
        diagnostics.push(dependencyDiagnostic(
          'claude.dependencies.self',
          `Claude plugin ${JSON.stringify(model.metadata.name)} cannot depend on itself.`,
          'Remove the self-dependency; self-dependencies can deadlock plugin enable and disable operations.',
        ));
        continue;
      }
      const identity = `\u0000${entry}`;
      if (seen.has(identity)) {
        diagnostics.push(dependencyDiagnostic(
          'claude.dependencies.duplicate',
          `Claude dependency ${JSON.stringify(entry)} is declared more than once in the same marketplace.`,
          'Keep one declaration for each dependency name and marketplace pair, then rebuild.',
        ));
        continue;
      }
      seen.add(identity);
      document.push(entry);
      continue;
    }

    if (!isDataRecord(entry)) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.entry.invalid',
        `Claude dependency at index ${index} must be a nonempty plugin name or dependency object.`,
        'Replace the entry with a nonempty plugin name or { name, version?, marketplace? } object, then rebuild.',
      ));
      continue;
    }
    for (const field of Object.keys(entry).sort()) {
      if (dependencyFields.has(field)) continue;
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.field.unknown',
        `Claude dependency ${index} declares unknown field ${JSON.stringify(field)}.`,
        'Remove the unknown field; dependency objects support only name, version, and marketplace.',
      ));
    }
    const name = entry['name'];
    if (typeof name !== 'string' || name.length === 0) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.name.required',
        `Claude dependency object at index ${index} requires a nonempty name.`,
        'Set name to a nonempty lowercase kebab-case Claude plugin name, then rebuild.',
      ));
      continue;
    }
    if (!pluginNamePattern.test(name)) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.name.invalid',
        `Claude dependency name ${JSON.stringify(name)} must match the plugin-name pattern ${pluginNamePattern.source}.`,
        'Use a lowercase kebab-case Claude plugin name, then rebuild.',
      ));
      continue;
    }
    const marketplace = entry['marketplace'];
    if (marketplace !== undefined && (typeof marketplace !== 'string' || marketplace.length === 0)) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.marketplace.invalid',
        `Claude dependency ${JSON.stringify(name)} marketplace must be a nonempty string when declared.`,
        'Set marketplace to a nonempty marketplace name or omit it for same-marketplace resolution, then rebuild.',
      ));
      continue;
    }
    const version = entry['version'];
    if (version !== undefined && (typeof version !== 'string' || !isValidClaudeDependencyRange(version))) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.version.invalid',
        `Claude dependency ${JSON.stringify(name)} version must be a valid npm-style semver range using forms such as ~2.1.0, ^2.0, >=1.4, =2.1.0, || unions, or an explicit pre-release opt-in such as ^2.0.0-0.`,
        'Replace version with a documented semver range; invalid ranges become range-conflict errors only after distribution.',
      ));
      continue;
    }
    if (name === model.metadata.name) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.self',
        `Claude plugin ${JSON.stringify(model.metadata.name)} cannot depend on itself.`,
        'Remove the self-dependency; self-dependencies can deadlock plugin enable and disable operations.',
      ));
      continue;
    }
    const identity = `${typeof marketplace === 'string' ? marketplace : ''}\u0000${name}`;
    if (seen.has(identity)) {
      diagnostics.push(dependencyDiagnostic(
        'claude.dependencies.duplicate',
        `Claude dependency ${JSON.stringify(name)} is declared more than once for marketplace ${JSON.stringify(marketplace ?? 'same marketplace')}.`,
        'Keep one declaration for each dependency name and marketplace pair, then rebuild.',
      ));
      continue;
    }
    seen.add(identity);
    document.push(Object.freeze({
      ...(typeof marketplace === 'string' ? { marketplace } : {}),
      name,
      ...(typeof version === 'string' ? { version } : {}),
    }));
  }

  if (hasErrors(diagnostics)) return { diagnostics, sourceInputs: inputs };
  return { diagnostics, document: Object.freeze(document), sourceInputs: inputs };
};

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

const userConfigOptionFields: readonly (keyof ClaudeUserConfigOption)[] = Object.freeze([
  'default',
  'description',
  'max',
  'min',
  'multiple',
  'required',
  'sensitive',
  'title',
  'type',
]);
const userConfigOptionFieldSet: ReadonlySet<string> = new Set(userConfigOptionFields);
const userConfigOptionTypes: ReadonlySet<string> = new Set([
  'boolean',
  'directory',
  'file',
  'number',
  'string',
]);
const userConfigIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const isUserConfigOptionType = (value: unknown): value is ClaudeUserConfigOptionType =>
  typeof value === 'string' && userConfigOptionTypes.has(value);

const userConfigDiagnostic = (code: string, message: string, recovery: string): Diagnostic => ({
  ...errorDiagnostic(code, message),
  recovery,
});

interface ClaudeUserConfigOptionPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly value?: Record<string, unknown>;
}

/**
 * Validates and allowlist-copies one option independently so the same closed
 * declaration contract can be reused by a later channels.userConfig slice.
 */
const planClaudeUserConfigOption = (key: string, declared: unknown): ClaudeUserConfigOptionPlan => {
  const diagnostics: Diagnostic[] = [];
  if (!isPlainDataRecord(declared)) {
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.option.invalid',
      `Claude userConfig option "${key}" must be an option declaration object.`,
      `Replace userConfig.${key} with an object containing type, title, and description, then rebuild.`,
    ));
    return { diagnostics };
  }

  for (const field of Object.keys(declared).sort()) {
    if (userConfigOptionFieldSet.has(field)) continue;
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.field.unknown',
      `Claude userConfig option "${key}" declares unknown field "${field}".`,
      `Remove userConfig.${key}.${field} or replace it with a documented option field, then rebuild.`,
    ));
  }

  const type = declared['type'];
  if (!isUserConfigOptionType(type)) {
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.type.invalid',
      `Claude userConfig option "${key}" requires type "string", "number", "boolean", "directory", or "file".`,
      `Set userConfig.${key}.type to one of the five documented option types, then rebuild.`,
    ));
  }
  for (const field of ['title', 'description'] as const) {
    if (typeof declared[field] === 'string' && declared[field].length > 0) continue;
    diagnostics.push(userConfigDiagnostic(
      `claude.userConfig.${field}.required`,
      `Claude userConfig option "${key}" requires a nonempty ${field}.`,
      `Set userConfig.${key}.${field} to the text Claude Code should show in its configuration dialog, then rebuild.`,
    ));
  }
  for (const field of ['sensitive', 'required'] as const) {
    if (declared[field] === undefined || typeof declared[field] === 'boolean') continue;
    diagnostics.push(userConfigDiagnostic(
      `claude.userConfig.${field}.invalid`,
      `Claude userConfig option "${key}" field "${field}" must be a boolean when provided.`,
      `Set userConfig.${key}.${field} to true or false, or remove it, then rebuild.`,
    ));
  }

  const multiple = declared['multiple'];
  if (
    multiple !== undefined &&
    (typeof multiple !== 'boolean' || (isUserConfigOptionType(type) && type !== 'string'))
  ) {
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.multiple.invalid',
      `Claude userConfig option "${key}" may declare boolean field "multiple" only for type "string".`,
      `Remove userConfig.${key}.multiple or change the option type to "string", then rebuild.`,
    ));
  }

  const bounds: Partial<Record<'min' | 'max', number>> = {};
  for (const field of ['min', 'max'] as const) {
    const bound = declared[field];
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isFinite(bound) || (isUserConfigOptionType(type) && type !== 'number')) {
      diagnostics.push(userConfigDiagnostic(
        `claude.userConfig.${field}.invalid`,
        `Claude userConfig option "${key}" may declare finite numeric field "${field}" only for type "number".`,
        `Remove userConfig.${key}.${field} or use it with a number option and a finite numeric value, then rebuild.`,
      ));
      continue;
    }
    bounds[field] = bound;
  }
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) {
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.bounds.invalid',
      `Claude userConfig option "${key}" has min ${String(bounds.min)} greater than max ${String(bounds.max)}.`,
      `Set userConfig.${key}.min less than or equal to userConfig.${key}.max, then rebuild.`,
    ));
  }

  const defaultValue = declared['default'];
  if (defaultValue !== undefined && isUserConfigOptionType(type)) {
    let validDefault: boolean;
    switch (type) {
      case 'string':
        validDefault = multiple === true
          ? Array.isArray(defaultValue) && defaultValue.every((entry) => typeof entry === 'string')
          : typeof defaultValue === 'string';
        break;
      case 'number':
        validDefault =
          typeof defaultValue === 'number' &&
          Number.isFinite(defaultValue) &&
          (bounds.min === undefined || defaultValue >= bounds.min) &&
          (bounds.max === undefined || defaultValue <= bounds.max);
        break;
      case 'boolean':
        validDefault = typeof defaultValue === 'boolean';
        break;
      case 'directory':
      case 'file':
        validDefault = typeof defaultValue === 'string';
        break;
      default: {
        const exhaustive: never = type;
        return exhaustive;
      }
    }
    if (!validDefault) {
      diagnostics.push(userConfigDiagnostic(
        'claude.userConfig.default.invalid',
        `Claude userConfig option "${key}" has a default that does not match its type, multiple mode, or numeric bounds.`,
        `Set userConfig.${key}.default to a valid ${type} value for this declaration, or remove it, then rebuild.`,
      ));
    }
  }
  if (declared['sensitive'] === true && defaultValue !== undefined) {
    diagnostics.push(userConfigDiagnostic(
      'claude.userConfig.sensitive.default',
      `Claude userConfig option "${key}" cannot combine sensitive: true with a manifest default because that would ship a secure-storage value in the plugin manifest.`,
      `Remove userConfig.${key}.default and let Claude Code prompt for the sensitive value, then rebuild.`,
    ));
  }

  if (diagnostics.length > 0) return { diagnostics };
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of userConfigOptionFields) {
    if (declared[field] !== undefined) value[field] = declared[field];
  }
  return { diagnostics, value };
};

interface ClaudeUserConfigPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, Record<string, unknown>>;
  readonly sourceInputs: readonly string[];
}

const noUserConfigPlan: ClaudeUserConfigPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

const planClaudeUserConfig = (model: NormalizedPlugin): ClaudeUserConfigPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noUserConfigPlan;
  const declared = extension.value['userConfig'];
  if (declared === undefined) return noUserConfigPlan;
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isPlainDataRecord(declared) || Object.keys(declared).length === 0) {
    return {
      diagnostics: [userConfigDiagnostic(
        'claude.userConfig.declaration.invalid',
        'Claude userConfig must be a nonempty plain record of option key to option declaration.',
        'Set claude.userConfig to a nonempty object whose values declare type, title, and description, then rebuild.',
      )],
      sourceInputs: inputs,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const options: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  const environmentOwners = new Map<string, string>();
  for (const key of Object.keys(declared).sort()) {
    if (!userConfigIdentifier.test(key)) {
      diagnostics.push(userConfigDiagnostic(
        'claude.userConfig.key.invalid',
        `Claude userConfig option key "${key}" must match ^[A-Za-z_][A-Za-z0-9_]*$.`,
        `Rename userConfig option "${key}" to a valid identifier containing only letters, digits, and underscores and not starting with a digit, then rebuild.`,
      ));
    }
    const environmentKey = key.toUpperCase();
    const owner = environmentOwners.get(environmentKey);
    if (owner === undefined) {
      environmentOwners.set(environmentKey, key);
    } else {
      diagnostics.push(userConfigDiagnostic(
        'claude.userConfig.key.collision',
        `Claude userConfig option keys "${owner}" and "${key}" both export as CLAUDE_PLUGIN_OPTION_${environmentKey}.`,
        `Rename one option so every key remains unique after uppercasing, then rebuild.`,
      ));
    }
    const optionPlan = planClaudeUserConfigOption(key, declared[key]);
    diagnostics.push(...optionPlan.diagnostics);
    if (optionPlan.value !== undefined) options[key] = optionPlan.value;
  }
  return {
    diagnostics,
    ...(diagnostics.length === 0 ? { document: options } : {}),
    sourceInputs: inputs,
  };
};

interface ClaudeManifestMetadataPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Readonly<Record<string, unknown>>;
  readonly sourceInputs: readonly string[];
}

const noManifestMetadataPlan: ClaudeManifestMetadataPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

interface ClaudeChannelsPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: readonly Record<string, unknown>[];
  readonly sourceInputs: readonly string[];
}

const noChannelsPlan: ClaudeChannelsPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

const manifestMetadataDiagnostic = (
  code: string,
  message: string,
  recovery: string,
): Diagnostic => ({
  ...errorDiagnostic(code, message),
  recovery,
});

/**
 * Validates Claude-only manifest metadata fields from the normalized
 * extension envelope. Normalization already guarantees strict finite JSON;
 * this boundary additionally requires metadata's top level to be a plain
 * object because Claude Code only warns and ignores arrays or null.
 */
const planClaudeManifestMetadata = (model: NormalizedPlugin): ClaudeManifestMetadataPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noManifestMetadataPlan;
  const displayName = extension.value['displayName'];
  const metadataValue = extension.value['metadata'];
  const defaultEnabled = extension.value['defaultEnabled'];
  if (displayName === undefined && metadataValue === undefined && defaultEnabled === undefined) {
    return noManifestMetadataPlan;
  }

  const diagnostics: Diagnostic[] = [];
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length === 0)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'claude.manifest.displayName.invalid',
      'Claude displayName must be a nonempty string after trimming whitespace.',
      'Set claude.displayName to the human-readable plugin name shown in Claude Code, or remove it to fall back to plugin.name.',
    ));
  }
  if (metadataValue !== undefined && !isPlainDataRecord(metadataValue)) {
    diagnostics.push(manifestMetadataDiagnostic(
      'claude.manifest.metadata.invalid',
      'Claude metadata must be a plain JSON object; arrays and null are not accepted.',
      'Set claude.metadata to a plain JSON-serializable object, or remove it.',
    ));
  }
  if (defaultEnabled !== undefined && typeof defaultEnabled !== 'boolean') {
    diagnostics.push(manifestMetadataDiagnostic(
      'claude.manifest.defaultEnabled.invalid',
      'Claude defaultEnabled must be a boolean.',
      'Set claude.defaultEnabled to true or false, or remove it to use Claude Code\'s default of true.',
    ));
  }
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (diagnostics.length > 0) return { diagnostics, sourceInputs: inputs };
  return {
    diagnostics,
    document: Object.freeze({
      ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(metadataValue === undefined ? {} : { metadata: metadataValue }),
    }),
    sourceInputs: inputs,
  };
};

const channelFields: ReadonlySet<string> = new Set(['server', 'userConfig']);

/**
 * Lowers `claude.channels` into plugin manifest declarations after binding
 * each channel to a server that survived this target's MCP planning. Duplicate
 * declarations are retained in authored order because the host contract does
 * not require one channel per server.
 */
export const planClaudeChannels = (
  model: NormalizedPlugin,
  pluginMcpServerNames: ReadonlySet<string>,
): ClaudeChannelsPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noChannelsPlan;
  const declared = extension.value['channels'];
  if (declared === undefined) return noChannelsPlan;
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!Array.isArray(declared) || declared.length === 0) {
    return {
      diagnostics: [userConfigDiagnostic(
        'claude.channels.declaration.invalid',
        'Claude channels must be a nonempty array of channel declarations.',
        'Declare at least one channel as { server, userConfig? }, then rebuild.',
      )],
      sourceInputs: inputs,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const document: Record<string, unknown>[] = [];
  for (const [index, channel] of declared.entries()) {
    if (!isPlainDataRecord(channel)) {
      diagnostics.push(userConfigDiagnostic(
        'claude.channels.entry.invalid',
        `Claude channel at index ${index} must be a channel declaration object.`,
        `Replace channels[${index}] with an object containing server and optional userConfig, then rebuild.`,
      ));
      continue;
    }
    for (const field of Object.keys(channel).sort()) {
      if (channelFields.has(field)) continue;
      diagnostics.push(userConfigDiagnostic(
        'claude.channels.field.unknown',
        `Claude channel at index ${index} declares unknown field ${JSON.stringify(field)}.`,
        `Remove channels[${index}].${field}; channel declarations support only server and userConfig.`,
      ));
    }

    const server = channel['server'];
    if (typeof server !== 'string' || server.length === 0) {
      diagnostics.push(userConfigDiagnostic(
        'claude.channels.server.required',
        `Claude channel at index ${index} requires a nonempty server name.`,
        `Set channels[${index}].server to a key emitted in this plugin's .mcp.json, then rebuild.`,
      ));
    } else if (!pluginMcpServerNames.has(server)) {
      diagnostics.push(userConfigDiagnostic(
        'claude.channels.server.unknown',
        pluginMcpServerNames.size === 0
          ? `Claude channel at index ${index} binds to ${JSON.stringify(server)}, but this target emits no plugin MCP servers.`
          : `Claude channel at index ${index} binds to undeclared plugin MCP server ${JSON.stringify(server)}.`,
        `Set channels[${index}].server to one of the plugin MCP servers selected for this target, then rebuild.`,
      ));
    }

    const userConfig = channel['userConfig'];
    let plannedUserConfig: Record<string, Record<string, unknown>> | undefined;
    if (userConfig !== undefined) {
      if (!isPlainDataRecord(userConfig) || Object.keys(userConfig).length === 0) {
        diagnostics.push(userConfigDiagnostic(
          'claude.channels.userConfig.invalid',
          `Claude channel at index ${index} userConfig must be a nonempty plain record of option key to option declaration.`,
          `Set channels[${index}].userConfig to a nonempty option map or remove it, then rebuild.`,
        ));
      } else {
        plannedUserConfig = Object.create(null) as Record<string, Record<string, unknown>>;
        const environmentOwners = new Map<string, string>();
        for (const key of Object.keys(userConfig).sort()) {
          if (!userConfigIdentifier.test(key)) {
            diagnostics.push(userConfigDiagnostic(
              'claude.channels.key.invalid',
              `Claude channel at index ${index} userConfig option key "${key}" must match ^[A-Za-z_][A-Za-z0-9_]*$.`,
              `Rename channels[${index}].userConfig option "${key}" to a valid identifier, then rebuild.`,
            ));
          }
          const environmentKey = key.toUpperCase();
          const owner = environmentOwners.get(environmentKey);
          if (owner === undefined) {
            environmentOwners.set(environmentKey, key);
          } else {
            diagnostics.push(userConfigDiagnostic(
              'claude.channels.key.collision',
              `Claude channel at index ${index} userConfig option keys "${owner}" and "${key}" both export as CLAUDE_PLUGIN_OPTION_${environmentKey}.`,
              `Rename one channels[${index}].userConfig option so every key remains unique after uppercasing, then rebuild.`,
            ));
          }
          const optionPlan = planClaudeUserConfigOption(key, userConfig[key]);
          diagnostics.push(...optionPlan.diagnostics);
          if (optionPlan.value !== undefined) plannedUserConfig[key] = optionPlan.value;
        }
      }
    }

    if (
      typeof server === 'string' &&
      server.length > 0 &&
      pluginMcpServerNames.has(server) &&
      (userConfig === undefined || plannedUserConfig !== undefined)
    ) {
      document.push({
        server,
        ...(plannedUserConfig === undefined ? {} : { userConfig: plannedUserConfig }),
      });
    }
  }

  return {
    diagnostics,
    ...(diagnostics.length === 0 ? { document: Object.freeze(document) } : {}),
    sourceInputs: inputs,
  };
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

interface ClaudePayloadDirectoryPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactCopy[];
}

interface ClaudePayloadDirectoryOptions {
  readonly configField: 'outputStyles' | 'workflows';
  readonly destination: 'output-styles' | 'workflows';
  readonly directories: readonly NormalizedHostPayloadDirectory[] | undefined;
  readonly label: 'output styles' | 'workflows';
  readonly targetName: string;
}

const planClaudePayloadDirectory = ({
  configField,
  destination,
  directories,
  label,
  targetName,
}: ClaudePayloadDirectoryOptions): ClaudePayloadDirectoryPlan => {
  const diagnostics: Diagnostic[] = [];
  const entries: TargetArtifactCopy[] = [];
  const codePrefix = `claude.${configField}`;
  for (const directory of directories ?? []) {
    if (directory.target !== targetName) continue;
    if (directory.issue !== undefined) {
      switch (directory.issue) {
        case 'missing':
          diagnostics.push({
            ...errorDiagnostic(
              `${codePrefix}.directory.missing`,
              `Claude ${label} directory ${JSON.stringify(directory.source)} does not exist.`,
            ),
            recovery: `Create the configured Claude ${label} directory and add at least one file, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        case 'empty':
          diagnostics.push({
            ...errorDiagnostic(
              `${codePrefix}.directory.empty`,
              `Claude ${label} directory ${JSON.stringify(directory.source)} contains no files.`,
            ),
            recovery: `Add at least one file to the configured Claude ${label} directory, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        case 'not-directory':
          diagnostics.push({
            ...errorDiagnostic(
              `${codePrefix}.directory.invalid`,
              `Claude ${label} source ${JSON.stringify(directory.source)} must name a directory.`,
            ),
            recovery: `Set claude.${configField} to a nonempty directory path relative to the config file, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        case 'outside':
          diagnostics.push({
            ...errorDiagnostic(
              `${codePrefix}.directory.outside`,
              `Claude ${label} directory ${JSON.stringify(directory.source)} must resolve inside the project root.`,
            ),
            recovery: `Move the ${label} directory inside the project and update claude.${configField}, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        case 'source-error':
          diagnostics.push({
            ...errorDiagnostic(`${codePrefix}.source.error`, `Claude ${label} source resolution failed.`),
            recovery: `Correct the claude.${configField} declaration so the adapter can read it, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        case 'source-invalid':
          diagnostics.push({
            ...errorDiagnostic(
              `${codePrefix}.source.invalid`,
              `Claude ${configField} must be a nonempty directory path.`,
            ),
            recovery: `Set claude.${configField} to a nonempty directory path relative to the config file, then rebuild.`,
            sourcePath: directory.provenance.sourcePath,
          });
          break;
        default: {
          const exhaustive: never = directory.issue;
          return exhaustive;
        }
      }
      continue;
    }
    if (configField === 'outputStyles') {
      const invalidFiles = directory.files.filter((file) => !file.relativePath.endsWith('.md'));
      if (invalidFiles.length > 0) {
        diagnostics.push({
          ...errorDiagnostic(
            'claude.outputStyles.file.invalid',
            `Claude output style file${invalidFiles.length === 1 ? '' : 's'} ${invalidFiles
              .map((file) => JSON.stringify(file.relativePath))
              .join(', ')} must use the .md suffix.`,
          ),
          recovery: 'Rename every file in the configured Claude output styles directory to use the .md suffix, then rebuild.',
          sourcePath: directory.provenance.sourcePath,
        });
        continue;
      }
    }
    entries.push(...directory.files.map((file): TargetArtifactCopy => ({
      bytes: file.bytes,
      kind: 'copy',
      prebuilt: true,
      relativePath: `${destination}/${file.relativePath}`,
      source: file.source,
      sourceInputs: sourceInputs(directory.provenance.sourcePath, file.source),
    })));
  }
  return deepFreeze({ diagnostics, entries });
};

/**
 * Every key the pinned plugin `settings.json` contract documents. The emitted
 * document copies this allowlist rather than the declared object, so a
 * misspelled key is a build diagnostic instead of a key Claude Code silently
 * ignores at runtime.
 */
const settingsFields: ReadonlySet<string> = new Set(['agent', 'subagentStatusLine']);

/** The two fields the documented `subagentStatusLine` examples carry. */
const subagentStatusLineFields: ReadonlySet<string> = new Set(['command', 'type']);

const settingsTokenDiagnostic = (field: string): Diagnostic => errorDiagnostic(
  'claude.settings.token.unsupported',
  `Claude settings key "${field}" cannot use a path token: the pinned placeholder table substitutes \${CLAUDE_PLUGIN_ROOT} and its siblings in Skill and agent content, hook and monitor commands, MCP servers, and LSP servers only, never in settings.json.`,
);

const planSubagentStatusLine = (
  declared: unknown,
): { readonly diagnostics: readonly Diagnostic[]; readonly value?: Record<string, unknown> } => {
  const diagnostics: Diagnostic[] = [];
  if (!isDataRecord(declared)) {
    diagnostics.push(errorDiagnostic(
      'claude.settings.statusline.invalid',
      'Claude settings subagentStatusLine must be a command object of the form { "type": "command", "command": "<path-or-inline-command>" }.',
    ));
    return { diagnostics };
  }
  for (const field of Object.keys(declared).sort()) {
    if (subagentStatusLineFields.has(field)) continue;
    diagnostics.push(errorDiagnostic(
      'claude.settings.statusline.field.unknown',
      `Claude settings subagentStatusLine declares unknown field "${field}"; the documented subagent status line carries only "type" and "command". The optional "padding" field is documented for the user statusLine, not for a plugin default.`,
    ));
  }
  if (declared['type'] !== 'command') {
    diagnostics.push(errorDiagnostic(
      'claude.settings.statusline.type.invalid',
      'Claude settings subagentStatusLine requires type "command"; the pinned contract documents no other subagent status line type.',
    ));
  }
  const command = declared['command'];
  if (typeof command !== 'string' || command.length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.settings.statusline.command.required',
      'Claude settings subagentStatusLine requires a nonempty command; Claude Code runs it once per refresh tick to render the subagent rows.',
    ));
    return { diagnostics };
  }
  if (hasPathToken(command)) {
    diagnostics.push(settingsTokenDiagnostic('subagentStatusLine.command'));
    return { diagnostics };
  }
  return { diagnostics, value: { command, type: 'command' } };
};

interface ClaudeSettingsPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly sourceInputs: readonly string[];
}

const noSettingsPlan: ClaudeSettingsPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

/**
 * Lowers `claude.settings` into the plugin-root `settings.json` document
 * Claude Code applies as default configuration when the plugin is enabled.
 * The host tolerates unknown keys by ignoring them silently; this compiler
 * rejects them instead, so a default an author asked for never disappears
 * between the config and the running session.
 */
export const planClaudeSettings = (model: NormalizedPlugin): ClaudeSettingsPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noSettingsPlan;
  const declared = extension.value['settings'];
  if (declared === undefined) return noSettingsPlan;
  const diagnostics: Diagnostic[] = [];
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isDataRecord(declared) || Object.keys(declared).length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.settings.declaration.invalid',
      'Claude settings must be a nonempty object declaring agent, subagentStatusLine, or both; an empty settings.json applies no default configuration.',
    ));
    return { diagnostics, sourceInputs: inputs };
  }
  for (const field of Object.keys(declared).sort()) {
    if (settingsFields.has(field)) continue;
    diagnostics.push(errorDiagnostic(
      'claude.settings.field.unknown',
      `Claude settings declares unknown key "${field}"; the pinned contract supports only "agent" and "subagentStatusLine". Claude Code ignores unknown keys silently, so the bundle refuses the declaration instead of shipping a default that never applies.`,
    ));
  }

  const document: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const agent = declared['agent'];
  if (agent !== undefined) {
    if (typeof agent !== 'string' || agent.length === 0) {
      diagnostics.push(errorDiagnostic(
        'claude.settings.agent.invalid',
        'Claude settings agent must be a nonempty plugin agent name; it activates that agent as the main thread.',
      ));
    } else if (hasPathToken(agent)) {
      diagnostics.push(settingsTokenDiagnostic('agent'));
    } else {
      document['agent'] = agent;
    }
  }
  const subagentStatusLine = declared['subagentStatusLine'];
  if (subagentStatusLine !== undefined) {
    const statusLinePlan = planSubagentStatusLine(subagentStatusLine);
    diagnostics.push(...statusLinePlan.diagnostics);
    if (statusLinePlan.value !== undefined) document['subagentStatusLine'] = statusLinePlan.value;
  }
  if (hasErrors(diagnostics)) return { diagnostics, sourceInputs: inputs };

  const valid = validateSettings(document);
  diagnostics.push(...schemaDiagnostics('settings', valid, validateSettings.errors));
  if (!valid) return { diagnostics, sourceInputs: inputs };
  // The setting itself is shippable host configuration, so the deferred
  // plugin-agents component is reported alongside the emitted document
  // rather than in place of it: the agent can still arrive by other means.
  if (typeof document['agent'] === 'string') {
    diagnostics.push(warningDiagnostic(
      'claude.settings.agent.deferred',
      `Claude settings activates plugin agent "${document['agent']}" as the main thread, but the plugin agents component stays deferred (#100 stage 2 G5, PR #220), so this bundle emits no agents/ directory. Ship the agent another way, for example a prebuilt payload that lands agents/${document['agent']}.md at the plugin root, or the setting dangles at runtime.`,
    ));
  }
  return { diagnostics, document, sourceInputs: inputs };
};

const themeFields: ReadonlySet<string> = new Set(['base', 'name', 'overrides']);
const themeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

interface ClaudeThemeDocument {
  readonly document: Record<string, unknown>;
  readonly relativePath: string;
}

interface ClaudeThemesPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly documents: readonly ClaudeThemeDocument[];
  readonly sourceInputs: readonly string[];
}

const noThemesPlan: ClaudeThemesPlan = deepFreeze({
  diagnostics: [],
  documents: [],
  sourceInputs: [],
});

/** Lowers `claude.themes` to one closed JSON document per declaration key. */
export const planClaudeThemes = (model: NormalizedPlugin): ClaudeThemesPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noThemesPlan;
  const declared = extension.value['themes'];
  if (declared === undefined) return noThemesPlan;
  const diagnostics: Diagnostic[] = [];
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!isDataRecord(declared) || Object.keys(declared).length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.themes.declaration.invalid',
      'Claude themes must be a nonempty object mapping safe theme file stems to theme declarations.',
    ));
    return { diagnostics, documents: [], sourceInputs: inputs };
  }

  const documents: ClaudeThemeDocument[] = [];
  for (const key of Object.keys(declared).sort()) {
    if (!themeKeyPattern.test(key)) {
      diagnostics.push(errorDiagnostic(
        'claude.themes.key.invalid',
        `Claude theme key "${key}" must be a safe file stem beginning with an ASCII letter or digit and containing only letters, digits, dots, underscores, or hyphens.`,
      ));
      continue;
    }
    const theme = declared[key];
    if (!isDataRecord(theme)) {
      diagnostics.push(errorDiagnostic(
        'claude.themes.entry.invalid',
        `Claude theme "${key}" must be an object declaring base and optional name and overrides fields.`,
      ));
      continue;
    }
    for (const field of Object.keys(theme).sort()) {
      if (themeFields.has(field)) continue;
      diagnostics.push(errorDiagnostic(
        'claude.themes.field.unknown',
        `Claude theme "${key}" declares unknown field "${field}"; the pinned experimental contract admits only base, name, and overrides.`,
      ));
    }

    const document: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const base = theme['base'];
    if (typeof base !== 'string' || base.length === 0) {
      diagnostics.push(errorDiagnostic(
        'claude.themes.base.required',
        `Claude theme "${key}" requires a nonempty base preset.`,
      ));
    } else {
      document['base'] = base;
    }
    const name = theme['name'];
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      diagnostics.push(errorDiagnostic(
        'claude.themes.name.invalid',
        `Claude theme "${key}" name must be a nonempty string when declared.`,
      ));
    } else {
      document['name'] = name ?? key;
    }
    const overrides = theme['overrides'];
    if (overrides !== undefined) {
      if (!isDataRecord(overrides)) {
        diagnostics.push(errorDiagnostic(
          'claude.themes.overrides.invalid',
          `Claude theme "${key}" overrides must be an object mapping color tokens to strings.`,
        ));
      } else {
        const plannedOverrides: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const token of Object.keys(overrides).sort()) {
          const value = overrides[token];
          if (typeof value !== 'string' || value.length === 0) {
            diagnostics.push(errorDiagnostic(
              'claude.themes.overrides.value.invalid',
              `Claude theme "${key}" override "${token}" must be a nonempty string; the host documentation does not restrict values to hexadecimal colors.`,
            ));
            continue;
          }
          plannedOverrides[token] = value;
        }
        document['overrides'] = plannedOverrides;
      }
    }
    const valid = validateTheme(document);
    diagnostics.push(...schemaDiagnostics('theme', valid, validateTheme.errors));
    if (valid) documents.push({ document, relativePath: `themes/${key}.json` });
  }
  if (hasErrors(diagnostics)) return { diagnostics, documents: [], sourceInputs: inputs };
  return { diagnostics, documents, sourceInputs: inputs };
};

const monitorFields: ReadonlySet<string> = new Set(['command', 'description', 'name', 'when']);
const monitorSkillPrefix = 'on-skill-invoke:';

interface ClaudeMonitorsPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: readonly Record<string, unknown>[];
  readonly sourceInputs: readonly string[];
}

const noMonitorsPlan: ClaudeMonitorsPlan = deepFreeze({
  diagnostics: [],
  sourceInputs: [],
});

/** Lowers `claude.monitors` to the default plugin-root monitor array document. */
export const planClaudeMonitors = (
  model: NormalizedPlugin,
  targetName: string,
): ClaudeMonitorsPlan => {
  const extension = model.extensions[claudeName];
  if (extension === undefined || !isDataRecord(extension.value)) return noMonitorsPlan;
  const declared = extension.value['monitors'];
  if (declared === undefined) return noMonitorsPlan;
  const diagnostics: Diagnostic[] = [];
  const inputs = sourceInputs(extension.provenance.sourcePath);
  if (!Array.isArray(declared) || declared.length === 0) {
    diagnostics.push(errorDiagnostic(
      'claude.monitors.declaration.invalid',
      'Claude monitors must be a nonempty array of background monitor declarations.',
    ));
    return { diagnostics, sourceInputs: inputs };
  }

  const availableSkills = new Set(model.skills
    .filter((skill) => skill.targets.includes(targetName))
    .map((skill) => skill.name));
  const names = new Set<string>();
  const document: Record<string, unknown>[] = [];
  for (const [index, monitor] of declared.entries()) {
    if (!isDataRecord(monitor)) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.entry.invalid',
        `Claude monitors[${index}] must be an object declaring name, command, and description.`,
      ));
      continue;
    }
    for (const field of Object.keys(monitor).sort()) {
      if (monitorFields.has(field)) continue;
      diagnostics.push(errorDiagnostic(
        'claude.monitors.field.unknown',
        `Claude monitors[${index}] declares unknown field "${field}"; the pinned experimental contract admits only name, command, description, and when.`,
      ));
    }

    const planned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const name = monitor['name'];
    if (typeof name !== 'string' || name.length === 0) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.name.required',
        `Claude monitors[${index}] requires a nonempty name unique within the plugin.`,
      ));
    } else if (names.has(name)) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.name.duplicate',
        `Claude monitor name "${name}" is declared more than once; names prevent duplicate processes when the plugin reloads or a skill is invoked again.`,
      ));
    } else {
      names.add(name);
      planned['name'] = name;
    }

    const command = monitor['command'];
    if (typeof command !== 'string' || command.length === 0) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.command.required',
        `Claude monitors[${index}] requires a nonempty persistent shell command.`,
      ));
    } else if (command.includes('${user_config.')) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.command.userConfig',
        `Claude monitors[${index}] command cannot reference \`\${user_config.*}\`; Claude Code runs monitor commands through a shell and rejects them instead of substituting the value, and monitor processes do not receive CLAUDE_PLUGIN_OPTION_ environment variables.`,
      ));
    } else {
      planned['command'] = command;
    }

    const description = monitor['description'];
    if (typeof description !== 'string' || description.length === 0) {
      diagnostics.push(errorDiagnostic(
        'claude.monitors.description.required',
        `Claude monitors[${index}] requires a nonempty description shown in the task panel and notification summaries.`,
      ));
    } else {
      planned['description'] = description;
    }

    const when = monitor['when'];
    if (when !== undefined) {
      if (when === 'always') {
        planned['when'] = when;
      } else if (typeof when === 'string' && when.startsWith(monitorSkillPrefix)) {
        const skill = when.slice(monitorSkillPrefix.length);
        if (skill.length === 0 || !availableSkills.has(skill)) {
          diagnostics.push(errorDiagnostic(
            'claude.monitors.when.invalid',
            `Claude monitors[${index}] when must name a skill emitted by this plugin after "${monitorSkillPrefix}"; no selected skill "${skill}" exists.`,
          ));
        } else {
          planned['when'] = when;
        }
      } else {
        diagnostics.push(errorDiagnostic(
          'claude.monitors.when.invalid',
          `Claude monitors[${index}] when must be "always" or "${monitorSkillPrefix}<skill>".`,
        ));
      }
    }
    document.push(planned);
  }
  if (hasErrors(diagnostics)) return { diagnostics, sourceInputs: inputs };

  const valid = validateMonitors(document);
  diagnostics.push(...schemaDiagnostics('monitors', valid, validateMonitors.errors));
  if (!valid) return { diagnostics, sourceInputs: inputs };
  diagnostics.push(warningDiagnostic(
    'claude.monitors.availability',
    'Claude plugin monitors run only in interactive CLI sessions, unsandboxed at the same trust level as hooks; hosts without the Monitor tool skip them, and project-scope skills-directory plugins do not load them. Disabling a plugin does not stop monitors already running, and plugin updates require a session restart before monitor changes apply.',
  ));
  return { diagnostics, document, sourceInputs: inputs };
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
  const channels = planClaudeChannels(model, new Set(mcpValid ? Object.keys(servers) : []));
  diagnostics.push(...channels.diagnostics);
  const lsp = planClaudeLsp(model);
  diagnostics.push(...lsp.diagnostics);
  const userConfig = planClaudeUserConfig(model);
  diagnostics.push(...userConfig.diagnostics);
  const manifestMetadata = planClaudeManifestMetadata(model);
  diagnostics.push(...manifestMetadata.diagnostics);
  const bin = planClaudeBin(model, targetName);
  diagnostics.push(...bin.diagnostics);
  const outputStyles = planClaudePayloadDirectory({
    configField: 'outputStyles',
    destination: 'output-styles',
    directories: model.hostOutputStyles,
    label: 'output styles',
    targetName,
  });
  diagnostics.push(...outputStyles.diagnostics);
  const workflows = planClaudePayloadDirectory({
    configField: 'workflows',
    destination: 'workflows',
    directories: model.hostWorkflows,
    label: 'workflows',
    targetName,
  });
  diagnostics.push(...workflows.diagnostics);
  const settings = planClaudeSettings(model);
  diagnostics.push(...settings.diagnostics);
  const themes = planClaudeThemes(model);
  diagnostics.push(...themes.diagnostics);
  const monitors = planClaudeMonitors(model, targetName);
  diagnostics.push(...monitors.diagnostics);
  const dependencies = planClaudeDependencies(model);
  diagnostics.push(...dependencies.diagnostics);
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
    ...manifestMetadata.document,
    ...(channels.document === undefined ? {} : { channels: channels.document }),
    ...(dependencies.document === undefined ? {} : { dependencies: dependencies.document }),
    description: model.metadata.description ?? model.metadata.name,
    ...(hookDocument === undefined ? {} : { hooks: `./${hookContract.manifestPath}` }),
    name: model.metadata.name,
    ...(userConfig.document === undefined ? {} : { userConfig: userConfig.document }),
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

  const hostDocuments: StandardPluginHostDocument[] = [];
  if (lsp.document !== undefined) {
    hostDocuments.push({
      document: lsp.document,
      relativePath: claudeArtifactPaths.lsp,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...lsp.sourceInputs),
    });
  }
  if (settings.document !== undefined) {
    hostDocuments.push({
      document: settings.document,
      relativePath: claudeArtifactPaths.settings,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...settings.sourceInputs),
    });
  }
  for (const theme of themes.documents) {
    hostDocuments.push({
      document: theme.document,
      relativePath: theme.relativePath,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...themes.sourceInputs),
    });
  }
  if (monitors.document !== undefined) {
    hostDocuments.push({
      document: monitors.document,
      relativePath: claudeArtifactPaths.monitors,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...monitors.sourceInputs),
    });
  }

  const basePlan = standardPluginArtifactPlan({
    additionalPluginSourceInputs: sourceInputs(
      ...channels.sourceInputs,
      ...userConfig.sourceInputs,
      ...manifestMetadata.sourceInputs,
      ...dependencies.sourceInputs,
    ),
    diagnostics,
    ...(hostDocuments.length === 0 ? {} : { hostDocuments }),
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
      ...outputStyles.entries,
      ...workflows.entries,
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
  outputStyles: Object.freeze({
    allowedSuffixes: Object.freeze(['.md']),
    directory: 'output-styles',
  }),
  workflows: 'workflows',
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
    channels: capabilityStateFromSupport(
      capabilityTable.plugin.channels.bindsToPluginMcpServer &&
        capabilityTable.plugin.channels.perChannelUserConfig,
      evidence,
      'The pinned Claude plugin contract does not document message channel declarations.',
    ),
    commands: capabilityStateFromSupport(
      capabilityTable.plugin.commands,
      evidence,
      'The pinned Claude Code plugin contract does not support commands.',
    ),
    dependencies: capabilityStateFromSupport(
      capabilityTable.plugin.dependencies.autoInstall &&
        capabilityTable.plugin.dependencies.entryForms.includes('name') &&
        capabilityTable.plugin.dependencies.entryForms.includes('object') &&
        capabilityTable.plugin.dependencies.semverRanges,
      evidence,
      'The pinned Claude plugin contract does not document manifest dependencies.',
    ),
    managedAllowManagedHooksOnly: unavailableCapability(
      distributionPolicy.managedAllowManagedHooksOnly.reason,
    ),
    managedBlockedMarketplaces: unavailableCapability(
      distributionPolicy.managedBlockedMarketplaces.reason,
    ),
    managedDisableCommandPluginSources: unavailableCapability(
      distributionPolicy.managedDisableCommandPluginSources.reason,
    ),
    managedDisableSideloadFlags: unavailableCapability(
      distributionPolicy.managedDisableSideloadFlags.reason,
    ),
    managedPluginScope: unavailableCapability(distributionPolicy.managedPluginScope.reason),
    managedPluginSuggestions: unavailableCapability(
      distributionPolicy.managedPluginSuggestions.reason,
    ),
    managedStrictKnownMarketplaces: unavailableCapability(
      distributionPolicy.managedStrictKnownMarketplaces.reason,
    ),
    marketplaceCliLifecycle: unavailableCapability(
      distributionPolicy.marketplaceCliLifecycle.reason,
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
    manifestMetadata: capabilityStateFromSupport(
      capabilityTable.plugin.metadata.defaultEnabled.default &&
        capabilityTable.plugin.metadata.defaultEnabled.field &&
        capabilityTable.plugin.metadata.displayName.fallback === 'name' &&
        capabilityTable.plugin.metadata.displayName.field &&
        capabilityTable.plugin.metadata.freeform.field &&
        capabilityTable.plugin.metadata.freeform.hostReadsValues === false,
      evidence,
      'The pinned Claude plugin contract does not document displayName, metadata, and defaultEnabled manifest fields.',
    ),
    manifestPaths: capabilityStateFromSupport(
      capabilityTable.plugin.paths.addsToDefault.includes('skills') &&
        capabilityTable.plugin.paths.replacesDefault.includes('commands') &&
        capabilityTable.plugin.paths.relativePrefix === './' &&
        capabilityTable.plugin.paths.skillsRootException === '.' &&
        capabilityTable.plugin.paths.skillsRootExceptionSince === '2.1.221',
      evidence,
      'The pinned Claude plugin contract does not document custom component path fields and their replace-versus-add rules.',
    ),
    mcp: capabilityStateFromSupport(
      capabilityTable.mcp.stdio && capabilityTable.mcp.streamableHttp,
      evidence,
      'The pinned Claude contract does not support both required modern MCP transports.',
    ),
    monitors: capabilityStateFromSupport(
      capabilityTable.plugin.monitors.commandTokens.length === 4 &&
        ['${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}', '${CLAUDE_PROJECT_DIR}', '${ENV_VAR}']
          .every((token) => capabilityTable.plugin.monitors.commandTokens.includes(token)) &&
        capabilityTable.plugin.monitors.config === claudeArtifactPaths.monitors &&
        capabilityTable.plugin.monitors.defaultWhen === 'always' &&
        capabilityTable.plugin.monitors.experimental &&
        capabilityTable.plugin.monitors.interactiveCliOnly &&
        capabilityTable.plugin.monitors.manifestField === 'experimental.monitors' &&
        capabilityTable.plugin.monitors.monitorToolRequired &&
        capabilityTable.plugin.monitors.projectScopeSkillsDirectoryPlugins === false &&
        capabilityTable.plugin.monitors.userConfigSubstitution === false &&
        capabilityTable.plugin.monitors.unsandboxed,
      evidence,
      'The pinned Claude plugin contract does not document experimental background monitors.',
    ),
    outputStyles: capabilityStateFromSupport(
      capabilityTable.plugin.outputStyles.directory === 'output-styles' &&
        capabilityTable.plugin.outputStyles.manifestField === 'outputStyles' &&
        capabilityTable.plugin.outputStyles.replacesDefault &&
        capabilityTable.plugin.outputStyles.allowedSuffixes.includes('.md'),
      evidence,
      'The pinned Claude plugin contract does not document the plugin-root output-styles surface.',
    ),
    pluginCliLifecycle: unavailableCapability(distributionPolicy.pluginCliLifecycle.reason),
    pluginInstallScopes: unavailableCapability(distributionPolicy.pluginInstallScopes.reason),
    pluginReload: unavailableCapability(distributionPolicy.pluginReload.reason),
    pluginTrustGates: unavailableCapability(distributionPolicy.pluginTrustGates.reason),
    rules: unavailableCapability(
      'The pinned Claude Code plugin contract (2.1.250) defines no rules component; project guidance ships through CLAUDE.md memory, not a rules directory.',
    ),
    settings: capabilityStateFromSupport(
      capabilityTable.plugin.settings.config === claudeArtifactPaths.settings &&
        capabilityTable.plugin.settings.supportedKeys.length === settingsFields.size &&
        capabilityTable.plugin.settings.supportedKeys.every((key) => settingsFields.has(key)),
      evidence,
      'The pinned Claude plugin contract does not document the plugin-root settings.json defaults surface.',
    ),
    skills: capabilityStateFromSupport(
      capabilityTable.plugin.skills,
      evidence,
      'The pinned Claude plugin contract does not support skills.',
    ),
    skillsDirectoryLspTrust: unavailableCapability(
      distributionPolicy.skillsDirectoryLspTrust.reason,
    ),
    skillsDirectoryMcpApproval: unavailableCapability(
      distributionPolicy.skillsDirectoryMcpApproval.reason,
    ),
    skillsDirectoryMonitors: unavailableCapability(
      distributionPolicy.skillsDirectoryMonitors.reason,
    ),
    skillsDirectoryPlugins: unavailableCapability(
      distributionPolicy.skillsDirectoryPlugins.reason,
    ),
    skillsDirectoryProjectTrust: unavailableCapability(
      distributionPolicy.skillsDirectoryProjectTrust.reason,
    ),
    syncedPlugins: unavailableCapability(distributionPolicy.syncedPlugins.reason),
    themes: capabilityStateFromSupport(
      capabilityTable.plugin.experimentalThemes.defaultDirectory === 'themes' &&
        capabilityTable.plugin.experimentalThemes.experimental &&
        capabilityTable.plugin.experimentalThemes.manifestField === 'experimental.themes' &&
        capabilityTable.plugin.experimentalThemes.readOnly,
      evidence,
      'The pinned Claude plugin contract does not document experimental themes.',
    ),
    userConfig: capabilityStateFromSupport(
      capabilityTable.plugin.userConfig.sensitiveStorage &&
        capabilityTable.plugin.userConfig.projectSettingsIgnored &&
        capabilityTable.plugin.userConfig.installConfigFlag,
      evidence,
      'The pinned Claude plugin contract does not document enable-time userConfig options.',
    ),
    workflows: capabilityStateFromSupport(
      capabilityTable.plugin.workflows.directory === 'workflows' &&
        capabilityTable.plugin.workflows.manifestField === 'workflows' &&
        capabilityTable.plugin.workflows.replacesDefault &&
        capabilityTable.plugin.workflows.fileContents === 'opaque',
      evidence,
      'The pinned Claude plugin contract does not document the plugin-root workflows surface.',
    ),
  }),
  configExtension: Object.freeze({ key: claudeName }),
  hookContract,
  metadata,
  mcpRuntime,
  name: claudeName,
  binSource: (config: Readonly<AgentBundleConfig>) => config.claude?.bin,
  nativeHookSource: (config: Readonly<AgentBundleConfig>) => config.claude?.nativeHooks,
  outputStylesSource: (config: Readonly<AgentBundleConfig>) => config.claude?.outputStyles,
  plan: planClaudeArtifacts,
  workflowsSource: (config: Readonly<AgentBundleConfig>) => config.claude?.workflows,
});
