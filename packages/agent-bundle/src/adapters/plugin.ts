import { createTargetDiagnostics } from './diagnostics.ts';
import type { CapabilityState } from '../core/capabilities.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import type { AgentBundleConfig, NormalizedHook, NormalizedPlugin } from '../core/types.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import {
  cliBinCapability,
  intersectCapabilityStates,
  intersectNoticeDeliveryAdvertisements,
  supportedEventRouteNamesFrom,
  unavailableCapability,
  unionCapabilityStates,
} from './capability-state.ts';
import claudeCapabilityTable from './capabilities/claude-2.1.250.json' with { type: 'json' };
import codexCapabilityTable from './capabilities/codex-0.147.0.json' with { type: 'json' };
import cursorCapabilityTable from './capabilities/cursor-2026-08-28.json' with { type: 'json' };
import { claudeAdapter, claudeArtifactPaths, claudeHooksValidator, planClaudeArtifacts } from './claude.ts';
import { codexAdapter, codexArtifactPaths, codexPluginDocumentValidator, planCodexArtifacts } from './codex.ts';
import {
  createCursorHookContract,
  cursorAdapter,
  cursorContractCapabilityRows,
  cursorHooksValidator,
  cursorManifest,
  cursorMarketplaceValidator,
  cursorMcpValidator,
  cursorPluginNameError,
  cursorPluginValidator,
  cursorVariables,
  emptyCursorHooksDocument,
  isValidCursorPluginName,
  planCursorManifestMetadata,
  planCursorMarketplace,
  planCursorMcpServer,
} from './cursor.ts';
import { pluginLogoCopyEntry } from './plugin-logo.ts';
import {
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  planHooks,
  readStandardNativeHookCommands,
  type TargetHookContract,
} from './hook-contract.ts';
import {
  ruleWriteEntries,
  sortedEntries,
  sourceInputs,
  standardArtifactLayout,
  validateJsonSchemaDocument,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactLayout,
  type TargetArtifactPlan,
  type TargetHookEntry,
} from './types.ts';
import { deepFreeze } from '../core/freeze.ts';


const pluginName = 'plugin';

/**
 * The unified agent plugin bundle lays both host plans into one root: shared
 * `skills/`, `scripts/`, `mcp/`, and `assets/` directories with one manifest
 * directory per host. Claude Code discovers `.mcp.json` at the plugin root by
 * convention, so the Claude document owns that slot; Codex's manifest carries
 * explicit pointers, so its MCP document relocates under `.codex-plugin/`.
 *
 * Hooks ship once: Codex documents discovering `hooks/hooks.json` at the
 * plugin root, exporting `CLAUDE_PLUGIN_ROOT` into hook processes as a
 * compatibility alias and running commands through a real shell, and its
 * hook envelope and output contract match Claude's — so one Claude-format
 * hook document plus one runtime-host-detecting wrapper per hook serves
 * both hosts. Claude Code's `.claude-plugin/plugin.json` names that same
 * `./hooks/hooks.json` so the host does not also load `hooks/hooks-cursor.json`
 * (Cursor's camelCase `hook_event_name` values) from the shared `hooks/`
 * directory. Per-host `nativeHooks` passthrough stays with the host targets.
 *
 * The full Cursor Plugin contract consumes the same root through `.cursor-plugin/plugin.json`: shared
 * `skills/` as-is, the conventional root `mcp.json`, and - because
 * `hooks/hooks.json` has an incompatible Claude/Codex schema - an explicit
 * pointer to the Cursor-format hooks document. Cursor's
 * hook stdin/stdout envelope is not the shared Claude/Codex format, so that
 * document points at dedicated per-hook `hooks/<name>.cursor.mjs` wrappers
 * carrying the Cursor codec; the empty document remains only as a
 * schema-collision guard when no hook lowers to Cursor.
 * Composite capability claims intersect all three pinned host tables.
 *
 * An Agent Plugins v1 root `plugin.json` is deliberately not emitted: Codex
 * selects it ahead of `.codex-plugin/plugin.json` and, under that format,
 * unconditionally disables plugin hooks and apps and forces MCP declarations
 * into a root `mcp.json` - a silent regression for this bundle's hook and
 * relocated-MCP surfaces.
 */
const codexBundleMcpPath = '.codex-plugin/mcp.json';
const cursorPaths = Object.freeze({
  hooks: 'hooks/hooks-cursor.json',
  marketplace: '.cursor-plugin/marketplace.json',
  mcp: 'mcp.json',
  plugin: '.cursor-plugin/plugin.json',
});

/**
 * Union matcher table for the shared hook document. Codex documents Edit and
 * Write as apply_patch aliases and Claude never emits apply_patch, so the
 * superset is safe on both; ^Read$ has no Codex tool and is inert there. The
 * assertion keeps a future capability-table divergence from silently shipping
 * one host's matcher to the other.
 */
const interfaceUnifiedReason =
  'The unified bundle emits the Codex-only interface install surface, but the pinned Claude and Cursor plugin contracts declare no shared interface metadata field.';
const mcpPolicyUnifiedReason =
  'The MCP approval policy is enforced by the Codex host at install time; the pinned Claude and Cursor contracts publish no shared per-plugin MCP policy surface.';
const hookContractUnifiedReason =
  'The unified bundle emits the Codex-only hook handler contract, but the pinned Claude and Cursor hook contracts declare no shared handler-type, timeout, matcher, or trust surface.';
const distributionUnifiedReason =
  'The unified bundle emits the Codex-only marketplace and install-policy surface, but the pinned Claude and Cursor contracts declare no shared marketplace source, cache, enable-state, feature-flag, or managed-requirements surface.';
const codexDistributionCapabilities = [
  'allowManagedHooksOnly',
  'featureHooks',
  'featurePlugins',
  'inlineHooksToml',
  'installCacheLayout',
  'legacyClaudeMarketplaceCompatibility',
  'managedRequirements',
  'marketplaceCategory',
  'marketplaceInterface',
  'marketplacePolicy',
  'marketplaceSources',
  'personalMarketplaceDiscovery',
  'pluginEnableState',
  'repoMarketplaceDiscovery',
  'restrictToAllowedSources',
  'workspacePublishing',
] as const;
const overviewSurfacesUnifiedReason =
  'The Codex plugins overview names optional MCP UI, browser extensions, and scheduled task templates as plugin parts, but the pinned Claude and Cursor plugin contracts publish no shared field for any of them.';
