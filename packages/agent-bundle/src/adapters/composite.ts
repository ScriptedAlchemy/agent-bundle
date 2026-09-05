import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import type { AgentBundleConfig, NormalizedHook, NormalizedPlugin } from '../core/types.ts';
import { deepFreeze } from '../core/freeze.ts';
import {
  compositeHostNames,
  compositeTargetName,
  isCompositeHost,
  sortedCompositeHosts,
  type CompositeHost,
} from './composite-hosts.ts';
import { intersectNoticeDeliveryAdvertisements, unionCapabilityStates } from './capability-state.ts';
import type { CapabilityState } from '../core/capabilities.ts';
import { claudeAdapter, claudeArtifactPaths, planClaudeArtifacts } from './claude.ts';
import { codexAdapter, codexArtifactPaths, codexPluginDocumentValidator, planCodexArtifacts } from './codex.ts';
import {
  createCursorHookContract,
  cursorAdapter,
  cursorArtifactPaths,
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
import { planHooks, type HookPlanRootOptions, type TargetHookContract } from './hook-contract.ts';
import { portableAdapter } from './portable.ts';
import {
  commandWriteEntries,
  ruleWriteEntries,
  sortedEntries,
  sourceInputs,
  standardArtifactLayout,
  validateJsonSchemaDocument,
  type TargetAdapter,
  type TargetAdapterMetadata,
  type TargetArtifactEntry,
  type TargetArtifactLayout,
  type TargetArtifactPlan,
  type TargetArtifactValidationContract,
  type TargetHookEntry,
} from './types.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';
import { localMcpOutputName } from '../build/entries.ts';
import { withInstallSurface, type BuiltInTarget } from '../install/surface.ts';

/**
 * A root composed of several host projections (#555).
 *
 * Agent Bundle emits exactly one plugin root. Selecting one target stages that
 * host's plan at the root unchanged; selecting several composes their plans
 * into the same root: shared `skills/`, `scripts/`, `mcp/`, `mcp-apps/`,
 * `bin/`, and `assets/` are emitted once, and each host keeps its own manifest
 * directory and host documents. Where two hosts read one conventional file the
 * composition either relocates the document a host reads through an explicit
 * manifest pointer, or refuses with a diagnostic; it never widens a
 * declaration's host scope silently.
 *
 * - Claude Code owns the conventional slots it discovers on its own
 *   (`hooks/hooks.json`, `.mcp.json`, `commands/`). Codex reads its hooks and
 *   MCP documents through `.codex-plugin/plugin.json` pointers, so beside
 *   Claude they relocate to `.codex-plugin/hooks.json` and
 *   `.codex-plugin/mcp.json`. Cursor's hook schema is incompatible with the
 *   Claude/Codex one, so beside another host its document is
 *   `hooks/hooks-cursor.json` over dedicated `hooks/<name>.cursor.mjs`
 *   wrappers; its root `mcp.json` collides with nothing.
 * - A hook selecting Claude Code and Codex compiles to one host-detecting
 *   wrapper (`hooks/<name>.mjs`) that both host documents reference. Codex
 *   documents exporting `CLAUDE_PLUGIN_ROOT` and `PLUGIN_ROOT` into hook
 *   processes, and its hook envelope matches Claude's, which is what makes
 *   the shared wrapper sound.
 * - `skills/` is discovered conventionally by every host, so a skill must
 *   select every selected host or none of them (AB4104). Its Markdown is the
 *   one document every selected host accepts (see the normalizer's shared
 *   skill document).
 * - An Agent Plugins v1 root `plugin.json` makes Codex prefer it over
 *   `.codex-plugin/plugin.json` (disabling hooks and apps and forcing a root
 *   `mcp.json`), and the portable and Cursor projections both own the root
 *   `mcp.json`. Beside any other host the portable projection is therefore
 *   the namespaced view `portable/`: a complete Agent Plugins pack whose
 *   `mcp.json` reaches the shared compiled servers through `portable/mcp/`
 *   shims, installed and validated as its own plugin root.
 */
export {
  compositeHostNames,
  compositeTargetName,
  isCompositeHost,
  sortedCompositeHosts,
  type CompositeHost,
} from './composite-hosts.ts';

const codexCompositePaths = Object.freeze({
  hooks: '.codex-plugin/hooks.json',
  mcp: '.codex-plugin/mcp.json',
});
const cursorCompositePaths = Object.freeze({
  hooks: 'hooks/hooks-cursor.json',
  marketplace: cursorArtifactPaths.marketplace,
  mcp: cursorArtifactPaths.mcp,
  plugin: cursorArtifactPaths.plugin,
});
/** The namespaced Agent Plugins view of a composite root. */
export const portableViewDirectory = 'portable';

/**
 * The directory, relative to the composite root, that one host reads as its
 * plugin root: the root itself for every host except the portable projection,
 * which beside other hosts lives in `portable/`. Empty for a single-host root.
 */
export const compositeHostRoot = (hosts: readonly string[], host: string): string => {
  const selected = sortedCompositeHosts(hosts);
  return selected.length > 1 && host === 'portable' ? portableViewDirectory : '';
};

/** Composite diagnostics name no target: the whole root is at issue, not one projection. */
const errorDiagnostic = (code: string, message: string): Diagnostic => Object.freeze({ code, message, severity: 'error' });
const schemaDiagnostics = (
  document: string,
  valid: boolean,
  errors: readonly { readonly instancePath: string; readonly message?: string }[] | null | undefined,
): Diagnostic[] => valid
  ? []
  : [errorDiagnostic(
      `composite.schema.${document}`,
      `Composite plugin root ${document}.json is invalid: ${(errors ?? [])
        .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
        .join('; ') || 'schema validation failed'}.`,
    )];

const scopeMessage = (
  kind: string,
  name: string,
  selected: readonly string[],
  hosts: readonly CompositeHost[],
  reason: string,
): string =>
  `${kind} ${JSON.stringify(name)} selects ${JSON.stringify(selected)} but this root projects ${JSON.stringify(hosts)}; ${reason} `
  + 'Select every projected host (or none of them) on the declaration, or build the hosts that differ into a separate --output.';

/**
 * AB4104: a declaration whose emitted file is read by every projected host
 * must select all of them or none, because one root cannot isolate it.
 */
export const compositeScopeDiagnostics = (model: NormalizedPlugin, names: readonly string[]): readonly Diagnostic[] => {
  const hosts = sortedCompositeHosts(names);
  if (hosts.length < 2) return Object.freeze([]);
  const diagnostics: Diagnostic[] = [];
  // The portable view carries its own skills/ copy, so only the hosts sharing
  // the root's skills/ directory must agree.
  const sharedSkillHosts = hosts.filter((host) => compositeHostRoot(hosts, host) === '');
  const partial = (targets: readonly string[]): readonly string[] | undefined => {
    const selected = sharedSkillHosts.filter((host) => targets.includes(host));
    return selected.length === 0 || selected.length === sharedSkillHosts.length ? undefined : selected;
  };
  for (const skill of model.skills) {
    const selected = partial(skill.targets);
    if (selected === undefined) continue;
    diagnostics.push({
      code: 'AB4104',
      message: scopeMessage('Skill', skill.name, selected, sharedSkillHosts, 'every host discovers the shared skills/ directory conventionally, so a skill cannot be hidden from some of them.'),
      severity: 'error',
      sourcePath: skill.source,
    });
  }
  if (hosts.includes('claude') && hosts.includes('cursor')) {
    for (const command of model.commands ?? []) {
      if (!command.targets.includes('cursor')) continue;
      diagnostics.push({
        code: 'AB4104',
        message: scopeMessage('Command', command.name, hosts.filter((host) => command.targets.includes(host)), hosts, 'commands/ carries Claude Code frontmatter in a root that projects Claude Code, and Cursor reads plain Markdown prompts from the same directory.'),
        severity: 'error',
        sourcePath: command.source,
      });
    }
  }
  return Object.freeze(diagnostics);
};

const identicalStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** AB4105: two projections wrote different bytes to one path; identical bytes merge, pooling their source inputs. */
const mergeEntries = (
  diagnostics: Diagnostic[],
  ...sides: readonly (readonly TargetArtifactEntry[])[]
): TargetArtifactEntry[] => {
  const merged = new Map<string, TargetArtifactEntry>();
  for (const entry of sides.flat()) {
    const existing = merged.get(entry.relativePath);
    if (existing === undefined) {
      merged.set(entry.relativePath, entry);
      continue;
    }
    const identical = entry.kind === 'write'
      ? existing.kind === 'write' && existing.content === entry.content
      : existing.kind === 'copy' && existing.source === entry.source;
    if (!identical) {
      diagnostics.push({
        code: 'AB4105',
        message: `Two host projections of this plugin root emitted different content for ${JSON.stringify(entry.relativePath)}.`,
        severity: 'error',
      });
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
 * A hook selecting several projected hosts is planned once per host side; the
 * wrapper bytes are identical (the Universal codec), so the compiled entry is
 * kept once with every host it serves recorded on it.
 */
const mergeHookEntries = (
  diagnostics: Diagnostic[],
  ...sides: readonly (readonly TargetHookEntry[])[]
): readonly TargetHookEntry[] => {
  const merged = new Map<string, TargetHookEntry>();
  for (const entry of sides.flat()) {
    const existing = merged.get(entry.relativePath);
    if (existing === undefined) {
      merged.set(entry.relativePath, entry);
      continue;
    }
    if (existing.virtualSource !== entry.virtualSource) {
      diagnostics.push({
        code: 'AB4105',
        message: `Two host projections of this plugin root compiled different wrappers to ${JSON.stringify(entry.relativePath)}.`,
        severity: 'error',
      });
      continue;
    }
    const hosts = [...new Set([...(existing.hosts ?? [existing.target]), ...(entry.hosts ?? [entry.target])])];
    merged.set(entry.relativePath, Object.freeze({ ...existing, hosts: Object.freeze(hosts) }));
  }
  return Object.freeze([...merged.values()]);
};

const cursorMcpPlanContext = Object.freeze({ codePrefix: 'composite.cursor', errorDiagnostic });

// Cursor's wrappers are indexed like any host's: the index keeps one entry
// per hook and host, and Cursor's dedicated `.cursor.mjs` wrapper is the
// canonical one for the cursor projection.
const cursorCompositeHookContract = createCursorHookContract({
  manifestPath: cursorCompositePaths.hooks,
  wrapperPath: (hook: NormalizedHook) => `hooks/${hook.name}.cursor.mjs`,
});

interface AgentsDocumentOptions {
  readonly bin: boolean;
  readonly cliBins: readonly string[];
  readonly commands: boolean;
  readonly hosts: readonly CompositeHost[];
  readonly lsp: boolean;
  readonly outputStyles: boolean;
  readonly rules: boolean;
  readonly settings: boolean;
  readonly workflows: boolean;
}

const hostLabel: Readonly<Record<CompositeHost, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  portable: 'Agent Plugins (portable)',
});

const agentsDocument = (model: NormalizedPlugin, options: AgentsDocumentOptions): string => {
  const description = model.metadata.description ?? model.metadata.name;
  const has = (host: CompositeHost): boolean => options.hosts.includes(host);
  const labels = options.hosts.map((host) => hostLabel[host]);
  const hookLine = [
    ...(has('claude') && has('codex')
      ? ['`hooks/hooks.json` (Claude Code) and `.codex-plugin/hooks.json` (Codex) share one host-detecting wrapper per hook']
      : has('claude') || has('codex')
      ? [`\`hooks/hooks.json\` with one wrapper per hook (${has('claude') ? 'Claude Code' : 'Codex'})`]
      : []),
    ...(has('cursor') ? ['`hooks/hooks-cursor.json` with per-hook Cursor wrappers (`<name>.cursor.mjs`)'] : []),
  ];
  return [
    `# ${model.metadata.name}`,
    '',
    description,
    '',
    `This directory is a multi-host agent plugin root (version ${model.metadata.version}) compiled by agent-bundle.`,
    `One root serves ${labels.join(', ')}: host-specific manifests live in their own directories and share the`,
    'same skills, scripts, MCP server bundles, and assets.',
    '',
    '## Install',
    '',
    `See \`INSTALL.md\` for exact ${labels.join(', ')} commands using this root's compiled names.`,
    ...(has('cursor') || has('portable')
      ? [`Cursor can also be installed with \`node ./install.mjs\` into \`~/.cursor/plugins/local/${model.metadata.name}\`.`]
      : []),
    '- **VS Code / GitHub Copilot**: install the repository as an agent plugin, or consume `skills/` directly.',
    '- **skills CLI**: `npx skills add <source> --skill <name>` reads the `skills/` directory.',
    '',
    '## Layout',
    '',
    ...(has('claude') ? ['- `.claude-plugin/` — Claude Code manifest and host documents.', '- `.mcp.json` — Claude Code MCP configuration (plugin-root convention).'] : []),
    ...(has('codex')
      ? [`- \`.codex-plugin/\` — Codex manifest and host documents${has('claude') ? ' (its hooks and MCP documents live here, beside Claude Code\'s conventional ones)' : ''}.`]
      : []),
    ...(has('cursor') ? ['- `.cursor-plugin/plugin.json` and root `mcp.json` — Cursor local-plugin manifest and MCP document.'] : []),
    ...(has('portable') ? ['- `plugin.json` and root `mcp.json` — Agent Plugins v1 manifest and MCP document.'] : []),
    ...(options.lsp
      ? ['- `.lsp.json` — Claude Code language-server configuration (plugin-root convention). Claude Code only.']
      : []),
    ...(options.settings
      ? ['- `settings.json` — Claude Code default configuration applied when the plugin is enabled (plugin-root convention). Claude Code only.']
      : []),
    ...(options.commands
      ? ['- `commands/` — Claude Code command prompts. Claude Code only.']
      : []),
    ...(options.bin
      ? ['- `bin/` — Claude Code executables added to the Bash tool PATH while the plugin is enabled. Claude Code only.']
      : []),
    ...options.cliBins.map((name) =>
      `- \`bin/${name}.mjs\` — the compiled routed CLI shared by every host; run it as \`node bin/${name}.mjs --help\` from this directory (skills and scripts reach it through the plugin root).`),
    ...(options.workflows ? ['- `workflows/` — Claude Code workflow scripts. Claude Code only.'] : []),
    ...(options.outputStyles ? ['- `output-styles/` — Claude Code output style definitions. Claude Code only.'] : []),
    ...(options.rules ? ['- `rules/` — Cursor rules (`.mdc`). Cursor only.'] : []),
    ...(hookLine.length === 0 ? [] : [`- \`hooks/\` — ${hookLine.join('; ')}.`]),
    '- `skills/` — agent skills (`SKILL.md` per skill), shared by every host.',
    '- `scripts/`, `mcp/`, `mcp-apps/`, `assets/` — compiled shared surfaces.',
    '',
    ...(options.lsp
      ? [
          '## Language servers',
          '',
          '`.lsp.json` wires Claude Code to a language server; it does not ship one. Per the Claude Code plugin',
          'reference: "You must install the language server binary separately. LSP plugins configure how Claude Code',
          "connects to a language server, but they don't include the server itself.\" The root only carries",
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

interface CursorSidePlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
}

/**
 * The Cursor projection of a composite root: the same shared `skills/`,
 * `scripts/`, and `mcp/` through `.cursor-plugin/plugin.json`, the root
 * `mcp.json`, the relocated Cursor-format hooks document, and Cursor rules.
 * Commands are omitted beside Claude Code (AB4104 refuses the overlap).
 */
const planCursorSide = (
  model: NormalizedPlugin,
  hosts: readonly CompositeHost[],
  root: HookPlanRootOptions,
  targetSourceInputs: readonly string[],
): CursorSidePlan => {
  const diagnostics: Diagnostic[] = [];
  const entries: TargetArtifactEntry[] = [];
  const isSelected = (targets: readonly string[]): boolean => targets.includes('cursor');
  const selectedRules = (model.rules ?? []).filter((rule) => isSelected(rule.targets));
  const selectedCommands = hosts.includes('claude') ? [] : (model.commands ?? []).filter((command) => isSelected(command.targets));

  const cursorMarketplace = planCursorMarketplace(model);
  diagnostics.push(...cursorMarketplace.diagnostics);
  if (cursorMarketplace.document !== undefined && cursorMarketplace.valid) {
    entries.push({
      content: `${stableJson(cursorMarketplace.document)}\n`,
      kind: 'write',
      relativePath: cursorCompositePaths.marketplace,
      sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
    });
  }

  const cursorServers: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  const mcpSourceInputs: string[] = [];
  for (const server of model.mcpServers) {
    if (!isSelected(server.targets)) continue;
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

  let hookEntries: readonly TargetHookEntry[] = Object.freeze([]);
  if (!isValidCursorPluginName(model.metadata.name)) {
    diagnostics.push(errorDiagnostic('composite.cursor.name', cursorPluginNameError(model.metadata.name)));
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), entries: Object.freeze(entries), hookEntries });
  }

  // Cursor's envelope is not the shared Claude/Codex format, so its hooks
  // lower separately over dedicated `hooks/<name>.cursor.mjs` wrappers; the
  // empty document remains as a schema-collision guard when nothing lowers.
  let cursorHooksDocument: Record<string, unknown> = emptyCursorHooksDocument;
  // Cursor never shares a wrapper: its side names the root's endpoint but serves Cursor alone.
  const cursorHooks = planHooks(model, 'cursor', cursorCompositeHookContract, 'cursor', {
    ...(root.artifactTarget === undefined ? {} : { artifactTarget: root.artifactTarget }),
    hosts: ['cursor'],
  });
  diagnostics.push(...cursorHooks.diagnostics);
  const emitCursorHooks = cursorHooks.document !== undefined;
  if (cursorHooks.document !== undefined) {
    const valid = cursorHooksValidator(cursorHooks.document);
    diagnostics.push(...schemaDiagnostics('cursor-hooks', valid, cursorHooksValidator.errors));
    if (valid) {
      cursorHooksDocument = cursorHooks.document;
      hookEntries = cursorHooks.hookEntries;
    }
  }
  const variables = cursorVariables(cursorMcp);
  const manifestMetadata = planCursorManifestMetadata(model, cursorMcpPlanContext);
  diagnostics.push(...manifestMetadata.diagnostics);
  const manifest = cursorManifest(model, {
    ...(selectedCommands.length === 0 ? {} : { commands: './commands/' }),
    ...(emitCursorHooks ? { hooks: `./${cursorCompositePaths.hooks}` } : {}),
    ...(cursorMcp !== undefined && cursorMcpValid ? { mcp: `./${cursorCompositePaths.mcp}` } : {}),
    ...(selectedRules.length === 0 ? {} : { rules: './rules/' }),
    ...(model.skills.some((skill) => isSelected(skill.targets)) ? { skills: './skills/' } : {}),
    ...(variables === undefined ? {} : { variables }),
  }, manifestMetadata.document);
  const manifestValid = cursorPluginValidator(manifest);
  diagnostics.push(...schemaDiagnostics('cursor-plugin', manifestValid, cursorPluginValidator.errors));
  if (!manifestValid) {
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), entries: Object.freeze(entries), hookEntries: Object.freeze([]) });
  }
  entries.push({
    content: `${stableJson(manifest)}\n`,
    kind: 'write',
    relativePath: cursorCompositePaths.plugin,
    sourceInputs: sourceInputs(
      model.metadata.provenance.sourcePath,
      ...targetSourceInputs,
      ...selectedRules.map((rule) => rule.source),
      ...selectedCommands.map((command) => command.source),
      model.metadata.logo?.source,
      ...manifestMetadata.sourceInputs,
    ),
  });
  const logoEntry = pluginLogoCopyEntry(model);
  if (logoEntry !== undefined) entries.push(logoEntry);
  if (cursorMcp !== undefined && cursorMcpValid) {
    entries.push({
      content: `${stableJson(cursorMcp)}\n`,
      kind: 'write',
      relativePath: cursorCompositePaths.mcp,
      sourceInputs: sourceInputs(...targetSourceInputs, ...mcpSourceInputs),
    });
  }
  if (emitCursorHooks) {
    entries.push({
      content: `${stableJson(cursorHooksDocument)}\n`,
      kind: 'write',
      relativePath: cursorCompositePaths.hooks,
      sourceInputs: sourceInputs(...targetSourceInputs, ...hookEntries.map((entry) => entry.hook.provenance.sourcePath)),
    });
  }
  entries.push(...ruleWriteEntries(model, isSelected));
  if (selectedCommands.length > 0) {
    entries.push(...commandWriteEntries(model, isSelected, (command) =>
      command.markdown === command.body ? command.markdown : command.body));
  }
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), entries: Object.freeze(entries), hookEntries });
};

