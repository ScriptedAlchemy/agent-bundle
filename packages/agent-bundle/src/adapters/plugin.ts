import { createTargetDiagnostics } from './diagnostics.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import claudeCapabilityTable from './capabilities/claude-2.1.232.json' with { type: 'json' };
import codexCapabilityTable from './capabilities/codex-0.147.0.json' with { type: 'json' };
import {
  encodeNativeHookPlaygroundInput,
  encodeNativeHookPlaygroundOutput,
  nativeHookWrapperSource,
  planHooks,
  readStandardNativeHookCommands,
  type TargetHookContract,
} from './hook-contract.ts';
import {
  allMcpPathTokenFields,
  createMcpPathTokenResolver,
  standardMcpPathTokens,
} from '../services/mcp-path-tokens.ts';
import { createTargetMcpRuntime } from '../services/mcp-runtime.ts';
import { claudeAdapter, planClaudeArtifacts } from './claude.ts';
import { codexAdapter, planCodexArtifacts } from './codex.ts';
import claudeSchemaProvenance from './schemas/claude/PROVENANCE.json' with { type: 'json' };
import claudeHooksSchema from './schemas/claude/hooks.schema.json' with { type: 'json' };
import claudeMarketplaceSchema from './schemas/claude/marketplace.schema.json' with { type: 'json' };
import claudeMcpSchema from './schemas/claude/mcp.schema.json' with { type: 'json' };
import claudePluginSchema from './schemas/claude/plugin.schema.json' with { type: 'json' };
import codexMarketplaceSchema from './schemas/codex/marketplace.schema.json' with { type: 'json' };
import codexMcpSchema from './schemas/codex/mcp.schema.json' with { type: 'json' };
import codexPluginSchema from './schemas/codex/plugin.schema.json' with { type: 'json' };
import { stableJson } from '../core/digest.ts';
import {
  createAdapterValidator,
  schemaDescriptorsFrom,
  sortedEntries,
  sourceInputs,
  standardArtifactLayout,
  validateJsonSchemaDocument,
  validateModernMcpDocument,
  type TargetAdapter,
  type TargetArtifactEntry,
  type TargetArtifactLayout,
  type TargetArtifactPlan,
} from './types.ts';

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
 * host targets. A root Agent Plugins v1 manifest is deliberately not emitted:
 * Codex resolves it ahead of `.codex-plugin/plugin.json`, which would mask
 * this bundle's relocated MCP pointer.
 */
const claudePaths = Object.freeze({
  marketplace: '.claude-plugin/marketplace.json',
  mcp: '.mcp.json',
  plugin: '.claude-plugin/plugin.json',
});
const codexPaths = Object.freeze({
  marketplace: '.agents/plugins/marketplace.json',
  mcp: '.codex-plugin/mcp.json',
  plugin: '.codex-plugin/plugin.json',
});

const bundleHookContract: TargetHookContract = Object.freeze({
  // ${CLAUDE_PLUGIN_ROOT} reaches both hosts: Claude substitutes its own
  // token and Codex exports the variable as a documented compatibility alias
  // into a real shell.
  commandRoot: '${CLAUDE_PLUGIN_ROOT}',
  encodePlaygroundInput: encodeNativeHookPlaygroundInput,
  encodePlaygroundOutput: encodeNativeHookPlaygroundOutput,
  eventNames: claudeCapabilityTable.hooks.events,
  manifestPath: 'hooks/hooks.json',
  // Union matcher table: Codex documents Edit/Write as apply_patch aliases,
  // and Claude never emits apply_patch, so the superset is safe on both;
  // ^Read$ has no Codex tool and is inert there.
  matchers: Object.freeze({
    ...claudeCapabilityTable.hooks.matchers,
    'file.write': codexCapabilityTable.hooks.matchers['file.write'],
  }),
  readNativeCommands: readStandardNativeHookCommands,
  wrapperPath: (hook) => `hooks/${hook.name}.mjs`,
  wrapperSource: (entry) => nativeHookWrapperSource(entry, 'Universal'),
} satisfies TargetHookContract);

/**
 * The pinned Codex schema const-locks the manifest's `mcpServers` pointer to
 * its conventional root path. The field is a path pointer and the bundle
 * relocates the Codex MCP document into the manifest directory, so the
 * bundle's manifest validator accepts exactly the conventional path or the
 * bundle's relocated path - nothing wider.
 */
const withRelocatedPointer = (
  schema: Record<string, unknown>,
  overrides: Readonly<Record<string, string>>,
): Record<string, unknown> => {
  const cloned = structuredClone(schema);
  const properties = cloned['properties'] as Record<string, Record<string, unknown>>;
  for (const [field, relocated] of Object.entries(overrides)) {
    const canonical = properties[field]?.['const'];
    if (typeof canonical !== 'string') throw new Error(`Pinned schema pointer ${field} is not a const string.`);
    properties[field] = { enum: [canonical, relocated], type: 'string' };
  }
  return cloned;
};