const codexOverviewSurfaceCapabilities = ['browserExtensions', 'mcpUi', 'scheduledTaskTemplates'] as const;
const codexHookContractCapabilities = [
  'hookAdditionalContextLimit',
  'hookAsyncCommands',
  'hookCommandWindows',
  'hookGeneratedSchemas',
  'hookHandlerCommand',
  'hookHandlerMcpTool',
  'hookHandlerPromptAgent',
  'hookMatcherSemantics',
  'hookMcpToolExecution',
  'hookReleaseEvents',
  'hookStatusMessage',
  'hookTimeoutRules',
  'hookTrustReview',
] as const;
const reconciledMatcherKeys = new Set(['file.read', 'file.write']);
const claudeMatchers: Readonly<Record<string, string>> = claudeCapabilityTable.hooks.matchers;
const codexMatchers: Readonly<Record<string, string>> = codexCapabilityTable.hooks.matchers;
for (const key of new Set([...Object.keys(claudeMatchers), ...Object.keys(codexMatchers)])) {
  if (reconciledMatcherKeys.has(key)) continue;
  if (claudeMatchers[key] !== codexMatchers[key]) {
    throw new Error(`Agent plugin bundle matcher table cannot reconcile diverged hook matcher ${JSON.stringify(key)}.`);
  }
}

const bundleHookContract: TargetHookContract = Object.freeze({
  hostContractRevision: `${claudeCapabilityTable.observedCliVersion}+${codexCapabilityTable.observedCliVersion}`,
  // ${CLAUDE_PLUGIN_ROOT} reaches both hosts: Claude substitutes its own
  // token and Codex exports the variable as a documented compatibility alias
  // into a real shell.
  commandRoot: '${CLAUDE_PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: encodeNativeHookPlaygroundOutput,
  eventNames: claudeCapabilityTable.hooks.events,
  eventRouteNames: supportedEventRouteNamesFrom(claudeCapabilityTable.hooks.eventRoutes),
  manifestPath: claudeArtifactPaths.hooksManifest,
  matchers: Object.freeze({
    ...claudeMatchers,
    'file.write': codexMatchers['file.write']!,
  }),
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook: NormalizedHook) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Universal'),
} satisfies TargetHookContract);

const prefixedSchemas = <Schema extends Readonly<{ readonly name: string }>>(
  prefix: string,
  schemas: readonly Schema[],
  omit?: string,
): readonly Schema[] =>
  schemas.filter((schema) => schema.name !== omit)
    .map((schema) => Object.freeze({ ...schema, name: `${prefix}-${schema.name}` }));

const hostValidation = (adapter: TargetAdapter, name: string) => {
  const validation = adapter.artifactValidation;
  if (validation === undefined) throw new Error(`Agent plugin bundle requires the ${name} artifact validation contract.`);
  return validation;
};
const claudeValidation = hostValidation(claudeAdapter, 'Claude');
const codexValidation = hostValidation(codexAdapter, 'Codex');

const artifactValidation = deepFreeze({
  documents: [
    // One shared Claude-format hook document serves both hosts; the pinned
    // Codex hooks schema is byte-identical apart from its $id.
    Object.freeze({ path: codexArtifactPaths.apps, required: false, schema: 'codex-app' }),
    Object.freeze({ path: bundleHookContract.manifestPath, required: false, schema: 'claude-hooks' }),
    Object.freeze({ path: claudeArtifactPaths.lsp, required: false, schema: 'claude-lsp' }),
    Object.freeze({ path: claudeArtifactPaths.marketplace, required: false, schema: 'claude-marketplace' }),
    Object.freeze({ path: claudeArtifactPaths.mcp, required: false, schema: 'claude-mcp' }),
    Object.freeze({ path: claudeArtifactPaths.monitors, required: false, schema: 'claude-monitors' }),
    Object.freeze({ path: claudeArtifactPaths.plugin, required: true, schema: 'claude-plugin' }),
    Object.freeze({ path: claudeArtifactPaths.settings, required: false, schema: 'claude-settings' }),
    Object.freeze({ path: claudeArtifactPaths.themes, required: false, schema: 'claude-theme' }),
    Object.freeze({ path: codexArtifactPaths.marketplace, required: false, schema: 'codex-marketplace' }),
    Object.freeze({ path: codexBundleMcpPath, required: false, schema: 'codex-mcp' }),
    Object.freeze({ path: codexArtifactPaths.plugin, required: true, schema: 'codex-plugin' }),
    Object.freeze({ path: cursorPaths.hooks, required: false, schema: 'cursor-hooks' }),
    Object.freeze({ path: cursorPaths.marketplace, required: false, schema: 'cursor-marketplace' }),
    Object.freeze({ path: cursorPaths.mcp, required: false, schema: 'cursor-mcp' }),
    Object.freeze({ path: cursorPaths.plugin, required: false, schema: 'cursor-plugin' }),
  ],
  schemas: [
    ...prefixedSchemas('claude', claudeValidation.schemas),
    ...prefixedSchemas('codex', codexValidation.schemas, 'plugin').filter((schema) => schema.name !== 'codex-hooks'),
    // The bundle's Codex manifest points at the relocated MCP document, so its
    // validator widens the pinned pointer to that one relocation.
    Object.freeze({ name: 'codex-plugin', validate: (document: unknown) => codexPluginDocumentValidator(codexBundleMcpPath)(document) }),
    Object.freeze({ name: 'cursor-hooks', validate: validateJsonSchemaDocument(cursorHooksValidator) }),
    Object.freeze({ name: 'cursor-marketplace', validate: validateJsonSchemaDocument(cursorMarketplaceValidator) }),
    Object.freeze({ name: 'cursor-mcp', validate: validateJsonSchemaDocument(cursorMcpValidator) }),
    Object.freeze({ name: 'cursor-plugin', validate: validateJsonSchemaDocument(cursorPluginValidator) }),
  ],
});

const metadata = Object.freeze({
  adapterRevision: '1.27.0',
  observedVersion: `${claudeAdapter.metadata.observedVersion}+${codexAdapter.metadata.observedVersion}+${cursorAdapter.metadata.observedVersion}`,
  // Metadata schemas must exactly match the validation contract: each host's
  // documents, with one shared Claude-format hook schema (the pinned Codex
  // hooks schema differs only in its $id).
  schemas: Object.freeze([
    ...prefixedSchemas('claude', claudeAdapter.metadata.schemas),
    ...prefixedSchemas('codex', codexAdapter.metadata.schemas, 'hooks'),
    ...prefixedSchemas('cursor', cursorAdapter.metadata.schemas),
  ]),
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: claudeArtifactPaths.mcp,
  remoteTypes: ['http'],
  validatedButNonModernRemoteTypes: ['sse'],
  resolveValue: createMcpPathTokenResolver({
    knownTokens: standardMcpPathTokens,
    target: pluginName,
    tokens: allMcpPathTokenFields(Object.freeze({
      '${CLAUDE_PLUGIN_DATA}': 'pluginData',
      '${CLAUDE_PLUGIN_ROOT}': 'pluginRoot',
      '${CLAUDE_PROJECT_DIR}': 'workspaceRoot',
    })),
  }),
});