/**
 * The portable projection of a composite root: the Agent Plugins pack under
 * `portable/`, with `portable/mcp/<server>.mjs` shims that run the shared
 * compiled servers. Every referenced path stays inside the view, so the pack
 * installs and validates as its own plugin root.
 */
const planPortableView = (model: NormalizedPlugin): TargetArtifactPlan => {
  const side = withoutInstallSurface(portableAdapter.plan(model));
  const entries: TargetArtifactEntry[] = side.entries.map((entry) => Object.freeze({
    ...entry,
    relativePath: `${portableViewDirectory}/${entry.relativePath}`,
  }));
  for (const server of model.mcpServers) {
    if (server.source === undefined || !server.targets.includes('portable')) continue;
    const outputName = localMcpOutputName(server);
    entries.push({
      content: `import '../../mcp/${outputName}';\n`,
      kind: 'write',
      relativePath: `${portableViewDirectory}/mcp/${outputName}`,
      sourceInputs: sourceInputs(server.provenance.sourcePath),
    });
  }
  return Object.freeze({ diagnostics: side.diagnostics, entries: Object.freeze(entries), hookEntries: Object.freeze([]) });
};

const planComposite = (model: NormalizedPlugin, hosts: readonly CompositeHost[]): TargetArtifactPlan => {
  const diagnostics: Diagnostic[] = [...compositeScopeDiagnostics(model, hosts)];
  if (diagnostics.length > 0) {
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), entries: Object.freeze([]), hookEntries: Object.freeze([]) });
  }
  const has = (host: CompositeHost): boolean => hosts.includes(host);
  const artifactTarget = compositeTargetName(hosts);
  // Claude Code and Codex share hook wrappers; Cursor and portable never do.
  const sharedWrapperHosts = hosts.filter((host) => host === 'claude' || host === 'codex');
  const root: HookPlanRootOptions = Object.freeze({
    artifactTarget,
    hostContractRevision: sharedWrapperHosts.map((host) => hostAdapters[host].metadata.observedVersion).join('+'),
    hosts: sharedWrapperHosts,
  });
  const targetSourceInputs = model.targets
    .filter((target) => hosts.includes(target.name as CompositeHost))
    .map((target) => target.provenance.sourcePath);

  const sides: TargetArtifactPlan[] = [];
  if (has('claude')) sides.push(planClaudeArtifacts(model, { composite: root, targetName: 'claude' }));
  if (has('codex')) {
    sides.push(planCodexArtifacts(model, {
      composite: root,
      ...(has('claude')
        ? { hooksRelativePath: codexCompositePaths.hooks, mcpRelativePath: codexCompositePaths.mcp, sharedCopyEntries: false }
        : {}),
      targetName: 'codex',
    }));
  }
  if (has('portable')) sides.push(planPortableView(model));
  const cursorSide = has('cursor') ? planCursorSide(model, hosts, root, targetSourceInputs) : undefined;
  for (const side of sides) diagnostics.push(...side.diagnostics);
  if (cursorSide !== undefined) diagnostics.push(...cursorSide.diagnostics);

  const entries = mergeEntries(diagnostics, ...sides.map((side) => side.entries), cursorSide?.entries ?? []);
  const hookEntries = mergeHookEntries(diagnostics, ...sides.map((side) => side.hookEntries ?? []), cursorSide?.hookEntries ?? []);

  entries.push({
    content: agentsDocument(model, {
      bin: entries.some((entry) => entry.relativePath.startsWith('bin/')),
      cliBins: (model.packageBuild?.bins ?? [])
        .filter((bin) => bin.generatedCli !== undefined)
        .map((bin) => bin.name),
      commands: entries.some((entry) => entry.relativePath.startsWith('commands/')),
      hosts,
      lsp: entries.some((entry) => entry.relativePath === claudeArtifactPaths.lsp),
      outputStyles: entries.some((entry) => entry.relativePath.startsWith('output-styles/')),
      rules: entries.some((entry) => entry.relativePath.startsWith('rules/')),
      settings: entries.some((entry) => entry.relativePath === claudeArtifactPaths.settings),
      workflows: entries.some((entry) => entry.relativePath.startsWith('workflows/')),
    }),
    kind: 'write',
    relativePath: 'AGENTS.md',
    sourceInputs: sourceInputs(model.metadata.provenance.sourcePath, ...targetSourceInputs),
  });

  return withInstallSurface(Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    entries: sortedEntries(entries),
    hookEntries,
  }), model, hosts as readonly BuiltInTarget[]);
};

