import { createTargetDiagnostics } from './diagnostics.ts';
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
  intersectCapabilityStates,
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
  cursorHooksValidator,
  cursorManifest,
  cursorMarketplaceValidator,
  cursorMcpValidator,
  cursorPluginNameError,
  cursorPluginValidator,
  cursorVariables,
  emptyCursorHooksDocument,
  isValidCursorPluginName,
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
 * Hooks ship once: both hosts document discovering `hooks/hooks.json` at the
 * plugin root, Codex documents exporting `CLAUDE_PLUGIN_ROOT` into hook
 * processes as a compatibility alias and running commands through a real
 * shell, and its hook envelope and output contract match Claude's - so one
 * Claude-format hook document plus one runtime-host-detecting wrapper per
 * hook serves both hosts. Per-host `nativeHooks` passthrough stays with the
 * host targets.
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
    Object.freeze({ path: bundleHookContract.manifestPath, required: false, schema: 'claude-hooks' }),
    Object.freeze({ path: claudeArtifactPaths.lsp, required: false, schema: 'claude-lsp' }),
    Object.freeze({ path: claudeArtifactPaths.marketplace, required: false, schema: 'claude-marketplace' }),
    Object.freeze({ path: claudeArtifactPaths.mcp, required: false, schema: 'claude-mcp' }),
    Object.freeze({ path: claudeArtifactPaths.plugin, required: true, schema: 'claude-plugin' }),
    Object.freeze({ path: claudeArtifactPaths.settings, required: false, schema: 'claude-settings' }),
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
  adapterRevision: '1.8.0',
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
  commands: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'commands' }),
  hookWrappers: standardArtifactLayout.hookWrappers,
  mcpApps: standardArtifactLayout.mcpApps,
  mcpEntries: standardArtifactLayout.mcpEntries,
  rootDocuments: Object.freeze(['AGENTS.md', ...(standardArtifactLayout.rootDocuments ?? [])]),
  rules: Object.freeze({ allowedSuffixes: Object.freeze(['.mdc']), directory: 'rules' }),
  scripts: standardArtifactLayout.scripts,
  skills: standardArtifactLayout.skills,
});

const { errorDiagnostic, schemaDiagnostics } = createTargetDiagnostics(pluginName, 'Agent plugin bundle');

interface AgentsDocumentOptions {
  /** True when the Claude half emitted plugin-root executables. */
  readonly bin: boolean;
  /** True when the Claude half emitted conventional command prompts. */
  readonly commands: boolean;
  /** True when the Claude half of this bundle emitted `.lsp.json`. */
  readonly lsp: boolean;
  /** True when the Cursor half emitted conventional `.mdc` rules. */
  readonly rules: boolean;
  /** True when the Claude half of this bundle emitted `settings.json`. */
  readonly settings: boolean;
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
    ...(options.rules
      ? [
          '- `rules/` — Cursor rules (`.mdc`), Cursor only; Claude Code and Codex have no rules surface.',
        ]
      : []),
    '- `hooks/` — one `hooks.json` with a host-detecting wrapper per hook (Claude Code and Codex), plus `hooks-cursor.json` with per-hook Cursor wrappers (`<name>.cursor.mjs`).',
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
      const cursorHooks = planHooks(model, pluginName, cursorBundleHookContract);
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
    // `commands/` contains Claude-generated frontmatter. The pinned Cursor
    // evidence establishes plain Markdown commands, but not tolerance for
    // Claude frontmatter, so this composite manifest deliberately omits it.
    const manifest = cursorManifest(model, {
      ...(emitCursorHooks ? { hooks: `./${cursorPaths.hooks}` } : {}),
      ...(cursorMcp !== undefined && cursorMcpValid ? { mcp: `./${cursorPaths.mcp}` } : {}),
      ...(selectedRules.length === 0 ? {} : { rules: './rules/' }),
      ...(model.skills.some((skill) => skill.targets.includes(pluginName)) ? { skills: './skills/' } : {}),
      ...(cursorManifestVariables === undefined ? {} : { variables: cursorManifestVariables }),
    });
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
      commands: selectedCommands.length > 0,
      lsp: entries.some((entry) => entry.relativePath === claudeArtifactPaths.lsp),
      rules: selectedRules.length > 0,
      settings: entries.some((entry) => entry.relativePath === claudeArtifactPaths.settings),
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

const componentCapabilities = Object.freeze(Object.fromEntries(
  ['commands', 'hooks', 'mcp', 'rules', 'skills'].map((capability) => [
    capability,
    unionCapabilityStates(
      unionCapabilityStates(
        claudeAdapter.capabilities[capability]!,
        codexAdapter.capabilities[capability]!,
      ),
      cursorAdapter.capabilities[capability]!,
    ),
  ]),
));

export const pluginAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: Object.freeze({
    ...compositeEventCapabilities,
    bin: unavailableCapability(
      'The unified bundle emits the Claude-only bin directory, but the pinned Codex and Cursor contracts declare no shared plugin executable surface.',
    ),
    commands: intersectCapabilityStates(
      intersectCapabilityStates(claudeAdapter.capabilities.commands!, codexAdapter.capabilities.commands!),
      cursorAdapter.capabilities.commands!,
    ),
    // The Claude half emits the declaration, but neither pinned non-Claude
    // manifest has a shared dependency-resolution surface.
    dependencies: intersectCapabilityStates(
      claudeAdapter.capabilities.dependencies!,
      unavailableCapability(
        'The pinned Codex and Cursor plugin contracts publish no dependency declaration or resolution surface; manifest dependencies reach Claude Code only.',
      ),
    ),
    install: unavailableCapability(
      'Plugin is a multi-host distribution profile, not one host runtime with a single installation transaction.',
    ),
    marketplace: intersectCapabilityStates(
      intersectCapabilityStates(claudeAdapter.capabilities.marketplace!, codexAdapter.capabilities.marketplace!),
      cursorAdapter.capabilities.marketplace!,
    ),
    hooks: intersectCapabilityStates(
      intersectCapabilityStates(claudeAdapter.capabilities.hooks!, codexAdapter.capabilities.hooks!),
      cursorAdapter.capabilities.hooks!,
    ),
    // Cursor is excluded because it declares no LSP capability surface at all.
    // Claude supports LSP and Codex has no LSP surface, so this intersection is
    // honestly unavailable even though the Claude half still emits `.lsp.json`.
    lsp: intersectCapabilityStates(claudeAdapter.capabilities.lsp!, codexAdapter.capabilities.lsp!),
    mcp: intersectCapabilityStates(
      intersectCapabilityStates(claudeAdapter.capabilities.mcp!, codexAdapter.capabilities.mcp!),
      cursorAdapter.capabilities.mcp!,
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
    userConfig: unavailableCapability(
      'The unified bundle emits the Claude-only userConfig manifest field, but the pinned Codex and Cursor contracts declare no shared enable-time option surface.',
    ),
  }),
  componentCapabilities,
  hookContract: bundleHookContract,
  metadata,
  mcpRuntime,
  name: pluginName,
  binSource: (config: Readonly<AgentBundleConfig>) => config.claude?.bin,
  plan,
});