const artifactLayout: TargetArtifactLayout = Object.freeze({
  assets: standardArtifactLayout.assets,
  bin: 'bin',
  cliBin: standardArtifactLayout.cliBin,
  commands: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'commands' }),
  hookWrappers: standardArtifactLayout.hookWrappers,
  mcpApps: standardArtifactLayout.mcpApps,
  mcpEntries: standardArtifactLayout.mcpEntries,
  outputStyles: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'output-styles' }),
  rootDocuments: Object.freeze(['AGENTS.md', ...(standardArtifactLayout.rootDocuments ?? [])]),
  rules: Object.freeze({ allowedSuffixes: Object.freeze(['.mdc']), directory: 'rules' }),
  scripts: standardArtifactLayout.scripts,
  skills: standardArtifactLayout.skills,
  workflows: 'workflows',
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(pluginName, 'Agent plugin bundle');

interface AgentsDocumentOptions {
  /** True when the Claude half emitted plugin-root executables. */
  readonly bin: boolean;
  /** Routed-CLI executables the build compiles into the shared `bin/` (#387). */
  readonly cliBins: readonly string[];
  /** True when the Claude half emitted conventional command prompts. */
  readonly commands: boolean;
  /** True when the Claude half of this bundle emitted `.lsp.json`. */
  readonly lsp: boolean;
  /** True when the Claude half emitted output styles. */
  readonly outputStyles: boolean;
  /** True when the Cursor half emitted conventional `.mdc` rules. */
  readonly rules: boolean;
  /** True when the Claude half of this bundle emitted `settings.json`. */
  readonly settings: boolean;
  /** True when the Claude half emitted workflow scripts. */
  readonly workflows: boolean;
}

const agentsDocument = (model: NormalizedPlugin, options: AgentsDocumentOptions): string => {
  const description = model.metadata.description ?? model.metadata.name;
  return [
    `# ${model.metadata.name}`,
    '',
    description,
    '',
    `This directory is a multi-host agent plugin bundle (version ${model.metadata.version}) compiled by agent-bundle.`,
    'One root serves every supported host: host-specific manifests live in their own directories and share the',
    'same skills, scripts, MCP server bundles, and assets.',
    '',
    '## Install',
    '',
    'See `INSTALL.md` for exact Claude Code, Codex, and Cursor commands using this bundle\'s compiled names.',
    `Cursor can also be installed with \`node ./install.mjs\` into \`~/.cursor/plugins/local/${model.metadata.name}\`.`,
    '- **VS Code / GitHub Copilot**: install the repository as an agent plugin, or consume `skills/` directly.',
    '- **skills CLI**: `npx skills add <source> --skill <name>` reads the `skills/` directory.',
    '',
    '## Layout',
    '',
    '- `.claude-plugin/` — Claude Code manifest and host documents.',
    '- `.codex-plugin/` — Codex manifest and host documents.',
    '- `.cursor-plugin/plugin.json` and root `mcp.json` — Cursor local-plugin manifest and MCP document.',
    '- `.mcp.json` — Claude Code MCP configuration (plugin-root convention).',
    ...(options.lsp
      ? [
          '- `.lsp.json` — Claude Code language-server configuration (plugin-root convention). Claude Code only; Codex and Cursor have no LSP surface.',
        ]
      : []),
    ...(options.settings
      ? [
          '- `settings.json` — Claude Code default configuration applied when the plugin is enabled (plugin-root convention). Claude Code only; Codex and Cursor have no plugin settings surface.',
        ]
      : []),
    ...(options.commands
      ? [
          '- `commands/` — Claude Code command prompts; Codex has no commands surface; the Cursor manifest deliberately does not point at Claude-format command files.',
        ]
      : []),
    ...(options.bin
      ? [
          '- `bin/` — Claude Code executables added to the Bash tool PATH while the plugin is enabled; Codex and Cursor have no declared bin surface.',
        ]
      : []),
    ...options.cliBins.map((name) =>
      `- \`bin/${name}.mjs\` — the compiled routed CLI shared by every host; run it as \`node bin/${name}.mjs --help\` from this directory (skills and scripts reach it through the plugin root).`),
    ...(options.workflows
      ? [
          '- `workflows/` — Claude Code workflow scripts. Codex and Cursor have no declared workflows surface.',
        ]
      : []),
    ...(options.outputStyles
      ? [
          '- `output-styles/` — Claude Code output style definitions. Codex and Cursor have no declared output-styles surface.',
        ]
      : []),
    ...(options.rules
      ? [
          '- `rules/` — Cursor rules (`.mdc`), Cursor only; Claude Code and Codex have no rules surface.',
        ]
      : []),
    '- `hooks/` — one `hooks.json` with a host-detecting wrapper per hook (Claude Code and Codex; named by `.claude-plugin/plugin.json`), plus `hooks-cursor.json` with per-hook Cursor wrappers (`<name>.cursor.mjs`).',
    '- `skills/` — agent skills (`SKILL.md` per skill), shared by every host.',
    '- `scripts/`, `mcp/`, `mcp-apps/`, `assets/` — compiled shared surfaces.',
    '',
    ...(options.lsp
      ? [
          '## Language servers',
          '',
          '`.lsp.json` wires Claude Code to a language server; it does not ship one. Per the Claude Code plugin',
          'reference: "You must install the language server binary separately. LSP plugins configure how Claude Code',
          "connects to a language server, but they don't include the server itself.\" The bundle only carries",
          '`command`, `extensionToLanguage`, and the optional connection fields such as `diagnostics`, so every',
          'declared `command` must already be on the user\'s PATH.',
          '',
          'If a server does not come up, the `/plugin` Errors tab names the cause (`Executable not found in $PATH`',
          'when the binary is missing) and `claude --debug` prints why a server was skipped. When more than one',
          'enabled server declares the same file extension, Claude Code starts only the first one registered.',
          '',
        ]
      : []),
  ].join('\n');
};

const identicalStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const mergeEntries = (
  diagnostics: Diagnostic[],
  left: readonly TargetArtifactEntry[],
  right: readonly TargetArtifactEntry[],
): TargetArtifactEntry[] => {
  const merged = new Map<string, TargetArtifactEntry>();
  for (const entry of [...left, ...right]) {
    const existing = merged.get(entry.relativePath);
    if (existing === undefined) {
      merged.set(entry.relativePath, entry);
      continue;
    }
    const identical = entry.kind === 'write'
      ? existing.kind === 'write' && existing.content === entry.content
      : existing.kind === 'copy' && existing.source === entry.source;
    if (!identical) {
      diagnostics.push(errorDiagnostic(
        'plugin.artifact.conflict',
        `Agent plugin bundle hosts emitted conflicting content for ${JSON.stringify(entry.relativePath)}.`,
      ));
      continue;
    }
    if (!identicalStrings(existing.sourceInputs, entry.sourceInputs)) {
      merged.set(entry.relativePath, Object.freeze({
        ...existing,
        sourceInputs: sourceInputs(...existing.sourceInputs, ...entry.sourceInputs),
      }));
    }
  }
  return [...merged.values()];
};