/** The portable planner attaches its own install surface; the composite writes one for every host instead. */
const withoutInstallSurface = (plan: TargetArtifactPlan): TargetArtifactPlan => Object.freeze({
  ...plan,
  entries: plan.entries.filter((entry) => entry.relativePath !== 'INSTALL.md' && entry.relativePath !== 'install.mjs'),
});

const hostAdapters: Readonly<Record<CompositeHost, TargetAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  portable: portableAdapter,
});

const prefixedSchemas = <Schema extends Readonly<{ readonly name: string }>>(
  prefix: string,
  schemas: readonly Schema[],
): readonly Schema[] => schemas.map((schema) => Object.freeze({ ...schema, name: `${prefix}-${schema.name}` }));

const requireValidation = (host: CompositeHost): TargetArtifactValidationContract => {
  const validation = hostAdapters[host].artifactValidation;
  if (validation === undefined) throw new Error(`Composite plugin root requires the ${host} artifact validation contract.`);
  return validation;
};

/**
 * The document a host reads at one composite root, after relocation: Codex's
 * hooks and MCP documents move under `.codex-plugin/` beside Claude Code, and
 * Cursor's hooks document moves to `hooks/hooks-cursor.json` beside any host.
 */
export const compositeDocumentPath = (hosts: readonly string[], host: CompositeHost, path: string): string => {
  const selected = sortedCompositeHosts(hosts);
  if (selected.length < 2) return path;
  const hostRoot = compositeHostRoot(selected, host);
  if (hostRoot !== '') return `${hostRoot}/${path}`;
  if (host === 'codex' && selected.includes('claude')) {
    if (path === codexArtifactPaths.hooksManifest) return codexCompositePaths.hooks;
    if (path === codexArtifactPaths.mcp) return codexCompositePaths.mcp;
  }
  if (host === 'cursor' && path === cursorArtifactPaths.hooks) return cursorCompositePaths.hooks;
  return path;
};