const codexBundlePluginSchema = withRelocatedPointer(codexPluginSchema, {
  mcpServers: `./${codexPaths.mcp}`,
});

const validator = createAdapterValidator();
const validateClaudePlugin = validator.compile(claudePluginSchema);
const validateHooks = validator.compile(claudeHooksSchema);
const validateClaudeMcp = validator.compile(claudeMcpSchema);
const validateClaudeMarketplace = validator.compile(claudeMarketplaceSchema);
const validateCodexPlugin = validator.compile(codexBundlePluginSchema);
const validateCodexMcp = validator.compile(codexMcpSchema);
const validateCodexMarketplace = validator.compile(codexMarketplaceSchema);

const artifactValidation = Object.freeze({
  documents: Object.freeze([
    // One shared Claude-format hook document serves both hosts; the pinned
    // Codex hooks schema is byte-identical apart from its $id.
    Object.freeze({ path: bundleHookContract.manifestPath, required: false, schema: 'claude-hooks' }),
    Object.freeze({ path: claudePaths.marketplace, required: false, schema: 'claude-marketplace' }),
    Object.freeze({ path: claudePaths.mcp, required: false, schema: 'claude-mcp' }),
    Object.freeze({ path: claudePaths.plugin, required: true, schema: 'claude-plugin' }),
    Object.freeze({ path: codexPaths.marketplace, required: false, schema: 'codex-marketplace' }),
    Object.freeze({ path: codexPaths.mcp, required: false, schema: 'codex-mcp' }),
    Object.freeze({ path: codexPaths.plugin, required: true, schema: 'codex-plugin' }),
  ]),
  schemas: Object.freeze([
    Object.freeze({ name: 'claude-hooks', validate: validateJsonSchemaDocument(validateHooks) }),
    Object.freeze({ name: 'claude-marketplace', validate: validateJsonSchemaDocument(validateClaudeMarketplace) }),
    Object.freeze({ name: 'claude-mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateClaudeMcp)) }),
    Object.freeze({ name: 'claude-plugin', validate: validateJsonSchemaDocument(validateClaudePlugin) }),
    Object.freeze({ name: 'codex-marketplace', validate: validateJsonSchemaDocument(validateCodexMarketplace) }),
    Object.freeze({ name: 'codex-mcp', validate: validateModernMcpDocument(validateJsonSchemaDocument(validateCodexMcp)) }),
    Object.freeze({ name: 'codex-plugin', validate: validateJsonSchemaDocument(validateCodexPlugin) }),
  ]),
});

const metadata = Object.freeze({
  adapterRevision: '1.0.0',
  capabilityRevision: `claude ${claudeAdapter.metadata.observedVersion} + codex ${codexAdapter.metadata.observedVersion}`,
  capabilitySha256: claudeAdapter.metadata.capabilitySha256,
  observedVersion: `${claudeAdapter.metadata.observedVersion}+${codexAdapter.metadata.observedVersion}`,
  // Metadata schemas must exactly match the validation contract: each host's
  // marketplace, MCP, and plugin documents, plus the one shared Claude-format
  // hook document (the pinned Codex hooks schema differs only in its $id).
  schemas: Object.freeze([
    ...schemaDescriptorsFrom(claudeSchemaProvenance, claudeSchemaProvenance.observedCliVersion)
      .map((schema) => Object.freeze({ ...schema, name: `claude-${schema.name}` })),
    ...codexAdapter.metadata.schemas
      .filter((schema) => schema.name !== 'hooks')
      .map((schema) => Object.freeze({ ...schema, name: `codex-${schema.name}` })),
  ]),
});

const mcpRuntime = createTargetMcpRuntime({
  manifestPath: claudePaths.mcp,
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
  hookWrappers: standardArtifactLayout.hookWrappers,
  mcpApps: standardArtifactLayout.mcpApps,
  mcpEntries: standardArtifactLayout.mcpEntries,
  rootDocuments: Object.freeze(['AGENTS.md']),
  scripts: standardArtifactLayout.scripts,
  skills: standardArtifactLayout.skills,
});

const { errorDiagnostic } = createTargetDiagnostics(pluginName, 'Agent plugin bundle');

const agentsDocument = (model: NormalizedPlugin): string => {
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
    '- **Claude Code**: add this directory (or its repository) as a plugin — `claude plugin marketplace add <source>`.',
    '- **Codex**: `codex plugin marketplace add <source>`; the manifest is `.codex-plugin/plugin.json`.',
    '- **Cursor / VS Code / GitHub Copilot**: install the repository as an agent plugin, or consume `skills/` directly.',
    '- **skills CLI**: `npx skills add <source> --skill <name>` reads the `skills/` directory.',
    '',
    '## Layout',
    '',
    '- `.claude-plugin/` — Claude Code manifest and host documents.',
    '- `.codex-plugin/` — Codex manifest and host documents.',
    '- `.mcp.json` — Claude Code MCP configuration (plugin-root convention).',
    '- `skills/` — agent skills (`SKILL.md` per skill), shared by every host.',
    '- `hooks/` — one `hooks.json` and one host-detecting wrapper per hook, shared by both hosts.',
    '- `scripts/`, `mcp/`, `mcp-apps/`, `assets/` — compiled shared surfaces.',
    '',
  ].join('\n');
};

const mergeEntries = (
  diagnostics: Diagnostic[],
  sides: readonly (readonly TargetArtifactEntry[])[],
): TargetArtifactEntry[] => {
  const merged = new Map<string, TargetArtifactEntry>();
  for (const entries of sides) {
    for (const entry of entries) {
      const existing = merged.get(entry.relativePath);
      if (existing === undefined) {
        merged.set(entry.relativePath, entry);
        continue;
      }
      const identical = existing.kind === entry.kind && (
        entry.kind === 'write'
          ? existing.kind === 'write' && existing.content === entry.content
          : existing.kind === 'copy' && existing.source === entry.source);
      if (!identical) {
        diagnostics.push(errorDiagnostic(
          'plugin.artifact.conflict',
          `Agent plugin bundle hosts emitted conflicting content for ${JSON.stringify(entry.relativePath)}.`,
        ));
        continue;
      }
      const combinedInputs = sourceInputs(...existing.sourceInputs, ...entry.sourceInputs);
      if (combinedInputs.length !== existing.sourceInputs.length) {
        merged.set(entry.relativePath, Object.freeze({ ...existing, sourceInputs: combinedInputs }));
      }
    }
  }
  return [...merged.values()];
};

const plan = (model: NormalizedPlugin): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [];
  // Host planners stay hook-free: the bundle lowers hooks once below, and
  // per-host nativeHooks passthrough remains with the host targets.
  const hookFreeModel: NormalizedPlugin = { ...model, hooks: [], nativeHooks: undefined };
  const generatedHooks = planHooks(model, pluginName, bundleHookContract);
  diagnostics.push(...generatedHooks.diagnostics);
  const hookDocument = generatedHooks.document;
  const hookDocumentValid = hookDocument !== undefined && validateHooks(hookDocument);
  if (hookDocument !== undefined && !hookDocumentValid) {
    for (const issue of validateHooks.errors ?? []) {
      diagnostics.push(errorDiagnostic('plugin.hooks.schema', `Agent plugin bundle hook document is invalid at ${issue.instancePath || '/'}: ${issue.message ?? 'schema validation failed'}.`));
    }
  }

  const claudeSide = planClaudeArtifacts(hookFreeModel, { targetName: pluginName });
  const codexSide = planCodexArtifacts(hookFreeModel, {
    mcpRelativePath: codexPaths.mcp,
    pluginDocumentValidator: validateCodexPlugin,
    targetName: pluginName,
  });

  diagnostics.push(...claudeSide.diagnostics, ...codexSide.diagnostics);
  const entries = mergeEntries(diagnostics, [claudeSide.entries, codexSide.entries]);
  const targetSourceInputs = model.targets
    .filter((target) => target.name === pluginName)
    .map((target) => target.provenance.sourcePath);
  if (hookDocument !== undefined && hookDocumentValid) {
    const hookSourceInputs = model.hooks
      .filter((hook) => hook.targets.includes(pluginName))
      .flatMap((hook) => [hook.provenance.sourcePath, hook.source]);
    entries.push({
      content: `${stableJson(hookDocument)}\n`,
      kind: 'write',
      relativePath: bundleHookContract.manifestPath,
      sourceInputs: sourceInputs(...targetSourceInputs, ...hookSourceInputs),
    });
  }
  entries.push({
    content: agentsDocument(model),
    kind: 'write',
    relativePath: 'AGENTS.md',
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
  });

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries: hookDocumentValid ? generatedHooks.hookEntries : Object.freeze([]),
  });
};

export const pluginAdapter: TargetAdapter = Object.freeze({
  artifactValidation,
  artifactLayout,
  capabilities: Object.freeze({
    marketplace: true,
    hooks: claudeAdapter.capabilities.hooks === true && codexAdapter.capabilities.hooks === true,
    mcp: claudeAdapter.capabilities.mcp === true && codexAdapter.capabilities.mcp === true,
    skills: claudeAdapter.capabilities.skills === true && codexAdapter.capabilities.skills === true,
  }),
  hookContract: bundleHookContract,
  metadata,
  mcpRuntime,
  name: pluginName,
  plan,
});