/**
 * The Claude half is planned hook-free so this adapter can emit one shared
 * `hooks/hooks.json`. Stamp the Claude manifest with that path so Claude
 * Code loads it instead of also discovering `hooks/hooks-cursor.json`.
 */
const attachClaudeHookManifest = (
  entries: TargetArtifactEntry[],
  hookSourceInputs: readonly string[],
): void => {
  const index = entries.findIndex((entry) => entry.relativePath === claudeArtifactPaths.plugin);
  if (index === -1) return;
  const existing = entries[index]!;
  if (existing.kind !== 'write') {
    throw new Error('Agent plugin bundle Claude plugin.json must be a generated write entry.');
  }
  const parsed: unknown = JSON.parse(existing.content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Agent plugin bundle Claude plugin.json must be a JSON object.');
  }
  entries[index] = Object.freeze({
    ...existing,
    content: `${stableJson({ ...parsed, hooks: `./${bundleHookContract.manifestPath}` })}\n`,
    sourceInputs: sourceInputs(...existing.sourceInputs, ...hookSourceInputs),
  });
};

const cursorMcpPlanContext = Object.freeze({ codePrefix: 'plugin.cursor', errorDiagnostic });

const cursorBundleHookContract = createCursorHookContract({
  indexedWrappers: false,
  manifestPath: cursorPaths.hooks,
  wrapperPath: (hook: NormalizedHook) => `hooks/${hook.name}.cursor.mjs`,
});

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  const isSelected = (targets: readonly string[]): boolean => targets.includes(pluginName);
  const selectedCommands = (model.commands ?? []).filter((command) => isSelected(command.targets));
  const selectedRules = (model.rules ?? []).filter((rule) => isSelected(rule.targets));
  // Host planners stay hook-free: the bundle lowers hooks once below, and
  // per-host nativeHooks passthrough remains with the host targets.
  const hookFreeModel: NormalizedPlugin = { ...model, hooks: [], nativeHooks: undefined };
  const generatedHooks = planHooks(model, pluginName, bundleHookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  const hookDocument = generatedHooks.document;
  const hookDocumentValid = hookDocument !== undefined && claudeHooksValidator(hookDocument);
  if (hookDocument !== undefined) {
    diagnostics.push(...schemaDiagnostics('hooks', hookDocumentValid, claudeHooksValidator.errors));
  }

  const claudeSide = planClaudeArtifacts(hookFreeModel, { targetName: pluginName });
  const codexSide = planCodexArtifacts(hookFreeModel, {
    mcpRelativePath: codexBundleMcpPath,
    sharedCopyEntries: false,
    targetName: pluginName,
  });

  diagnostics.push(...claudeSide.diagnostics, ...codexSide.diagnostics);
  const entries = mergeEntries(diagnostics, claudeSide.entries, codexSide.entries);
  const targetSourceInputs = model.targets
    .filter((target) => target.name === pluginName)
    .map((target) => target.provenance.sourcePath);
  const cursorMarketplace = planCursorMarketplace(model);
  diagnostics.push(...cursorMarketplace.diagnostics);
  if (cursorMarketplace.document !== undefined && cursorMarketplace.valid) {
    entries.push({
      content: `${stableJson(cursorMarketplace.document)}\n`,
      kind: 'write',
      relativePath: cursorPaths.marketplace,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
    });
  }
  if (hookDocument !== undefined && hookDocumentValid) {
    const hookSourceInputs = model.hooks
      .filter((hook) => hook.targets.includes(pluginName))
      .map((hook) => hook.provenance.sourcePath);
    attachClaudeHookManifest(entries, hookSourceInputs);
    entries.push({
      content: `${stableJson(hookDocument)}\n`,
      kind: 'write',
      relativePath: bundleHookContract.manifestPath,
      sourceInputs: sourceInputs(...targetSourceInputs, ...hookSourceInputs),
    });
  }
  const cursorServers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  const mcpSourceInputs: string[] = [];
  for (const server of model.mcpServers) {
    if (!server.targets.includes(pluginName)) continue;
    const serverPlan = planCursorMcpServer(server, cursorMcpPlanContext);
    diagnostics.push(...serverPlan.diagnostics);
    if (serverPlan.value !== undefined) {
      cursorServers[server.name] = serverPlan.value;
      mcpSourceInputs.push(server.provenance.sourcePath);
    }
  }
  const cursorMcp = Object.keys(cursorServers).length === 0 ? undefined : { mcpServers: cursorServers };
  const cursorMcpValid = cursorMcp !== undefined && cursorMcpValidator(cursorMcp);
  if (cursorMcp !== undefined) diagnostics.push(...schemaDiagnostics('cursor-mcp', cursorMcpValid, cursorMcpValidator.errors));

  let cursorHookEntries: readonly TargetHookEntry[] = Object.freeze([]);
  if (!isValidCursorPluginName(model.metadata.name)) {
    diagnostics.push(errorDiagnostic('plugin.cursor.name', cursorPluginNameError(model.metadata.name)));
  } else {
    const emitCursorHooks = hookDocument !== undefined && hookDocumentValid;
    // Cursor's envelope is not the shared Claude/Codex format, so its hooks
    // lower separately: a Cursor-shaped document over dedicated
    // `hooks/<name>.cursor.mjs` wrappers. The empty document remains as a
    // schema-collision guard when no hook lowers to Cursor.
    let cursorHooksDocument: Record<string, unknown> = emptyCursorHooksDocument;
    if (emitCursorHooks) {
      const cursorHooks = planHooks(model, pluginName, cursorBundleHookContract, 'cursor');
      diagnostics.push(...cursorHooks.diagnostics);
      if (cursorHooks.document !== undefined) {
        const cursorHooksDocumentValid = cursorHooksValidator(cursorHooks.document);
        diagnostics.push(...schemaDiagnostics('cursor-hooks', cursorHooksDocumentValid, cursorHooksValidator.errors));
        if (cursorHooksDocumentValid) {
          cursorHooksDocument = cursorHooks.document;
          cursorHookEntries = cursorHooks.hookEntries;
        }
      }
    }
    const cursorManifestVariables = cursorVariables(cursorMcp);
    const cursorManifestMetadata = planCursorManifestMetadata(model, cursorMcpPlanContext);
    diagnostics.push(...cursorManifestMetadata.diagnostics);
    // `commands/` contains Claude-generated frontmatter. The pinned Cursor
    // evidence establishes plain Markdown commands, but not tolerance for
    // Claude frontmatter, so this composite manifest deliberately omits it.
    const manifest = cursorManifest(model, {
      ...(emitCursorHooks ? { hooks: `./${cursorPaths.hooks}` } : {}),
      ...(cursorMcp !== undefined && cursorMcpValid ? { mcp: `./${cursorPaths.mcp}` } : {}),
      ...(selectedRules.length === 0 ? {} : { rules: './rules/' }),
      ...(model.skills.some((skill) => skill.targets.includes(pluginName)) ? { skills: './skills/' } : {}),
      ...(cursorManifestVariables === undefined ? {} : { variables: cursorManifestVariables }),
    }, cursorManifestMetadata.document);
    const cursorManifestValid = cursorPluginValidator(manifest);
    diagnostics.push(...schemaDiagnostics('cursor-plugin', cursorManifestValid, cursorPluginValidator.errors));
    if (cursorManifestValid) {
      entries.push({
        content: `${stableJson(manifest)}\n`,
        kind: 'write',
        relativePath: cursorPaths.plugin,
        sourceInputs: sourceInputs(
          model.metadata.provenance.sourcePath,
          ...targetSourceInputs,
          ...selectedRules.map((rule) => rule.source),
          model.metadata.logo?.source,
          ...cursorManifestMetadata.sourceInputs,
        ),
      });
      const logoEntry = pluginLogoCopyEntry(model);
      if (logoEntry !== undefined && !entries.some((entry) => entry.relativePath === logoEntry.relativePath)) {
        entries.push(logoEntry);
      }
      if (cursorMcp !== undefined && cursorMcpValid) {
        entries.push({
          content: `${stableJson(cursorMcp)}\n`,
          kind: 'write',
          relativePath: cursorPaths.mcp,
          sourceInputs: sourceInputs(...targetSourceInputs, ...mcpSourceInputs),
        });
      }
      if (emitCursorHooks) {
        const cursorHookSourceInputs = cursorHookEntries.map((entry) => entry.hook.provenance.sourcePath);
        entries.push({
          content: `${stableJson(cursorHooksDocument)}\n`,
          kind: 'write',
          relativePath: cursorPaths.hooks,
          sourceInputs: sourceInputs(...targetSourceInputs, ...cursorHookSourceInputs),
        });
      }
    } else {
      cursorHookEntries = Object.freeze([]);
    }
  }

  entries.push(...ruleWriteEntries(model, isSelected));
  entries.push({
    content: agentsDocument(model, {
      bin: entries.some((entry) => entry.relativePath.startsWith('bin/')),
      cliBins: (model.packageBuild?.bins ?? [])
        .filter((bin) => bin.generatedCli !== undefined)
        .map((bin) => bin.name),
      commands: selectedCommands.length > 0,
      lsp: entries.some((entry) => entry.relativePath === claudeArtifactPaths.lsp),
      outputStyles: entries.some((entry) => entry.relativePath.startsWith('output-styles/')),
      rules: selectedRules.length > 0,
      settings: entries.some((entry) => entry.relativePath === claudeArtifactPaths.settings),
      workflows: entries.some((entry) => entry.relativePath.startsWith('workflows/')),
    }),
    kind: 'write',
    relativePath: 'AGENTS.md',
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
  });

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hookDocumentValid
      ? Object.freeze([...generatedHooks.hookEntries, ...cursorHookEntries])
      : Object.freeze([]),
  });
};