/**
 * The hook contract one host follows inside a root: its own contract, with
 * the document path the composition relocated it to. Cursor's composite
 * contract also swaps to the dedicated `.cursor.mjs` wrappers.
 */
export const compositeHookContract = (hosts: readonly string[], host: string): TargetHookContract | undefined => {
  if (!isCompositeHost(host)) return undefined;
  const selected = sortedCompositeHosts(hosts);
  const contract = hostAdapters[host].hookContract;
  if (contract === undefined || selected.length < 2) return contract;
  if (host === 'cursor') return cursorCompositeHookContract;
  const manifestPath = compositeDocumentPath(selected, host, contract.manifestPath);
  return manifestPath === contract.manifestPath ? contract : Object.freeze({ ...contract, manifestPath });
};

/**
 * The MCP runtime contract one host follows inside a root: its own, with the
 * document path the composition relocated it to.
 */
export const compositeMcpRuntime = (hosts: readonly string[], host: string): TargetMcpRuntimeContract | undefined => {
  if (!isCompositeHost(host)) return undefined;
  const runtime = hostAdapters[host].mcpRuntime;
  if (runtime === undefined) return undefined;
  const manifestPath = compositeDocumentPath(hosts, host, runtime.manifestPath);
  return manifestPath === runtime.manifestPath ? runtime : Object.freeze({ ...runtime, manifestPath });
};