const eventCapabilityTables = deepFreeze([
  { name: 'Claude', routes: claudeCapabilityTable.hooks.eventRoutes },
  { name: 'Codex', routes: codexCapabilityTable.hooks.eventRoutes },
  { name: 'Cursor', routes: cursorCapabilityTable.hooks.eventRoutes },
]);
const compositeEventNames = new Set(eventCapabilityTables.flatMap(({ routes }) => Object.keys(routes)));
for (const event of compositeEventNames) {
  for (const table of eventCapabilityTables) {
    if (!Object.hasOwn(table.routes, event)) {
      throw new Error(`Agent plugin bundle event capability table for ${table.name} is missing ${JSON.stringify(event)}.`);
    }
  }
}

const compositeEventCapabilities = Object.freeze(Object.fromEntries(
  [...compositeEventNames]
    .sort((left, right) => left.localeCompare(right))
    .map((event) => {
      const capability = `event:${event}`;
      return [
        capability,
        intersectCapabilityStates(
          intersectCapabilityStates(
            claudeAdapter.capabilities[capability]!,
            codexAdapter.capabilities[capability]!,
          ),
          cursorAdapter.capabilities[capability]!,
        ),
      ];
    }),
));

/** The composite emits a kind's surface when any host half does. */
const compositeUnion = (capability: string): CapabilityState => unionCapabilityStates(
  unionCapabilityStates(
    claudeAdapter.capabilities[capability]!,
    codexAdapter.capabilities[capability]!,
  ),
  cursorAdapter.capabilities[capability]!,
);

// One shared plugin root serves every host, so the routed CLI bin is hosted
// exactly like the shared `scripts/` and `mcp/` surfaces (#387).
const cliBinUnion = compositeUnion(cliBinCapability);

const codexHookContractUnifiedCapabilities = Object.freeze(Object.fromEntries([
  ...codexHookContractCapabilities.map((capability) => [
    capability,
    intersectCapabilityStates(
      codexAdapter.capabilities[capability]!,
      unavailableCapability(hookContractUnifiedReason),
    ),
  ]),
  ...codexDistributionCapabilities.map((capability) => [
    capability,
    intersectCapabilityStates(
      codexAdapter.capabilities[capability]!,
      unavailableCapability(distributionUnifiedReason),
    ),
  ]),
  ...codexOverviewSurfaceCapabilities.map((capability) => [
    capability,
    intersectCapabilityStates(
      codexAdapter.capabilities[capability]!,
      unavailableCapability(overviewSurfacesUnifiedReason),
    ),
  ]),
]));

const agentCapabilities = Object.freeze(Object.fromEntries(
  Object.keys(claudeCapabilityTable.plugin.agents).map((rowName) => {
    const capability = rowName === 'component' ? 'agents' : `agents.${rowName}`;
    return [
      capability,
      rowName === 'component'
        ? intersectCapabilityStates(
            intersectCapabilityStates(claudeAdapter.capabilities.agents!, cursorAdapter.capabilities.agents!),
            unavailableCapability('The pinned Codex plugin contract publishes no plugin agents component.'),
          )
        : intersectCapabilityStates(
            claudeAdapter.capabilities[capability]!,
            unavailableCapability(
              'The pinned Codex plugin contract publishes no plugin agents component, and the pinned Cursor agents component documents only name and description frontmatter, so no shared agent-frontmatter surface exists.',
            ),
          ),
    ];
  }),
));