const compositeValidation = (hosts: readonly CompositeHost[]): TargetArtifactValidationContract => deepFreeze({
  documents: hosts.flatMap((host): TargetArtifactValidationContract['documents'] => {
    const validation = requireValidation(host);
    // The Cursor manifest is skipped (not failed) when the plugin name is not
    // Cursor-safe, so its documents are optional at a composite root.
    return validation.documents.map((document) => Object.freeze({
      ...document,
      path: compositeDocumentPath(hosts, host, document.path),
      required: host === 'cursor' ? false : document.required,
      schema: `${host}-${document.schema}`,
    }));
  }),
  schemas: hosts.flatMap((host) => {
    const validation = requireValidation(host);
    if (host === 'codex' && hosts.includes('claude')) {
      // The Codex manifest points at the relocated MCP document, so its
      // validator widens the pinned pointer to that relocation.
      return [
        ...prefixedSchemas(host, validation.schemas.filter((schema) => schema.name !== 'plugin')),
        Object.freeze({ name: 'codex-plugin', validate: codexPluginDocumentValidator(codexCompositePaths.mcp) }),
      ];
    }
    if (host === 'cursor') {
      return [
        Object.freeze({ name: 'cursor-hooks', validate: validateJsonSchemaDocument(cursorHooksValidator) }),
        Object.freeze({ name: 'cursor-marketplace', validate: validateJsonSchemaDocument(cursorMarketplaceValidator) }),
        Object.freeze({ name: 'cursor-mcp', validate: validateJsonSchemaDocument(cursorMcpValidator) }),
        Object.freeze({ name: 'cursor-plugin', validate: validateJsonSchemaDocument(cursorPluginValidator) }),
      ];
    }
    return prefixedSchemas(host, validation.schemas);
  }),
});

const compositeMetadata = (hosts: readonly CompositeHost[]): TargetAdapterMetadata => Object.freeze({
  adapterRevision: '2.0.0',
  observedVersion: hosts.map((host) => hostAdapters[host].metadata.observedVersion).join('+'),
  schemas: Object.freeze(hosts.flatMap((host) => prefixedSchemas(host, hostAdapters[host].metadata.schemas))),
});

const compositeLayout = (hosts: readonly CompositeHost[]): TargetArtifactLayout => {
  const has = (host: CompositeHost): boolean => hosts.includes(host);
  return Object.freeze({
    assets: standardArtifactLayout.assets,
    ...(has('claude') ? { bin: 'bin' } : {}),
    cliBin: standardArtifactLayout.cliBin,
    ...(has('claude') || has('cursor')
      ? { commands: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'commands' }) }
      : {}),
    hookWrappers: standardArtifactLayout.hookWrappers,
    mcpApps: standardArtifactLayout.mcpApps,
    mcpEntries: standardArtifactLayout.mcpEntries,
    ...(has('claude') ? { outputStyles: Object.freeze({ allowedSuffixes: Object.freeze(['.md']), directory: 'output-styles' }) } : {}),
    rootDocuments: Object.freeze(['AGENTS.md', ...(standardArtifactLayout.rootDocuments ?? [])]),
    ...(has('cursor') ? { rules: Object.freeze({ allowedSuffixes: Object.freeze(['.mdc']), directory: 'rules' }) } : {}),
    scripts: standardArtifactLayout.scripts,
    skills: standardArtifactLayout.skills,
    ...(has('claude') ? { workflows: 'workflows' } : {}),
  });
};