/**
 * Cursor-only contract rows (#189) reach the Cursor half of the bundle only;
 * each composite row is the honest intersection with the hosts that publish
 * no matching surface. Rows shared with Claude or Codex intersect the real
 * host judgments below instead.
 */
const cursorOnlyCapabilities = Object.freeze(Object.fromEntries(
  Object.keys(cursorContractCapabilityRows)
    .filter((capability) => !['agents', 'manifestMetadata', 'marketplaceManifest'].includes(capability))
    .map((capability) => [
      capability,
      intersectCapabilityStates(
        cursorAdapter.capabilities[capability]!,
        unavailableCapability(
          `The pinned Claude Code and Codex plugin contracts publish no shared ${capability} surface; the Cursor row reaches the Cursor half of the bundle only.`,
        ),
      ),
    ]),
));

/**
 * Feature rows (`<kind>.<feature>`, #100) published by any host half. The
 * composite emits Claude-format commands and Cursor rules, so a feature is
 * available to the bundle when the emitting half supports it (union, used by
 * inspection); the intersection keeps the honest three-host judgment.
 */
const compositeFeatureCapabilityNames = Object.freeze([...new Set([
  claudeAdapter, codexAdapter, cursorAdapter,
].flatMap((adapter) => Object.keys(adapter.capabilities)
  .filter((capability) => /^(?:commands|hooks|rules|skills)\./u.test(capability))))].sort((left, right) => left.localeCompare(right)));

const compositeFeatureCapability = (
  capability: string,
  combine: (left: CapabilityState, right: CapabilityState) => CapabilityState,
): CapabilityState => [claudeAdapter, codexAdapter, cursorAdapter]
  .map((adapter) => adapter.capabilities[capability] ?? unavailableCapability(
    `The pinned ${adapter.name} contract publishes no ${capability} feature row.`,
  ))
  .reduce(combine);

/**
 * The composite ships one shared `skills/` tree: a skill lowers to the shared
 * Claude/Codex pass-through document only when it declares no host extension
 * and no placeholder, and otherwise to the portable document, which strips
 * every host extension and admits no Skill Markdown token (AB3008). Neither
 * skill feature therefore reaches the composite regardless of what any host
 * half supports; the emission-dispatch union must not claim otherwise.
 */
const compositeSkillFeatureCapabilities = Object.freeze({
  'skills.hostFrontmatter': unavailableCapability(
    'The unified bundle emits one shared skills/ tree and lowers any skill that declares a host frontmatter extension to the portable document, which strips the extension; per-host skill trees are install-time selection (#101).',
  ),
  'skills.markdownTokens': unavailableCapability(
    'The unified bundle lowers a skill that uses a Skill Markdown token to the portable document, which documents no interpolation placeholder; the token fails closed (AB3008).',
  ),
});

const compositeFeatureCapabilities = (
  combine: (left: CapabilityState, right: CapabilityState) => CapabilityState,
): Readonly<Record<string, CapabilityState>> => Object.freeze({
  ...Object.fromEntries(
    compositeFeatureCapabilityNames
      .filter((capability) => !Object.hasOwn(compositeSkillFeatureCapabilities, capability))
      .map((capability) => [capability, compositeFeatureCapability(capability, combine)]),
  ),
  ...compositeSkillFeatureCapabilities,
});

const pluginCapabilities: Readonly<Record<string, CapabilityState>> = Object.freeze({
  ...cursorOnlyCapabilities,
  ...agentCapabilities,
  ...codexHookContractUnifiedCapabilities,
  ...compositeEventCapabilities,
  ...compositeFeatureCapabilities(intersectCapabilityStates),
  bin: unavailableCapability(
    'The unified bundle emits the Claude-only bin directory, but the pinned Codex and Cursor contracts declare no shared plugin executable surface.',
  ),
  // One shared plugin root serves every host, so the routed CLI bin is
  // hosted exactly like the shared `scripts/` and `mcp/` surfaces (#387).
  [cliBinCapability]: cliBinUnion,
  channels: unavailableCapability(
    'The unified bundle emits the Claude-only channels manifest field, but the pinned Codex and Cursor contracts declare no shared message-channel surface.',
  ),
  commands: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.commands!, codexAdapter.capabilities.commands!),
    cursorAdapter.capabilities.commands!,
  ),
  interfaceAssets: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceAssets!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceBrandColor: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceBrandColor!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceCategoryCapabilities: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceCategoryCapabilities!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceDescriptions: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceDescriptions!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceIdentity: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceIdentity!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceStarterPrompts: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceStarterPrompts!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  interfaceUrls: intersectCapabilityStates(
    codexAdapter.capabilities.interfaceUrls!,
    unavailableCapability(interfaceUnifiedReason),
  ),
  claudePluginDataEnvironment: intersectCapabilityStates(
    codexAdapter.capabilities.claudePluginDataEnvironment!,
    unavailableCapability(
      'The pinned Cursor hook contract does not export the CLAUDE_PLUGIN_DATA compatibility variable, so the unified bundle cannot rely on it across hosts.',
    ),
  ),
  claudePluginRootEnvironment: intersectCapabilityStates(
    codexAdapter.capabilities.claudePluginRootEnvironment!,
    unavailableCapability(
      'The pinned Cursor hook contract does not export the CLAUDE_PLUGIN_ROOT compatibility variable, so the unified bundle cannot rely on it across hosts.',
    ),
  ),
  // The Claude half emits the declaration, but neither pinned non-Claude
  // manifest has a shared dependency-resolution surface.
  dependencies: intersectCapabilityStates(
    claudeAdapter.capabilities.dependencies!,
    unavailableCapability(
      'The pinned Codex and Cursor plugin contracts publish no dependency declaration or resolution surface; manifest dependencies reach Claude Code only.',
    ),
  ),
  nodeDependencyInstall: intersectCapabilityStates(
    claudeAdapter.capabilities.nodeDependencyInstall!,
    unavailableCapability(
      'The unified bundle emits compile-time host artifacts and has no shared host-owned Node dependency installation transaction.',
    ),
  ),
  yarnPnpmInstallAlternative: intersectCapabilityStates(
    claudeAdapter.capabilities.yarnPnpmInstallAlternative!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared Claude-style Yarn or pnpm persistent-data installation fallback.',
    ),
  ),
  pluginCacheLifecycle: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginCacheLifecycle!,
    unavailableCapability(
      'The unified bundle does not own one cross-host plugin cache, version resolution, orphan sweep, or symlink materialization lifecycle.',
    ),
  ),
  pluginPathSubstitution: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginPathSubstitution!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts do not share Claude path placeholders or their component-specific substitution field table.',
    ),
  ),
  pluginDataLifecycle: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginDataLifecycle!,
    unavailableCapability(
      'The unified bundle cannot delete or preserve Claude persistent plugin data as one cross-host uninstall transaction.',
    ),
  ),
  managedAllowManagedHooksOnly: intersectCapabilityStates(
    claudeAdapter.capabilities.managedAllowManagedHooksOnly!,
    unavailableCapability(
      'The unified bundle cannot configure a Claude-only managed hook policy, and the pinned Codex and Cursor contracts publish no shared allowManagedHooksOnly surface.',
    ),
  ),
  managedBlockedMarketplaces: intersectCapabilityStates(
    claudeAdapter.capabilities.managedBlockedMarketplaces!,
    unavailableCapability(
      'The unified bundle cannot configure a Claude-only managed marketplace denylist, and the pinned Codex and Cursor contracts publish no shared blockedMarketplaces surface.',
    ),
  ),
  managedDisableCommandPluginSources: intersectCapabilityStates(
    claudeAdapter.capabilities.managedDisableCommandPluginSources!,
    unavailableCapability(
      'The unified bundle cannot configure Claude-only command-source policy, and the pinned Codex and Cursor contracts publish no shared disableCommandPluginSources surface.',
    ),
  ),
  managedDisableSideloadFlags: intersectCapabilityStates(
    claudeAdapter.capabilities.managedDisableSideloadFlags!,
    unavailableCapability(
      'The unified bundle cannot configure Claude-only sideload policy, and the pinned Codex and Cursor contracts publish no shared disableSideloadFlags surface.',
    ),
  ),
  managedPluginScope: intersectCapabilityStates(
    claudeAdapter.capabilities.managedPluginScope!,
    unavailableCapability(
      'The unified bundle has no cross-host managed installation transaction, and the pinned Codex and Cursor contracts publish no shared managed plugin scope.',
    ),
  ),
  managedPluginSuggestions: intersectCapabilityStates(
    claudeAdapter.capabilities.managedPluginSuggestions!,
    unavailableCapability(
      'The unified bundle cannot configure Claude-only contextual plugin suggestions, and the pinned Codex and Cursor contracts publish no shared pluginSuggestionMarketplaces surface.',
    ),
  ),
  managedStrictKnownMarketplaces: intersectCapabilityStates(
    claudeAdapter.capabilities.managedStrictKnownMarketplaces!,
    unavailableCapability(
      'The unified bundle cannot configure a Claude-only managed marketplace allowlist, and the pinned Codex and Cursor contracts publish no shared strictKnownMarketplaces surface.',
    ),
  ),
  marketplaceCliLifecycle: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.marketplaceCliLifecycle!,
      codexAdapter.capabilities.marketplaceCliLifecycle!,
    ),
    unavailableCapability(
      'The unified bundle emits host marketplace documents but cannot add, list, remove, or update marketplaces as one cross-host lifecycle transaction.',
    ),
  ),
  install: unavailableCapability(
    'Plugin is a multi-host distribution profile, not one host runtime with a single installation transaction.',
  ),
  marketplace: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.marketplace!, codexAdapter.capabilities.marketplace!),
    cursorAdapter.capabilities.marketplace!,
  ),
  marketplaceManifest: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.marketplaceManifest!,
      cursorAdapter.capabilities.marketplaceManifest!,
    ),
    unavailableCapability(
      'The unified bundle emits the Claude marketplace overlay and the Cursor marketplace document, but the pinned Codex contract does not share a completed marketplace manifest surface.',
    ),
  ),
  allowCrossMarketplaceDependenciesOn: intersectCapabilityStates(
    claudeAdapter.capabilities.allowCrossMarketplaceDependenciesOn!,
    unavailableCapability(
      'The unified bundle emits Claude allowCrossMarketplaceDependenciesOn, but the pinned Codex and Cursor contracts declare no shared cross-marketplace dependency allowlist.',
    ),
  ),
  hooks: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.hooks!, codexAdapter.capabilities.hooks!),
    cursorAdapter.capabilities.hooks!,
  ),
  // Cursor is excluded because it declares no LSP capability surface at all.
  // Claude supports LSP and Codex has no LSP surface, so this intersection is
  // honestly unavailable even though the Claude half still emits `.lsp.json`.
  lsp: intersectCapabilityStates(claudeAdapter.capabilities.lsp!, codexAdapter.capabilities.lsp!),
  // No pinned host documents a diagnostics-provider or native extension
  // component, so both canonical kinds are honestly unavailable everywhere.
  nativeDiagnostics: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.nativeDiagnostics!,
      codexAdapter.capabilities.nativeDiagnostics!,
    ),
    cursorAdapter.capabilities.nativeDiagnostics!,
  ),
  nativeExtension: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.nativeExtension!,
      codexAdapter.capabilities.nativeExtension!,
    ),
    cursorAdapter.capabilities.nativeExtension!,
  ),
  manifestMetadata: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.manifestMetadata!,
      codexAdapter.capabilities.manifestMetadata!,
    ),
    cursorAdapter.capabilities.manifestMetadata!,
  ),
  manifestPaths: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.manifestPaths!,
      codexAdapter.capabilities.manifestPaths!,
    ),
    unavailableCapability(
      'The pinned Cursor plugin contract does not share the Codex and Claude custom manifest path rules.',
    ),
  ),
  mcp: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.mcp!, codexAdapter.capabilities.mcp!),
    cursorAdapter.capabilities.mcp!,
  ),
  pluginDataEnvironment: intersectCapabilityStates(
    codexAdapter.capabilities.pluginDataEnvironment!,
    unavailableCapability(
      'The pinned Claude and Cursor hook contracts do not export the Codex-specific PLUGIN_DATA variable, so the unified bundle cannot rely on it across hosts.',
    ),
  ),
  pluginMcpPolicyApprovalModes: intersectCapabilityStates(
    codexAdapter.capabilities.pluginMcpPolicyApprovalModes!,
    unavailableCapability(mcpPolicyUnifiedReason),
  ),
  pluginMcpPolicyEnabled: intersectCapabilityStates(
    codexAdapter.capabilities.pluginMcpPolicyEnabled!,
    unavailableCapability(mcpPolicyUnifiedReason),
  ),
  pluginMcpPolicyTools: intersectCapabilityStates(
    codexAdapter.capabilities.pluginMcpPolicyTools!,
    unavailableCapability(mcpPolicyUnifiedReason),
  ),
  pluginRootEnvironment: intersectCapabilityStates(
    codexAdapter.capabilities.pluginRootEnvironment!,
    unavailableCapability(
      'The pinned Claude and Cursor hook contracts do not export the Codex-specific PLUGIN_ROOT variable, so the unified bundle cannot rely on it across hosts.',
    ),
  ),
  registeredMcpApps: intersectCapabilityStates(
    codexAdapter.capabilities.registeredMcpApps!,
    unavailableCapability(
      'The pinned Claude and Cursor plugin contracts publish no registered-MCP app mapping document; the emitted .app.json reaches Codex only.',
    ),
  ),
  monitors: unavailableCapability(
    'The unified bundle emits Claude-only experimental background monitors, but the pinned Codex and Cursor contracts declare no shared monitor surface.',
  ),
  outputStyles: unavailableCapability(
    'The unified bundle emits Claude-only output styles, but the pinned Codex and Cursor contracts declare no shared output styles surface.',
  ),
  pluginCliLifecycle: intersectCapabilityStates(
    intersectCapabilityStates(
      claudeAdapter.capabilities.pluginCliLifecycle!,
      codexAdapter.capabilities.pluginCliLifecycle!,
    ),
    unavailableCapability(
      'The unified bundle emits host artifacts but cannot run Claude-only plugin creation, installation, state, inspection, update, or release commands.',
    ),
  ),
  pluginInstallScopes: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginInstallScopes!,
    unavailableCapability(
      'The unified bundle has no shared user, project, local, or managed installation-scope transaction across its three hosts.',
    ),
  ),
  pluginReload: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginReload!,
    unavailableCapability(
      'The unified bundle cannot reload or restart running host sessions, and the pinned hosts publish no shared plugin reload lifecycle.',
    ),
  ),
  pluginTrustGates: intersectCapabilityStates(
    claudeAdapter.capabilities.pluginTrustGates!,
    unavailableCapability(
      'The unified bundle cannot accept host trust or security prompts, and the pinned hosts publish no shared plugin trust-gate transaction.',
    ),
  ),
  // The bundle exposes Cursor's real rules directory; the composite row is
  // the honest three-host intersection, so it stays non-supported while
  // Claude and Codex cannot consume rules.
  rules: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.rules!, codexAdapter.capabilities.rules!),
    cursorAdapter.capabilities.rules!,
  ),
  // Neither pinned non-Claude contract declares a plugin settings-defaults
  // surface at all, so this intersection is honestly unavailable even
  // though the Claude half still emits `settings.json`.
  settings: intersectCapabilityStates(
    claudeAdapter.capabilities.settings!,
    unavailableCapability(
      'The pinned Codex and Cursor plugin contracts publish no plugin settings-defaults surface; plugin-root settings.json reaches Claude Code only.',
    ),
  ),
  skills: intersectCapabilityStates(
    intersectCapabilityStates(claudeAdapter.capabilities.skills!, codexAdapter.capabilities.skills!),
    cursorAdapter.capabilities.skills!,
  ),
  skillsDirectoryLspTrust: intersectCapabilityStates(
    claudeAdapter.capabilities.skillsDirectoryLspTrust!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared @skills-dir LSP trust gate.',
    ),
  ),
  skillsDirectoryMcpApproval: intersectCapabilityStates(
    claudeAdapter.capabilities.skillsDirectoryMcpApproval!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared @skills-dir per-server MCP approval gate.',
    ),
  ),
  skillsDirectoryMonitors: intersectCapabilityStates(
    claudeAdapter.capabilities.skillsDirectoryMonitors!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared project-scope @skills-dir monitor policy.',
    ),
  ),
  skillsDirectoryPlugins: intersectCapabilityStates(
    claudeAdapter.capabilities.skillsDirectoryPlugins!,
    unavailableCapability(
      'The unified bundle does not install into host skills directories, and the pinned Codex and Cursor contracts publish no shared @skills-dir identity.',
    ),
  ),
  skillsDirectoryProjectTrust: intersectCapabilityStates(
    claudeAdapter.capabilities.skillsDirectoryProjectTrust!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared project-scope @skills-dir workspace-trust gate.',
    ),
  ),
  syncedPlugins: intersectCapabilityStates(
    claudeAdapter.capabilities.syncedPlugins!,
    unavailableCapability(
      'The pinned Codex and Cursor contracts publish no shared claude.ai-style account plugin synchronization surface.',
    ),
  ),
  themes: unavailableCapability(
    'The unified bundle emits Claude-only experimental themes, but the pinned Codex and Cursor contracts declare no shared theme surface.',
  ),
  userConfig: unavailableCapability(
    'The unified bundle emits the Claude-only userConfig manifest field, but the pinned Codex and Cursor contracts declare no shared enable-time option surface.',
  ),
  workflows: unavailableCapability(
    'The unified bundle emits Claude-only workflows, but the pinned Codex and Cursor contracts declare no shared workflows surface.',
  ),
});