/** Capability rows of the composite are the union of its hosts': the root emits a surface when any projection does. */
const compositeCapabilities = (hosts: readonly CompositeHost[]): Readonly<Record<string, CapabilityState>> => {
  const names = [...new Set(hosts.flatMap((host) => Object.keys(hostAdapters[host].capabilities)))].sort((left, right) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(names.map((capability) => [
    capability,
    hosts
      .map((host) => hostAdapters[host].capabilities[capability])
      .filter((state): state is CapabilityState => state !== undefined)
      .reduce((left, right) => unionCapabilityStates(left, right)),
  ])));
};

const composites = new Map<string, TargetAdapter>();

/**
 * The adapter that plans and validates a root projecting `names` (two or more
 * hosts). Memoized per host set; a single host is its own adapter.
 */
export const createCompositeAdapter = (names: readonly string[]): TargetAdapter => {
  const hosts = sortedCompositeHosts(names);
  const unknown = [...new Set(names)].filter((name) => !isCompositeHost(name));
  if (unknown.length > 0) {
    throw new Error(
      `A plugin root composed of several targets projects built-in hosts only (${compositeHostNames.join(', ')}); `
      + `${JSON.stringify(unknown)} must be built one target per --output.`,
    );
  }
  if (hosts.length < 2) {
    throw new Error(`A composite plugin root needs at least two host projections; got ${JSON.stringify(names)}.`);
  }
  const key = compositeTargetName(hosts);
  const cached = composites.get(key);
  if (cached !== undefined) return cached;
  const primary = hosts[0]!;
  const noticeDeliveries = hosts.flatMap((host) => hostAdapters[host].noticeDelivery === undefined ? [] : [hostAdapters[host].noticeDelivery!]);
  const adapter: TargetAdapter = Object.freeze({
    artifactValidation: compositeValidation(hosts),
    artifactLayout: compositeLayout(hosts),
    capabilities: compositeCapabilities(hosts),
    ...(compositeHookContract(hosts, primary) === undefined ? {} : { hookContract: compositeHookContract(hosts, primary)! }),
    // Each side plans from its own config extension, so host-scoped
    // declarations under those keys (for example `claude.lspServers`) are
    // eligible for emission at this root.
    lowersConfigExtensions: Object.freeze([...hosts]),
    metadata: compositeMetadata(hosts),
    ...(hostAdapters[primary].mcpRuntime === undefined ? {} : { mcpRuntime: hostAdapters[primary].mcpRuntime! }),
    name: key,
    // The generated MCP entry serves every projected host, so it may only
    // wire the cross-request routes all of them advertise.
    ...(noticeDeliveries.length === 0
      ? {}
      : { noticeDelivery: noticeDeliveries.reduce((left, right) => intersectNoticeDeliveryAdvertisements(left, right)) }),
    ...(hosts.includes('claude')
      ? {
          binSource: (config: Readonly<AgentBundleConfig>) => config.claude?.bin,
          outputStylesSource: (config: Readonly<AgentBundleConfig>) => config.claude?.outputStyles,
          workflowsSource: (config: Readonly<AgentBundleConfig>) => config.claude?.workflows,
        }
      : {}),
    plan: (model: NormalizedPlugin) => planComposite(model, hosts),
  });
  composites.set(key, adapter);
  return adapter;
};