/**
 * Emission dispatch per canonical component kind (#100): every published
 * intersection row stays visible to inspection (the `agents` G5 deferral keeps
 * its reason), and the kinds the composite emits when any host half does
 * (`lsp` rides the Claude half even though the three-host intersection stays
 * unavailable) are overridden with the union so inspection reports what the
 * bundle actually writes. Event routes lower through the shared bundle hook
 * contract and keep the intersection judgment validation already applies.
 */
const componentCapabilities: Readonly<Record<string, CapabilityState>> = Object.freeze({
  ...pluginCapabilities,
  ...compositeFeatureCapabilities(unionCapabilityStates),
  ...Object.fromEntries(
    [cliBinCapability, 'commands', 'hooks', 'lsp', 'mcp', 'nativeDiagnostics', 'nativeExtension', 'rules', 'skills']
      .map((capability) => [capability, compositeUnion(capability)]),
  ),
});

export const pluginAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: pluginCapabilities,
  componentCapabilities,
  hookContract: bundleHookContract,
  // The composite plans the Claude and Codex sides from their own config
  // extensions, so host-scoped declarations under those keys (for example
  // `claude.lspServers`) are eligible for emission here.
  lowersConfigExtensions: Object.freeze([claudeAdapter.name, codexAdapter.name]),
  metadata,
  mcpRuntime,
  name: pluginName,
  // A unified bundle's generated MCP entry serves all three hosts, so it may
  // only wire the cross-request routes every pinned host advertises.
  noticeDelivery: intersectNoticeDeliveryAdvertisements(
    intersectNoticeDeliveryAdvertisements(claudeAdapter.noticeDelivery!, codexAdapter.noticeDelivery!),
    cursorAdapter.noticeDelivery!,
  ),
  binSource: (config: Readonly<AgentBundleConfig>) => config.claude?.bin,
  outputStylesSource: (config: Readonly<AgentBundleConfig>) => config.claude?.outputStyles,
  plan,
  workflowsSource: (config: Readonly<AgentBundleConfig>) => config.claude?.workflows,
});
