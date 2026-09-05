import { expect, it } from '@rstest/core';

import { AGENT_NOTICE_DELIVERY_ROUTES, resolveNoticeDisclosure, selectNoticeDeliveryRoutes } from '@agent-bundle/runtime/notices';
import type { AgentNoticeDeliveryAdvertisement, AgentNoticeDeliveryRoute } from '@agent-bundle/runtime/notices';

import {
  capabilityEvidence,
  capabilityIsSupported,
  intersectNoticeDeliveryAdvertisements,
  noticeDeliveryAdvertisementFrom,
  supportedCapability,
  unavailableCapability,
  webSurfaceCapability,
} from '../src/adapters/capability-state.ts';
import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.260.json' with { type: 'json' };
import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import cursorCapabilityTable from '../src/adapters/capabilities/cursor-2026-08-28.json' with { type: 'json' };
import portableCapabilityTable from '../src/adapters/capabilities/portable-1.0.0.json' with { type: 'json' };
import cursorHooksSchema from '../src/adapters/schemas/cursor/hooks.schema.json' with { type: 'json' };
import { cursorContractCapabilityRows } from '../src/adapters/cursor.ts';
import { NOTICE_DELIVERY_ROUTES } from '../src/adapters/notice-delivery.ts';
import type { NoticeDeliveryAdvertisement, NoticeDeliveryRoute } from '../src/adapters/notice-delivery.ts';
import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { CapabilityStateError, isCapabilityState } from '../src/core/capabilities.ts';
import type { CapabilityEvidence, CapabilityState } from '../src/core/capabilities.ts';

const evidence = (target: string): CapabilityEvidence => Object.freeze({
  observedVersion: `${target}-version`,
  target,
});
it('records an honest four-state commands row on every adapter', () => {
  const registry = createDefaultRegistry();
  for (const target of ['cursor', 'claude'] as const) {
    expect(registry.get(target).capabilities.commands).toMatchObject({
      evidence: { target },
      state: 'supported',
    });
  }
  expect(registry.get('codex').capabilities.commands).toEqual({
    reason: 'The pinned Codex plugin contract (0.147.0) defines no commands component.',
    state: 'unavailable',
  });
  expect(registry.get('portable').capabilities.commands).toEqual({
    reason: 'The portable Agent Plugin contract (1.0.0) defines only skills and MCP components; it has no commands surface.',
    state: 'unavailable',
  });
});

it('records an honest four-state rules row on every adapter', () => {
  const registry = createDefaultRegistry();
  expect(registry.get('cursor').capabilities.rules).toMatchObject({
    evidence: { observedVersion: '2026-08-28', target: 'cursor' },
    state: 'supported',
  });
  expect(registry.get('claude').capabilities.rules).toEqual({
    reason: 'The pinned Claude Code plugin contract (2.1.260) defines no rules component; project guidance ships through CLAUDE.md memory, not a rules directory.',
    state: 'unavailable',
  });
  expect(registry.get('codex').capabilities.rules).toEqual({
    reason: 'The pinned Codex plugin contract (0.147.0) defines no rules component; Codex guidance remains outside the plugin component surface.',
    state: 'unavailable',
  });
  expect(registry.get('portable').capabilities.rules).toEqual({
    reason: 'The portable Agent Plugin contract (1.0.0) defines only skills and MCP components; it has no rules surface.',
    state: 'unavailable',
  });
});

const codexParityCapabilityRows = {
  interface: {
    assets: 'interfaceAssets',
    brandColor: 'interfaceBrandColor',
    categoryCapabilities: 'interfaceCategoryCapabilities',
    descriptions: 'interfaceDescriptions',
    identity: 'interfaceIdentity',
    starterPrompts: 'interfaceStarterPrompts',
    urls: 'interfaceUrls',
  },
  apps: {
    registeredMcpMappings: 'registeredMcpApps',
  },
  mcpServerPolicy: {
    approvalModes: 'pluginMcpPolicyApprovalModes',
    enabled: 'pluginMcpPolicyEnabled',
    tools: 'pluginMcpPolicyTools',
  },
  hookEnvironment: {
    claudePluginData: 'claudePluginDataEnvironment',
    claudePluginRoot: 'claudePluginRootEnvironment',
    pluginData: 'pluginDataEnvironment',
    pluginRoot: 'pluginRootEnvironment',
  },
} as const;

it('records dated Codex interface, apps, policy, and hook-environment capability rows', () => {
  const registry = createDefaultRegistry();
  const codex = registry.get('codex');
  const expectedStates = {
    apps: { registeredMcpMappings: 'supported' },
    hookEnvironment: {
      claudePluginData: 'supported',
      claudePluginRoot: 'supported',
      pluginData: 'supported',
      pluginRoot: 'supported',
    },
    interface: {
      assets: 'supported',
      brandColor: 'supported',
      categoryCapabilities: 'supported',
      descriptions: 'supported',
      identity: 'supported',
      starterPrompts: 'supported',
      urls: 'supported',
    },
    mcpServerPolicy: {
      approvalModes: 'unavailable',
      enabled: 'unavailable',
      tools: 'unavailable',
    },
  } as const;

  for (const [blockName, rows] of Object.entries(codexParityCapabilityRows)) {
    const tableBlock = codexCapabilityTable.plugin[
      blockName as keyof typeof codexParityCapabilityRows
    ] as Readonly<Record<string, {
      readonly evidence: readonly string[];
      readonly reason?: string;
      readonly state: string;
    }>>;
    expect(Object.keys(tableBlock).sort()).toEqual(Object.keys(rows).sort());
    for (const [rowName, capability] of Object.entries(rows)) {
      const row = tableBlock[rowName]!;
      const expectedState = expectedStates[
        blockName as keyof typeof expectedStates
      ][rowName as never];
      expect(row.state).toBe(expectedState);
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(row.evidence.every((line) => line.startsWith('retrieved 2026-09-02:'))).toBe(true);
      expect(codex.capabilities[capability]).toMatchObject({
        ...(row.state === 'unavailable' ? { reason: row.reason } : {
          evidence: { observedVersion: '0.147.0', target: 'codex' },
        }),
        state: expectedState,
      });
      expect(registry.supports('codex', capability)).toBe(expectedState === 'supported');
    }
  }

  expect(codexCapabilityTable.tokens).toEqual({
    pluginData: false,
    pluginRoot: 'relative-with-plugin-root-cwd',
    workspaceRoot: false,
  });
});

it('reports Claude LSP support and honest unavailable coverage on other hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.lsp).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('codex').capabilities.lsp).toMatchObject({
    reason: expect.stringContaining('no LSP server surface'),
    state: 'unavailable',
  });
  expect(registry.supports('claude', 'lsp')).toBe(true);
  expect(registry.supports('codex', 'lsp')).toBe(false);
});

it('publishes a dated four-state lsp row on every adapter so no host is judged by silence (#100)', () => {
  const registry = createDefaultRegistry();
  expect(registry.get('cursor').capabilities.lsp).toEqual({
    reason: cursorCapabilityTable.plugin.lsp.reason,
    state: 'unavailable',
  });
  expect(cursorCapabilityTable.plugin.lsp.evidence[0]).toMatch(/^2026-09-03: .*plugin\.schema\.json/u);
  expect(registry.get('portable').capabilities.lsp).toEqual({
    reason: 'The portable Agent Plugin contract (1.0.0) defines only skills and MCP components; it has no LSP server surface.',
    state: 'unavailable',
  });
  expect(registry.get('codex').capabilities.lsp).toEqual({
    reason: codexCapabilityTable.plugin.components.lsp.reason,
    state: 'unavailable',
  });
});

it('records dated unavailable native-diagnostics and native-extension rows on every host (#100)', () => {
  const registry = createDefaultRegistry();
  const tables = {
    claude: claudeCapabilityTable.plugin,
    codex: codexCapabilityTable.plugin.components,
    cursor: cursorCapabilityTable.plugin,
  } as const;
  for (const capability of ['nativeDiagnostics', 'nativeExtension'] as const) {
    for (const [target, table] of Object.entries(tables)) {
      const row = table[capability];
      expect(row.state).toBe('unavailable');
      expect(row.evidence.length).toBeGreaterThan(0);
      for (const entry of row.evidence) expect(entry).toMatch(/^2026-09-03: /u);
      expect(registry.get(target).capabilities[capability]).toEqual({ reason: row.reason, state: 'unavailable' });
      expect(registry.supports(target, capability)).toBe(false);
    }
    expect(registry.get('portable').capabilities[capability]).toMatchObject({
      reason: expect.stringContaining('Agent Plugin contract (1.0.0)'),
      state: 'unavailable',
    });
  }
  // Claude's row points at the LSP `diagnostics` option rather than inventing a component.
  expect(claudeCapabilityTable.plugin.nativeDiagnostics.reason).toContain('`lsp` kind');
  expect(claudeCapabilityTable.plugin.lsp.optionalFields).toContain('diagnostics');
});

it('publishes dated component feature rows per kind and host (#100 feature sets)', () => {
  const registry = createDefaultRegistry();
  const claude = registry.get('claude').capabilities;
  const codex = registry.get('codex').capabilities;
  const cursor = registry.get('cursor').capabilities;
  const portable = registry.get('portable').capabilities;

  // Commands: Claude documents the five frontmatter fields; Cursor's commands
  // surface is frontmatter-free, so every field row is unavailable there.
  const commandFields = ['allowedTools', 'argumentHint', 'description', 'disableModelInvocation', 'model'];
  expect(Object.keys(claudeCapabilityTable.plugin.commandFrontmatter.fields)).toEqual(commandFields);
  expect(cursorCapabilityTable.plugin.commandFrontmatter.fields).toEqual(commandFields);
  for (const field of commandFields) {
    expect(claude[`commands.${field}`]).toMatchObject({ evidence: { target: 'claude' }, state: 'supported' });
    expect(cursor[`commands.${field}`]).toEqual({ reason: cursorCapabilityTable.plugin.commandFrontmatter.reason, state: 'unavailable' });
    expect(codex[`commands.${field}`]).toBeUndefined();
    expect(portable[`commands.${field}`]).toBeUndefined();
  }
  expect(cursorCapabilityTable.plugin.commandFrontmatter.evidence.some((entry) => entry.startsWith('2026-09-03: '))).toBe(true);

  // Rules: only Cursor publishes a rules surface, with the three documented .mdc fields.
  for (const field of ['alwaysApply', 'description', 'globs']) {
    expect(cursor[`rules.${field}`]).toMatchObject({ evidence: { target: 'cursor' }, state: 'supported' });
    expect(claude[`rules.${field}`]).toBeUndefined();
  }
  expect(cursorCapabilityTable.plugin.ruleFrontmatter.evidence[0]).toMatch(/^retrieved 2026-09-03: https:\/\/cursor\.com\/docs\/context\/rules/u);

  // Hooks: every hook host pins timeout and tool matchers in its hooks schema.
  for (const capabilities of [claude, codex, cursor]) {
    expect(capabilities['hooks.timeout']).toMatchObject({ state: 'supported' });
    expect(capabilities['hooks.toolMatchers']).toMatchObject({ state: 'supported' });
  }
  expect(portable['hooks.timeout']).toBeUndefined();

  // Skills follow the Skill IR: typed host frontmatter on the three hosts, Markdown tokens on Claude only.
  expect(claude['skills.hostFrontmatter']).toMatchObject({ state: 'supported' });
  expect(codex['skills.hostFrontmatter']).toMatchObject({ state: 'supported' });
  expect(cursor['skills.hostFrontmatter']).toMatchObject({ state: 'supported' });
  expect(portable['skills.hostFrontmatter']).toMatchObject({ reason: expect.stringContaining('Agent Skills'), state: 'unavailable' });
  expect(claude['skills.markdownTokens']).toMatchObject({ state: 'supported' });
  for (const capabilities of [codex, cursor, portable]) {
    expect(capabilities['skills.markdownTokens']).toMatchObject({ reason: expect.stringContaining('AB3008'), state: 'unavailable' });
  }
});

it('reports Claude bin support without inventing coverage on other native hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.bin).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.bin).toBeUndefined();
  }
  expect(registry.supports('claude', 'bin')).toBe(true);
});

it.each(['outputStyles', 'workflows'] as const)('reports Claude %s support and honest unavailable coverage on other hosts', (capability) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
  }
  expect(registry.supports('claude', capability)).toBe(true);
});

it('reports Claude plugin settings support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.settings).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  // Codex and Cursor declare no settings row at all, so an absent capability
  // stays an honest "not declared" rather than an inferred support claim.
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.settings).toBeUndefined();
    expect(registry.supports(target, 'settings')).toBe(false);
  }
  expect(registry.supports('claude', 'settings')).toBe(true);
});

const claudeAgentCapabilityRows = {
  background: 'agents.background',
  color: 'agents.color',
  component: 'agents',
  description: 'agents.description',
  disallowedTools: 'agents.disallowedTools',
  effort: 'agents.effort',
  experimentalCacheTtl: 'agents.experimentalCacheTtl',
  hooks: 'agents.hooks',
  initialPrompt: 'agents.initialPrompt',
  isolationWorktree: 'agents.isolationWorktree',
  maxTurns: 'agents.maxTurns',
  mcpServers: 'agents.mcpServers',
  memory: 'agents.memory',
  model: 'agents.model',
  name: 'agents.name',
  permissionMode: 'agents.permissionMode',
  skills: 'agents.skills',
  tools: 'agents.tools',
} as const;

it('records dated unavailable Claude agent rows', () => {
  const registry = createDefaultRegistry();
  const agents = (
    claudeCapabilityTable.plugin as unknown as {
      readonly agents?: Readonly<Record<
        keyof typeof claudeAgentCapabilityRows,
        {
          readonly evidence: readonly string[];
          readonly reason: string;
          readonly state: string;
        }
      >>;
    }
  ).agents;

  expect(agents).toBeDefined();
  if (agents === undefined) return;
  expect(Object.keys(agents).sort()).toEqual(Object.keys(claudeAgentCapabilityRows).sort());

  for (const [rowName, capability] of Object.entries(claudeAgentCapabilityRows)) {
    const row = agents[rowName as keyof typeof claudeAgentCapabilityRows];
    expect(row).toMatchObject({
      reason: expect.stringMatching(/#100 stage-2 G5|#100 stage 2 G5/u),
      state: 'unavailable',
    });
    expect(row.reason).toContain('PR #220');
    expect(row.reason).toContain('#107 revision 3');
    expect(row.evidence.length).toBeGreaterThan(0);
    // Dated evidence: the 2026-09-02 web retrieval, the maintainer-uploaded
    // 2026-09-03 references (sub-agents-3.md, #478), or same-day repository facts.
    expect(row.evidence.every((line) => /^(?:retrieved 2026-09-02|uploaded 2026-09-03|2026-09-03):/u.test(line))).toBe(true);
    expect(registry.get('claude').capabilities[capability]).toEqual({
      reason: row.reason,
      state: 'unavailable',
    });
    expect(registry.supports('claude', capability)).toBe(false);
  }
});

it('tracks the uploaded sub-agents contract in the Claude agent rows without enabling the component (#478)', () => {
  const agents = claudeCapabilityTable.plugin.agents;
  const uploaded = (line: string): boolean => line.startsWith('uploaded 2026-09-03:') && line.includes('sub-agents-3.md');

  // New frontmatter fields: still unavailable behind the G5 gate, cited to the uploaded reference.
  expect(agents.color.evidence.some((line) => uploaded(line) && /red, blue, green, yellow, purple, orange, pink, or cyan/u.test(line))).toBe(true);
  expect(agents.initialPrompt.evidence.some((line) => uploaded(line) && line.includes('--agent'))).toBe(true);
  expect(agents.experimentalCacheTtl.evidence.some((line) => uploaded(line) && line.includes('5m or 1h') && line.includes('2.1.248'))).toBe(true);
  expect(agents.experimentalCacheTtl.reason).toContain('experimental.cacheTtl');

  // Fields the host ignores for plugin subagents: the reason names the ignore, not merely a deferral.
  for (const field of ['hooks', 'mcpServers', 'permissionMode'] as const) {
    expect(agents[field].reason).toContain('Ignored for plugin subagents');
    expect(agents[field].reason).toContain('diagnostic');
    expect(agents[field].evidence.some((line) => uploaded(line) && line.includes(field))).toBe(true);
  }

  // Name constraints and the anchored plugin-scoped agent_type matcher.
  expect(agents.name.evidence.some((line) => uploaded(line) && line.includes('agent_type') && line.includes('colon'))).toBe(true);
  const matcher = claudeCapabilityTable.hooks.agentTypeMatcher;
  expect(matcher.field).toBe('agent_type');
  expect(matcher.pluginScopedTemplate).toBe('^<plugin-name>:<agent-name>$');
  expect(matcher.evidence.some((line) => line.startsWith('uploaded 2026-09-03:') && line.includes('hooks-2.md') && line.includes('^my-plugin:reviewer$'))).toBe(true);
  expect(matcher.evidence.some((line) => uploaded(line) && line.includes('^my-plugin:db-agent$'))).toBe(true);
  // The tool-selector map the hook contract lowers stays untouched by the note.
  expect(Object.keys(claudeCapabilityTable.hooks.matchers).sort()).toEqual(['file.read', 'file.write', 'mcp', 'shell']);
});

it('records the dated G5-gated Cursor agents component row beside the documented Cursor agents format', () => {
  const registry = createDefaultRegistry();
  const row = cursorCapabilityTable.plugin.agents.component;

  expect(row.state).toBe('unavailable');
  expect(row.reason).toContain('PR #220');
  expect(row.reason).toContain('#107 revision 3');
  expect(row.evidence.every((line) => line.startsWith('retrieved 2026-09-02:'))).toBe(true);
  expect(row.evidence.some((line) => line.includes('https://cursor.com/docs/reference/plugins') && line.includes('agents/'))).toBe(true);
  expect(registry.get('cursor').capabilities.agents).toEqual({ reason: row.reason, state: 'unavailable' });
  expect(registry.supports('cursor', 'agents')).toBe(false);
});

it('reports Claude userConfig support and honest unavailable coverage on other hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.userConfig).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.userConfig).toBeUndefined();
  }
  expect(registry.supports('claude', 'userConfig')).toBe(true);
});

it('reports Claude channels support and honest unavailable coverage on other hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.channels).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.channels).toBeUndefined();
  }
  expect(registry.supports('claude', 'channels')).toBe(true);
});

it.each(['themes', 'monitors'] as const)('reports Claude %s support without inventing coverage on other hosts', (capability) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
  }
  expect(registry.supports('claude', capability)).toBe(true);
});

it('reports Claude dependency support and honest unavailable coverage on other hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.dependencies).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.dependencies).toBeUndefined();
    expect(registry.supports(target, 'dependencies')).toBe(false);
  }
  expect(registry.supports('claude', 'dependencies')).toBe(true);
});

const claudeDistributionPolicyCapabilities = [
  'skillsDirectoryPlugins',
  'skillsDirectoryProjectTrust',
  'skillsDirectoryMcpApproval',
  'skillsDirectoryLspTrust',
  'skillsDirectoryMonitors',
  'pluginInstallScopes',
  'pluginReload',
  'pluginTrustGates',
  'syncedPlugins',
  'managedPluginScope',
  'managedStrictKnownMarketplaces',
  'managedBlockedMarketplaces',
  'managedDisableSideloadFlags',
  'managedDisableCommandPluginSources',
  'managedAllowManagedHooksOnly',
  'managedPluginSuggestions',
  'pluginCliLifecycle',
  'marketplaceCliLifecycle',
] as const;

it('reports Claude plugin install scopes from the scoped installer implementation', () => {
  const row = claudeCapabilityTable.plugin.distributionPolicy.pluginInstallScopes;
  const capability = createDefaultRegistry().get('claude').capabilities.pluginInstallScopes;

  expect(row).toMatchObject({
    evidence: expect.arrayContaining([
      expect.stringContaining('src/install/install.ts'),
    ]),
    state: 'supported',
  });
  expect(capability).toMatchObject({
    evidence: { observedVersion: '2.1.260', target: 'claude' },
    state: 'supported',
  });
});

it('records dated unavailable Claude distribution and policy capability rows', () => {
  const registry = createDefaultRegistry();
  const distributionPolicy = (
    claudeCapabilityTable.plugin as unknown as {
      readonly distributionPolicy?: Readonly<Record<
        (typeof claudeDistributionPolicyCapabilities)[number],
        {
          readonly commands?: readonly string[];
          readonly evidence: readonly string[];
          readonly reason: string;
          readonly state: string;
        }
      >>;
    }
  ).distributionPolicy;

  expect(distributionPolicy).toBeDefined();
  if (distributionPolicy === undefined) return;
  expect(Object.keys(distributionPolicy).sort()).toEqual([...claudeDistributionPolicyCapabilities].sort());
  for (const capability of claudeDistributionPolicyCapabilities) {
    const row = distributionPolicy[capability];
    expect(row.state).toBe(capability === 'pluginInstallScopes' ? 'supported' : 'unavailable');
    if (capability !== 'pluginInstallScopes') expect(row.reason.length).toBeGreaterThan(0);
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(row.evidence.every((line) => line.includes('retrieved 2026-09-02'))).toBe(true);
    if (capability === 'pluginInstallScopes') {
      expect(registry.get('claude').capabilities[capability]).toMatchObject({
        evidence: { observedVersion: '2.1.260', target: 'claude' },
        state: 'supported',
      });
    } else {
      expect(registry.get('claude').capabilities[capability]).toEqual({
        reason: row.reason,
        state: 'unavailable',
      });
    }
  }
  expect(distributionPolicy.pluginCliLifecycle.commands).toEqual([
    'init',
    'new',
    'install',
    'uninstall',
    'prune',
    'enable',
    'disable',
    'update',
    'list',
    'details',
    'tag',
  ]);
  expect(distributionPolicy.marketplaceCliLifecycle.commands).toEqual([
    'add',
    'list',
    'remove',
    'update',
  ]);
});

const claudePackageLifecycleCapabilities = [
  'nodeDependencyInstall',
  'yarnPnpmInstallAlternative',
  'pluginCacheLifecycle',
  'pluginPathSubstitution',
  'pluginDataLifecycle',
] as const;

it('records dated Claude package, cache, and data lifecycle capability rows', () => {
  const registry = createDefaultRegistry();
  const packageLifecycle = (
    claudeCapabilityTable.plugin as unknown as {
      readonly packageLifecycle?: Readonly<Record<
        (typeof claudePackageLifecycleCapabilities)[number],
        {
          readonly evidence: readonly string[];
          readonly reason: string;
          readonly state: string;
        }
      >>;
    }
  ).packageLifecycle;

  expect(packageLifecycle).toBeDefined();
  if (packageLifecycle === undefined) return;
  expect(Object.keys(packageLifecycle).sort()).toEqual([...claudePackageLifecycleCapabilities].sort());
  for (const capability of claudePackageLifecycleCapabilities) {
    const row = packageLifecycle[capability];
    expect(row.state).toBe(capability === 'pluginPathSubstitution' ? 'degraded' : 'unavailable');
    expect(row.reason.length).toBeGreaterThan(0);
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(row.evidence.every((line) => line.includes('retrieved 2026-09-02'))).toBe(true);
    expect(registry.get('claude').capabilities[capability]).toMatchObject({
      reason: row.reason,
      state: row.state,
    });
  }
});

it('pins the documented Claude dependency precedence and substitution field table', () => {
  const lifecycle = claudeCapabilityTable.plugin.packageLifecycle;

  expect(lifecycle.nodeDependencyInstall).toMatchObject({
    commands: {
      'bun.lock': 'bun install --frozen-lockfile --ignore-scripts',
      'bun.lockb': 'bun install --frozen-lockfile --ignore-scripts',
      'npm-shrinkwrap.json': 'npm ci --ignore-scripts',
      'package-lock.json': 'npm ci --ignore-scripts',
    },
    lockfilePrecedence: ['bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'package-lock.json'],
    manifest: 'package.json',
    timeoutSeconds: 60,
  });
  expect(lifecycle.yarnPnpmInstallAlternative).toMatchObject({
    persistentDataToken: '${CLAUDE_PLUGIN_DATA}',
    skippedLockfiles: ['yarn.lock', 'pnpm-lock.yaml'],
  });
  expect(lifecycle.pluginPathSubstitution.fields).toEqual({
    hookCommands: ['command', 'args'],
    lsp: ['command', 'args', 'env', 'workspaceFolder'],
    mcpRemote: ['url', 'headers', 'headersHelper'],
    mcpStdio: ['command', 'args', 'env'],
    monitorCommands: ['command'],
    skillAndAgentContent: ['anywhere'],
  });
});

it.each(['marketplaceManifest', 'allowCrossMarketplaceDependenciesOn'] as const)('reports Claude %s support and honest unavailable coverage on other hosts', (capability) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  for (const target of ['codex', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
  }
  // Cursor publishes its own dated marketplace manifest row (#189); the
  // cross-marketplace dependency allowlist remains Claude-only.
  if (capability === 'marketplaceManifest') {
    expect(registry.get('cursor').capabilities[capability]).toMatchObject({
      evidence: { observedVersion: '2026-08-28', target: 'cursor' },
      state: 'supported',
    });
    expect(registry.supports('cursor', capability)).toBe(true);
  } else {
    expect(registry.get('cursor').capabilities[capability]).toBeUndefined();
    expect(registry.supports('cursor', capability)).toBe(false);
  }
  expect(registry.supports('claude', capability)).toBe(true);
});

it('pins the authored Claude marketplace source matrix and version gates', () => {
  expect(claudeCapabilityTable.plugin.marketplaceManifest.sourceMatrix).toEqual({
    archiveIntegrity: 'sha256-64-hex',
    authoredForms: ['relative', 'github', 'url', 'git-subdir', 'npm', 'archive', 'command'],
    generatedDefault: 'relative',
    gitPinFields: ['ref', 'sha'],
    shaOverridesRef: true,
    versionGates: {
      archive: '2.1.224',
      command: '2.1.229',
      pluginRootBareName: '2.1.239',
    },
  });
});

it('reports Claude manifestPaths support without inventing coverage on other hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.manifestPaths).toMatchObject({
    evidence: {
      observedVersion: '2.1.260',
      target: 'claude',
    },
    state: 'supported',
  });
  // Neither the pinned Cursor contract nor Agent Plugins 1.0.0 (#307) defines
  // custom manifest path rules.
  for (const target of ['cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.manifestPaths).toBeUndefined();
    expect(registry.supports(target, 'manifestPaths')).toBe(false);
  }
  expect(registry.supports('claude', 'manifestPaths')).toBe(true);
});

it('reports manifest metadata support on every native host', () => {
  const registry = createDefaultRegistry();

  for (const target of ['claude', 'codex', 'cursor'] as const) {
    expect(registry.get(target).capabilities.manifestMetadata).toMatchObject({
      evidence: { target },
      state: 'supported',
    });
    expect(registry.supports(target, 'manifestMetadata')).toBe(true);
  }
  // Agent Plugins 1.0.0 §5.4 defines manifest metadata for the portable manifest (#307).
  expect(registry.get('portable').capabilities.manifestMetadata).toMatchObject({
    evidence: { observedVersion: '1.0.0', target: 'portable' },
    state: 'supported',
  });
  expect(registry.supports('portable', 'manifestMetadata')).toBe(true);
  expect(cursorCapabilityTable.plugin.manifestMetadata).toMatchObject({
    authoredFields: ['author.name', 'author.email', 'homepage', 'repository', 'license', 'keywords', 'publisher', 'category', 'tags', 'minClientVersions'],
    schemaOnlyFields: ['displayName', 'publisher', 'category', 'tags', 'minClientVersions'],
    state: 'supported',
  });
});

const codexManifestPackageCapabilities = [
  'manifestMetadata',
  'manifestPaths',
  'optionalAssets',
  'submissionPolicy',
] as const;

it('records dated Codex manifest and package capability rows', () => {
  const registry = createDefaultRegistry();
  const manifestPackage = codexCapabilityTable.plugin.manifestPackage;

  expect(Object.keys(manifestPackage).sort()).toEqual([...codexManifestPackageCapabilities].sort());
  for (const capability of codexManifestPackageCapabilities) {
    const row = manifestPackage[capability];
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(row.evidence.every((line) => line.startsWith('retrieved 2026-09-02:'))).toBe(true);
    const state = registry.get('codex').capabilities[capability];
    expect(state?.state).toBe(row.state);
    if ('reason' in row) {
      expect(state).toMatchObject({ reason: row.reason });
    } else {
      expect(state).toMatchObject({ evidence: { target: 'codex' } });
    }
  }

  expect(manifestPackage.manifestMetadata.fields).toEqual([
    'author.name',
    'author.email',
    'author.url',
    'homepage',
    'repository',
    'license',
    'keywords',
  ]);
  expect(manifestPackage.manifestPaths).toMatchObject({
    admitted: {
      hooks: ['path', 'path-array', 'inline-object', 'inline-object-array'],
      mcpServers: ['path', 'inline-object'],
      skills: ['path'],
    },
    emitted: {
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
      skills: './skills/',
    },
    state: 'degraded',
  });
  expect(manifestPackage.optionalAssets.assets).toEqual([
    'interface.composerIcon',
    'interface.logo',
    'interface.logoDark',
    'interface.screenshots',
  ]);
  expect(manifestPackage.submissionPolicy.constraints).toEqual([
    'Apps Management write access',
    'verified developer or business identity',
    'listing and policy URLs',
    'production MCP review materials',
    'five positive and three negative test cases',
    'country or region availability',
    'release notes and policy attestations',
  ]);
});

const malformed = (value: unknown): CapabilityState => value as CapabilityState;

it('recognizes only the four contract states with their required fields', () => {
  expect(isCapabilityState(supportedCapability(evidence('cursor')))).toBe(true);
  expect(isCapabilityState({ state: 'degraded', reason: 'partial' })).toBe(true);
  expect(isCapabilityState({ state: 'degraded', reason: 'partial', evidence: evidence('cursor') })).toBe(true);
  expect(isCapabilityState(unavailableCapability('missing'))).toBe(true);
  expect(isCapabilityState({ state: 'prohibited', reason: 'policy' })).toBe(true);

  // A misspelled state, a state missing the fields it owns, and non-records are all rejected.
  expect(isCapabilityState({ state: 'suported' })).toBe(false);
  expect(isCapabilityState({ state: 'supported' })).toBe(false);
  expect(isCapabilityState({ state: 'supported', evidence: { target: 'cursor' } })).toBe(false);
  expect(isCapabilityState({ state: 'unavailable' })).toBe(false);
  expect(isCapabilityState({ state: 'degraded', reason: 7 })).toBe(false);
  expect(isCapabilityState(undefined)).toBe(false);
  expect(isCapabilityState(null)).toBe(false);
  expect(isCapabilityState('supported')).toBe(false);
});

it('raises a typed error for an unknown state instead of fabricating a truthy one', () => {
  const unknown = malformed({ state: 'suported' });

  // The bug this covers: the exhaustive default returned the capability object,
  // so an untyped adapter's typo read as truthy support.
  expect(() => capabilityIsSupported(unknown)).toThrow(CapabilityStateError);
  expect(() => capabilityIsSupported(unknown)).toThrow(/outside the degraded\/prohibited\/supported\/unavailable contract/u);

  const thrown = (() => {
    try {
      capabilityIsSupported(unknown);
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  expect(thrown).toBeInstanceOf(CapabilityStateError);
  if (!(thrown instanceof CapabilityStateError)) throw new Error('Expected a CapabilityStateError.');
  expect(thrown.code).toBe('ERR_UNKNOWN_CAPABILITY_STATE');
  expect(thrown.message).toContain('"suported"');
});

it('rejects a malformed capability declaration when the adapter registers', () => {
  const source = createDefaultRegistry().get('cursor');

  for (const broken of [{ state: 'suported' }, { state: 'supported' }, { state: 'unavailable' }, 'supported']) {
    expect(() => new TargetRegistry().register({
      ...source,
      capabilities: { ...source.capabilities, mcp: malformed(broken) },
    })).toThrow(CapabilityStateError);
  }
  expect(() => new TargetRegistry().register({
    ...source,
    capabilities: { ...source.capabilities, mcp: malformed({ state: 'suported' }) },
  })).toThrow(/capability "mcp" must declare one of degraded\/prohibited\/supported\/unavailable/u);

  expect(() => new TargetRegistry().register(source)).not.toThrow();
});

it('publishes the routed CLI bin capability with its bin layout on every built-in target (#387)', () => {
  const registry = createDefaultRegistry();
  for (const name of registry.names()) {
    const adapter = registry.get(name);
    expect(adapter.capabilities.cli?.state, name).toBe('supported');
    expect(registry.artifactLayout(name).cliBin, name).toEqual({ allowedSuffixes: ['.mjs'], directory: 'bin' });
  }

  // A supported `cli` row promises a place for the executable, so an adapter
  // without the layout — or with no artifact layout at all — cannot register;
  // one that publishes no row stays valid and simply hosts no bin.
  const cursor = registry.get('cursor');
  const { cliBin: _cliBin, ...layoutWithoutBin } = cursor.artifactLayout!;
  expect(() => new TargetRegistry().register({ ...cursor, artifactLayout: layoutWithoutBin }))
    .toThrow(/supported cli capability without a routed CLI bin layout/u);
  const { artifactLayout: _layout, ...cursorWithoutLayout } = cursor;
  expect(() => new TargetRegistry().register(cursorWithoutLayout))
    .toThrow(/supported cli capability without a routed CLI bin layout/u);
  const { cli: _cli, ...capabilitiesWithoutCli } = cursor.capabilities;
  expect(() => new TargetRegistry().register({
    ...cursor,
    artifactLayout: layoutWithoutBin,
    capabilities: capabilitiesWithoutCli,
  })).not.toThrow();

  // The compiler emits the routed CLI at exactly `bin/<name>.mjs`, so a
  // `cliBin` layout naming any other directory or omitting `.mjs` is rejected
  // instead of producing files artifact validation would reject.
  for (const cliBin of [
    { allowedSuffixes: ['.mjs'], directory: 'cli' },
    { allowedSuffixes: ['.js'], directory: 'bin' },
  ]) {
    expect(() => new TargetRegistry().register({
      ...cursor,
      artifactLayout: { ...layoutWithoutBin, cliBin },
    })).toThrow(/routed CLI bin layout must use directory "bin" and admit "\.mjs"/u);
  }
  expect(() => new TargetRegistry().register({
    ...cursor,
    artifactLayout: { ...layoutWithoutBin, cliBin: { allowedSuffixes: ['.js', '.mjs'], directory: 'bin' } },
  })).not.toThrow();

  // Emission follows the component judgment `inspect` reports
  // (`componentCapabilities ?? capabilities`), so an override that withdraws
  // `cli` hosts no bin (and needs no layout), while an override that grants it
  // needs the layout even if the top-level row is absent.
  const withdrawn = new TargetRegistry().register({
    ...cursor,
    artifactLayout: layoutWithoutBin,
    componentCapabilities: { ...cursor.componentCapabilities, cli: unavailableCapability('withdrawn for this host') },
  });
  expect(withdrawn.supports('cursor', 'cli')).toBe(true);
  expect(withdrawn.hostsComponent('cursor', 'cli')).toBe(false);
  expect(withdrawn.componentCapabilityState('cursor', 'cli')).toEqual({ reason: 'withdrawn for this host', state: 'unavailable' });
  expect(() => new TargetRegistry().register({
    ...cursor,
    artifactLayout: layoutWithoutBin,
    capabilities: capabilitiesWithoutCli,
    componentCapabilities: { cli: cursor.capabilities.cli! },
  })).toThrow(/supported cli capability without a routed CLI bin layout/u);
  expect(registry.hostsComponent('cursor', 'cli')).toBe(true);
  expect(registry.hostsComponent('unknown-target', 'cli')).toBe(false);
});

it('pins a supported web surface row on every host capability table (#564)', () => {
  const row = {
    reason: 'browser host inside the composite artifact; <plugin> web runs from the installed root on any host',
    state: 'supported',
  };
  expect(webSurfaceCapability).toBe('web');
  for (const table of [claudeCapabilityTable, codexCapabilityTable, cursorCapabilityTable, portableCapabilityTable]) {
    expect(table.web).toEqual(row);
    expect(table.plugin.web).toEqual(row);
  }
});

it('rejects a malformed inspection component capability when the adapter registers', () => {
  const source = createDefaultRegistry().get('cursor');

  expect(() => new TargetRegistry().register({
    ...source,
    componentCapabilities: { commands: malformed({ state: 'suported' }) },
  })).toThrow(/component capability "commands" must declare one of degraded\/prohibited\/supported\/unavailable/u);
});

it('surfaces built-in adapter metadata as immutable capability evidence', () => {
  const registry = createDefaultRegistry();
  const cursor = registry.get('cursor');

  expect(cursor.capabilities.mcp).toEqual({
    evidence: capabilityEvidence('cursor', cursor.metadata),
    state: 'supported',
  });
  if (cursor.capabilities.mcp?.state !== 'supported') throw new Error('Expected Cursor MCP support evidence.');
  expect(cursor.capabilities.mcp.evidence).toEqual({
    observedVersion: '2026-08-28',
    target: 'cursor',
  });
  expect(Object.isFrozen(cursor.capabilities.mcp.evidence)).toBe(true);
});

it('reports the evidence-backed G10 event family matrix without inferred support', () => {
  const registry = createDefaultRegistry();
  const sharedNativeHosts = [
    'event:agent/start',
    'event:agent/stop',
    'event:compact/before',
    'event:prompt/submit',
    'event:session/end',
    'event:session/start',
    'event:stop',
    'event:tool/after',
    'event:tool/before',
  ];

  for (const capability of [...sharedNativeHosts, 'event:tool/failure']) {
    expect(registry.get('cursor').capabilities[capability]).toMatchObject({
      evidence: { observedVersion: '2026-08-28', target: 'cursor' },
      state: 'supported',
    });
  }
  expect(registry.get('cursor').capabilities['event:workspace/open']).toMatchObject({
    evidence: { observedVersion: '2026-08-28', target: 'cursor' },
    state: 'supported',
  });
  expect(cursorCapabilityTable.hooks.eventRoutes['session/end'].availability).toEqual({
    cloud: {
      reason: expect.stringContaining('https://cursor.com/docs/hooks'),
      state: 'unavailable',
    },
    desktop: { state: 'supported' },
  });
  expect(registry.get('cursor').capabilities['event:compact/after']).toMatchObject({
    reason: expect.stringContaining('no postCompact'),
    state: 'unavailable',
  });
  for (const capability of [...sharedNativeHosts, 'event:compact/after', 'event:tool/failure']) {
    expect(registry.get('claude').capabilities[capability]).toMatchObject({
      evidence: { target: 'claude' },
      state: 'supported',
    });
  }
  for (const capability of [...sharedNativeHosts, 'event:compact/after']) {
    expect(registry.get('codex').capabilities[capability]).toMatchObject({
      evidence: { target: 'codex' },
      state: 'supported',
    });
  }
  expect(registry.get('codex').capabilities['event:tool/failure']).toMatchObject({
    reason: expect.stringContaining('no tool-failure'),
    state: 'unavailable',
  });
  for (const target of ['claude', 'codex'] as const) {
    for (const capability of sharedNativeHosts) {
      expect(registry.get(target).capabilities[capability]).toMatchObject({
        evidence: { target },
        state: 'supported',
      });
    }
    expect(registry.get(target).capabilities['event:workspace/open']).toMatchObject({
      reason: expect.stringContaining('pinned'),
      state: 'unavailable',
    });
  }
});

it('reports evidence-backed installation support only for real host targets', () => {
  const registry = createDefaultRegistry();

  for (const target of ['claude', 'codex', 'cursor'] as const) {
    expect(registry.get(target).capabilities.install).toMatchObject({
      evidence: { target },
      state: 'supported',
    });
    expect(registry.supports(target, 'install')).toBe(true);
  }
  expect(registry.get('portable').capabilities.install).toMatchObject({
    reason: expect.stringContaining('profile'),
    state: 'unavailable',
  });
  expect(registry.supports('portable', 'install')).toBe(false);
});

it('pins dated deferral rows for every explicitly deferred native callback from #258', async () => {
  const { readFile } = await import('node:fs/promises');
  const tables = {
    claude: JSON.parse(await readFile(new URL('../src/adapters/capabilities/claude-2.1.260.json', import.meta.url), 'utf8')) as Record<string, unknown>,
    codex: JSON.parse(await readFile(new URL('../src/adapters/capabilities/codex-0.147.0.json', import.meta.url), 'utf8')) as Record<string, unknown>,
    cursor: JSON.parse(await readFile(new URL('../src/adapters/capabilities/cursor-2026-08-28.json', import.meta.url), 'utf8')) as Record<string, unknown>,
  };
  const expected = {
    claude: [
      'ConfigChange-policy_settings', 'CwdChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult',
      'InstructionsLoaded', 'MessageDisplay', 'Notification', 'PostToolBatch',
      'Setup', 'UserPromptExpansion', 'WorktreeCreate', 'WorktreeRemove',
    ],
    codex: ['Interrupt'],
    cursor: [
      'afterAgentResponse', 'afterAgentThought', 'afterFileEdit', 'afterMCPExecution', 'afterShellExecution',
      'afterTabFileEdit', 'beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution', 'beforeTabFileRead',
    ],
  } as const;
  for (const [host, names] of Object.entries(expected)) {
    const deferred = tables[host as keyof typeof tables].deferredNativeEvents as Record<string, { reason: string; state: string }>;
    expect(Object.keys(deferred).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(deferred[name]!.state).toMatch(/^(unavailable|prohibited)$/u);
      expect(deferred[name]!.reason).toMatch(/2026-09-02/u);
    }
  }
});

it('advertises conversation lineage per host with dated 2026-09-03 evidence', async () => {
  const { readFile } = await import('node:fs/promises');
  const rows = ['depth', 'mcp-correlation', 'parent', 'root', 'subagent-events'];
  const files = {
    claude: 'claude-2.1.260.json',
    codex: 'codex-0.147.0.json',
    cursor: 'cursor-2026-08-28.json',
    portable: 'portable-1.0.0.json',
  };
  for (const [host, file] of Object.entries(files)) {
    const table = JSON.parse(await readFile(new URL(`../src/adapters/capabilities/${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
    const lineage = table.lineage as Record<string, { evidence?: readonly string[]; reason?: string; state: string }>;
    expect(Object.keys(lineage).filter((row) => row !== 'cloud').sort()).toEqual(rows);
    for (const row of rows) {
      const entry = lineage[row]!;
      expect(['supported', 'degraded', 'unavailable']).toContain(entry.state);
      const dated = entry.state === 'supported' ? entry.evidence?.join(' ') : entry.reason;
      expect(dated, `${host} lineage.${row}`).toMatch(/2026-09-03/u);
    }
    if (host === 'portable') {
      expect(Object.values(lineage).every((entry) => entry.state === 'unavailable')).toBe(true);
    } else {
      // Every hook-bearing host names its subagents; none names a parent on the child's own events.
      // Codex names the child's rollout instead, whose head records the parent and depth (#423).
      expect(lineage['subagent-events']!.state).toBe('supported');
      expect(lineage['parent']!.state).toBe(host === 'codex' ? 'supported' : 'degraded');
      expect(lineage['depth']!.state).toBe(host === 'codex' ? 'supported' : 'degraded');
      if (host === 'codex') expect(lineage['parent']!.evidence?.join(' ')).toMatch(/thread_spawn\.parent_thread_id/u);
    }
    // Only Codex resolves MCP calls without a hook window; Cursor cannot correlate natively at all.
    expect(lineage['mcp-correlation']!.state).toBe(host === 'cursor' ? 'degraded' : host === 'portable' ? 'unavailable' : 'supported');
    if (host === 'cursor') expect(lineage['cloud']!.state).toBe('unavailable');
  }
});

it('advertises notice delivery routes per host with dated unavailability (#99 stage 4)', async () => {
  const { readFile } = await import('node:fs/promises');
  const routes = ['current-response', 'directed-push', 'host-toast', 'mcp-inbox', 'mcp-resource-updated', 'next-event'];
  const files = {
    claude: 'claude-2.1.260.json',
    codex: 'codex-0.147.0.json',
    cursor: 'cursor-2026-08-28.json',
    portable: 'portable-1.0.0.json',
  };
  for (const [host, file] of Object.entries(files)) {
    const table = JSON.parse(await readFile(new URL(`../src/adapters/capabilities/${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
    const advertisement = table.noticeDelivery as Record<string, { reason?: string; state: string }>;
    expect(Object.keys(advertisement).sort()).toEqual(routes);
    for (const route of routes) {
      const entry = advertisement[route]!;
      expect(['supported', 'unavailable']).toContain(entry.state);
      if (entry.state === 'unavailable') expect(entry.reason).toMatch(/2026-09-02/u);
    }
    // No pinned host has a directed cross-actor push or toast surface (#99 survey).
    expect(advertisement['directed-push']!.state).toBe('unavailable');
    expect(advertisement['host-toast']!.state).toBe('unavailable');
    // The generated MCP inbox surface exists on every target.
    expect(advertisement['mcp-inbox']!.state).toBe('supported');
    // Hookless portable honestly loses the hook-borne routes.
    if (host === 'portable') {
      expect(advertisement['next-event']!.state).toBe('unavailable');
      expect(advertisement['current-response']!.state).toBe('unavailable');
    } else {
      expect(advertisement['next-event']!.state).toBe('supported');
    }
  }
});

/**
 * The complete hook-event inventory published at https://cursor.com/docs/hooks
 * and https://cursor.com/docs/reference/plugins (retrieved 2026-09-02):
 * 18 Agent hooks, 2 Tab hooks, and the workspaceOpen app lifecycle hook.
 */
const documentedCursorHookEvents = {
  agent: [
    'sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'subagentStart', 'subagentStop',
    'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile',
    'afterFileEdit', 'beforeSubmitPrompt', 'preCompact', 'stop', 'afterAgentResponse', 'afterAgentThought',
  ],
  app: ['workspaceOpen'],
  tab: ['beforeTabFileRead', 'afterTabFileEdit'],
} as const;

/** The per-event cloud availability table published at https://cursor.com/docs/hooks (retrieved 2026-09-02). */
const documentedCursorCloudUnavailable = [
  'sessionStart', 'sessionEnd', 'beforeMCPExecution', 'afterMCPExecution', 'beforeTabFileRead', 'afterTabFileEdit', 'workspaceOpen',
] as const;

it('pins every documented Cursor hook event exactly once across canonical routes and dated deferrals (#189)', () => {
  const documented = Object.values(documentedCursorHookEvents).flat();
  const inventory = cursorCapabilityTable.hooks.nativeEvents as Readonly<Record<string, {
    readonly canonical: string | null;
    readonly category: string;
    readonly cloud: string;
    readonly matcher: string | null;
    readonly outputFields: readonly string[];
    readonly row: string;
  }>>;
  const schemaEvents = Object.keys(cursorHooksSchema.properties.hooks.properties);

  expect(documented).toHaveLength(21);
  expect(Object.keys(inventory).sort()).toEqual([...documented].sort());
  expect([...schemaEvents].sort()).toEqual([...documented].sort());

  const routes = cursorCapabilityTable.hooks.eventRoutes as Readonly<Record<string, {
    readonly availability?: { readonly cloud: { readonly state: string }; readonly desktop: { readonly state: string } };
    readonly nativeEvent?: string;
    readonly state: string;
  }>>;
  const deferred = cursorCapabilityTable.deferredNativeEvents as Readonly<Record<string, { readonly reason: string; readonly state: string }>>;
  const routedNativeEvents = Object.values(routes).flatMap((route) => route.nativeEvent === undefined ? [] : [route.nativeEvent]);

  for (const [category, events] of Object.entries(documentedCursorHookEvents)) {
    for (const event of events) {
      const entry = inventory[event]!;
      expect(entry.category).toBe(category);
      expect(entry.cloud).toBe((documentedCursorCloudUnavailable as readonly string[]).includes(event) ? 'unavailable' : 'supported');
      if (entry.canonical === null) {
        expect(entry.row).toBe(`deferredNativeEvents.${event}`);
        expect(deferred[event]).toMatchObject({ reason: expect.stringContaining('retrieved 2026-09-02'), state: 'unavailable' });
        expect(routedNativeEvents).not.toContain(event);
      } else {
        expect(entry.row).toBe(`eventRoutes.${entry.canonical}`);
        const route = routes[entry.canonical]!;
        expect(route).toMatchObject({ nativeEvent: event, state: 'supported' });
        expect(route.availability?.desktop.state).toBe('supported');
        expect(route.availability?.cloud.state).toBe(entry.cloud);
        expect(deferred[event]).toBeUndefined();
      }
    }
  }
  // Each documented event maps to at most one canonical family.
  expect(new Set(routedNativeEvents).size).toBe(routedNativeEvents.length);
  // Cloud-side plugin delivery is recorded honestly rather than inferred from the per-event table.
  expect(cursorCapabilityTable.hooks.cloud).toMatchObject({
    configurationSources: ['project', 'team', 'enterprise'],
    executionTypes: ['command'],
    pluginHooks: { reason: expect.stringContaining('retrieved 2026-09-02'), state: 'unavailable' },
  });
});

it('records dated Cursor contract rows (#189)', () => {
  const registry = createDefaultRegistry();
  const cursor = registry.get('cursor');
  const expectedStates = {
    agentPluginFormat: 'unavailable',
    agents: 'unavailable',
    canvases: 'unavailable',
    componentDiscovery: 'supported',
    cursorPluginFormat: 'supported',
    hookFailClosed: 'unavailable',
    hookLoopLimit: 'unavailable',
    hookMatchers: 'supported',
    hookTimeout: 'supported',
    installModes: 'unavailable',
    localPluginImports: 'unavailable',
    localSymlinkInstall: 'unavailable',
    manifestMetadata: 'supported',
    marketplaceAccess: 'unavailable',
    marketplaceAutoRefresh: 'unavailable',
    marketplaceManifest: 'supported',
    marketplaceReview: 'unavailable',
    promptHooks: 'unavailable',
    rootSkill: 'unavailable',
    teamMarketplaces: 'unavailable',
    variables: 'supported',
  } as const;

  expect(Object.keys(cursorContractCapabilityRows).sort()).toEqual(Object.keys(expectedStates).sort());
  for (const [capability, expectedState] of Object.entries(expectedStates)) {
    const row = cursorContractCapabilityRows[capability as keyof typeof cursorContractCapabilityRows] as {
      readonly evidence: readonly string[];
      readonly reason?: string;
      readonly state: string;
    };
    expect(row.state).toBe(expectedState);
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(row.evidence.some((line) => /2026-09-0[23]/u.test(line))).toBe(true);
    if (expectedState === 'unavailable') {
      expect(row.reason?.length ?? 0).toBeGreaterThan(0);
      expect(cursor.capabilities[capability]).toEqual({ reason: row.reason, state: 'unavailable' });
    } else {
      expect(cursor.capabilities[capability]).toEqual({
        evidence: { observedVersion: '2026-08-28', target: 'cursor' },
        state: 'supported',
      });
    }
    expect(registry.supports('cursor', capability)).toBe(expectedState === 'supported');
  }
  expect(cursorCapabilityTable.plugin.marketplaceManifest).toMatchObject({
    generatedEntryFields: ['name', 'source', 'description'],
    maxEntries: 500,
    mergePrecedence: 'plugin-manifest-over-marketplace-entry',
  });
  expect(cursorCapabilityTable.plugin.distributionPolicy.installModes.modes).toEqual(['Default Off', 'Default On', 'Required']);
  expect(cursorCapabilityTable.plugin.formats).toMatchObject({
    agentPlugin: { manifest: 'plugin.json', state: 'unavailable' },
    cursorPlugin: { manifest: '.cursor-plugin/plugin.json', state: 'supported' },
  });
  expect(cursorCapabilityTable.plugin.componentDiscovery.emitted).toEqual({
    commands: './commands/',
    hooks: './.cursor-plugin/hooks.json',
    mcpServers: './.cursor-plugin/mcp.json',
    rules: './rules/',
    skills: './skills/',
  });
});

it('exposes each host advertisement through the adapter and registry, typed for the route selector (#99 stage 4)', () => {
  const registry = createDefaultRegistry();
  const tables = {
    claude: claudeCapabilityTable.noticeDelivery,
    codex: codexCapabilityTable.noticeDelivery,
    cursor: cursorCapabilityTable.noticeDelivery,
  } as const;
  for (const [host, rows] of Object.entries(tables)) {
    const adapter = registry.get(host);
    expect(adapter.noticeDelivery).toEqual(rows);
    expect(registry.noticeDelivery(host)).toEqual(adapter.noticeDelivery);
    expect(Object.isFrozen(adapter.noticeDelivery)).toBe(true);
    // The advertisement feeds the runtime selector unchanged: every pinned host
    // runs the inbox, resources/updated, and next-event routes, and nothing else.
    expect(selectNoticeDeliveryRoutes(adapter.noticeDelivery!)).toEqual({
      kind: 'selected',
      routes: ['mcp-resource-updated', 'mcp-inbox', 'next-event'],
    });
  }
  // Hookless portable loses the hook-borne route and keeps the MCP ones.
  expect(selectNoticeDeliveryRoutes(registry.noticeDelivery('portable')!)).toEqual({
    kind: 'selected',
    routes: ['mcp-resource-updated', 'mcp-inbox'],
  });
  expect(() => registry.noticeDelivery('unknown')).toThrow(/Unknown target adapter/u);
});

it('spells the notice delivery taxonomy locally so public declarations never resolve through the optional runtime peer', () => {
  // `@agent-bundle/runtime` is an optional peer of `agent-bundle`, so the
  // compiler's exported `TargetAdapter.noticeDelivery` uses a local shape. These
  // assignments fail to compile if either vocabulary drifts from the other.
  const toRuntime = (value: NoticeDeliveryAdvertisement): AgentNoticeDeliveryAdvertisement => value;
  const fromRuntime = (value: AgentNoticeDeliveryAdvertisement): NoticeDeliveryAdvertisement => value;
  const routeToRuntime = (route: NoticeDeliveryRoute): AgentNoticeDeliveryRoute => route;
  const routeFromRuntime = (route: AgentNoticeDeliveryRoute): NoticeDeliveryRoute => route;
  const claude = createDefaultRegistry().noticeDelivery('claude')!;
  expect(fromRuntime(toRuntime(claude))).toBe(claude);
  expect([...NOTICE_DELIVERY_ROUTES].map(routeToRuntime).toSorted())
    .toEqual([...AGENT_NOTICE_DELIVERY_ROUTES].map(routeFromRuntime).toSorted());
});

it('advertises dated sensitivity ceilings per route and host (#99 acceptance item 7)', () => {
  const registry = createDefaultRegistry();
  const ceiling = (host: string, route: NoticeDeliveryRoute): string | undefined => {
    const entry = registry.noticeDelivery(host)![route];
    return entry.state === 'supported' ? entry.sensitivity : undefined;
  };
  for (const host of ['claude', 'codex', 'cursor']) {
    // The hook response returns to the recipient's own host process: the
    // recipient's trust boundary, so a secret notice may travel in full.
    expect(ceiling(host, 'current-response')).toBe('secret');
    expect(ceiling(host, 'next-event')).toBe('secret');
    // MCP identity is transport-derived and unauthenticated to the plugin.
    expect(ceiling(host, 'mcp-inbox')).toBe('internal');
    expect(ceiling(host, 'mcp-resource-updated')).toBe('internal');
  }
  expect(ceiling('portable', 'mcp-inbox')).toBe('internal');
  expect(ceiling('portable', 'mcp-resource-updated')).toBe('internal');
  // Every named ceiling carries dated evidence.
  for (const host of ['claude', 'codex', 'cursor', 'portable']) {
    for (const route of NOTICE_DELIVERY_ROUTES) {
      const entry = registry.noticeDelivery(host)![route];
      if (entry.state !== 'supported' || entry.sensitivity === undefined) continue;
      expect(entry.sensitivityEvidence).toMatch(/2026-09-03/u);
    }
  }
  // The runtime resolves the same ceilings into disclosure decisions.
  expect(resolveNoticeDisclosure('mcp-inbox', 'secret', registry.noticeDelivery('claude')!))
    .toEqual({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
  expect(resolveNoticeDisclosure('next-event', 'secret', registry.noticeDelivery('claude')!))
    .toEqual({ kind: 'disclosed', redacted: false, shape: 'body' });
  expect(resolveNoticeDisclosure('mcp-inbox', 'internal', registry.noticeDelivery('portable')!))
    .toEqual({ kind: 'disclosed', redacted: true, shape: 'body' });
});

it('fails closed on a sensitivity ceiling it cannot describe honestly', () => {
  const rows = { ...claudeCapabilityTable.noticeDelivery } as Record<string, { reason?: string; sensitivity?: string; sensitivityEvidence?: string; state: string }>;
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { sensitivity: 'top-secret', sensitivityEvidence: '2026-09-03: x', state: 'supported' } }))
    .toThrow(/Unsupported notice sensitivity "top-secret" for mcp-inbox/u);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { sensitivity: 'secret', state: 'supported' } }))
    .toThrow(/secret sensitivity ceiling for notice delivery route mcp-inbox without dated evidence/u);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { sensitivity: 'secret', sensitivityEvidence: 'trust me', state: 'supported' } }))
    .toThrow(CapabilityStateError);
  // A bare supported row is still the pre-sensitivity contract (internal).
  expect(noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { state: 'supported' } })['mcp-inbox']).toEqual({ state: 'supported' });
});

it('intersects sensitivity ceilings to the lowest host, keeping that host\'s evidence', () => {
  const claude = createDefaultRegistry().noticeDelivery('claude')!;
  const lowered: AgentNoticeDeliveryAdvertisement = Object.freeze({
    ...claude,
    'next-event': Object.freeze({ sensitivity: 'public' as const, sensitivityEvidence: '2026-09-03: host B echoes hook responses to a shared log.', state: 'supported' as const }),
    'mcp-inbox': Object.freeze({ state: 'supported' as const }),
  });
  const merged = intersectNoticeDeliveryAdvertisements(claude, lowered);
  expect(merged['next-event']).toEqual({
    sensitivity: 'public',
    sensitivityEvidence: '2026-09-03: host B echoes hook responses to a shared log.',
    state: 'supported',
  });
  // An unevidenced bare row is `internal`; the evidenced internal row's evidence survives.
  expect(merged['mcp-inbox']).toEqual(claude['mcp-inbox']);
  // Two hosts at the same ceiling keep both pieces of evidence, deduplicated and ordered.
  const same = intersectNoticeDeliveryAdvertisements(claude, Object.freeze({
    ...claude,
    'next-event': Object.freeze({ sensitivity: 'secret' as const, sensitivityEvidence: '2026-09-03: host C, same boundary.', state: 'supported' as const }),
  }));
  const claudeNextEvent = claude['next-event'];
  const claudeEvidence = claudeNextEvent.state === 'supported' ? claudeNextEvent.sensitivityEvidence ?? '' : '';
  expect(claudeEvidence).toMatch(/2026-09-03/u);
  expect(same['next-event']).toEqual({
    sensitivity: 'secret',
    sensitivityEvidence: [claudeEvidence, '2026-09-03: host C, same boundary.']
      .sort((first, second) => first.localeCompare(second))
      .join('; '),
    state: 'supported',
  });
  // Neither host named a ceiling: the bare row survives.
  const bare = intersectNoticeDeliveryAdvertisements(
    Object.freeze({ ...claude, 'mcp-inbox': Object.freeze({ state: 'supported' as const }) }),
    Object.freeze({ ...claude, 'mcp-inbox': Object.freeze({ state: 'supported' as const }) }),
  );
  expect(bare['mcp-inbox']).toEqual({ state: 'supported' });
});

it('intersects host advertisements so a composite only claims routes every host supports', () => {
  const claude = createDefaultRegistry().noticeDelivery('claude')!;
  const partial: AgentNoticeDeliveryAdvertisement = Object.freeze({
    ...claude,
    'mcp-resource-updated': Object.freeze({ reason: '2026-09-02: host B drops resources/updated.', state: 'unavailable' as const }),
    'next-event': Object.freeze({ reason: '2026-09-02: host B has no hooks.', state: 'unavailable' as const }),
  });
  const merged = intersectNoticeDeliveryAdvertisements(claude, partial);
  // Both hosts carry Claude's evidenced `internal` inbox ceiling; it survives intact.
  expect(merged['mcp-inbox']).toEqual(claude['mcp-inbox']);
  expect(merged['mcp-inbox']).toMatchObject({ sensitivity: 'internal', state: 'supported' });
  expect(merged['mcp-resource-updated']).toEqual({ reason: '2026-09-02: host B drops resources/updated.', state: 'unavailable' });
  expect(merged['next-event']).toEqual({ reason: '2026-09-02: host B has no hooks.', state: 'unavailable' });
  // Both reasons survive, deduplicated and ordered, when both hosts decline.
  expect(merged['directed-push']).toEqual(claude['directed-push']);
  const twice = intersectNoticeDeliveryAdvertisements(partial, Object.freeze({
    ...claude,
    'next-event': Object.freeze({ reason: '2026-09-02: host C has no hooks.', state: 'unavailable' as const }),
  }));
  expect(twice['next-event']).toEqual({
    reason: '2026-09-02: host B has no hooks.; 2026-09-02: host C has no hooks.',
    state: 'unavailable',
  });
  expect(selectNoticeDeliveryRoutes(merged)).toEqual({ kind: 'selected', routes: ['mcp-inbox'] });
});

it('fails closed on a notice delivery table row it cannot describe honestly', () => {
  const rows = { ...claudeCapabilityTable.noticeDelivery } as Record<string, { reason?: string; state: string }>;
  expect(noticeDeliveryAdvertisementFrom('claude', rows)).toEqual(claudeCapabilityTable.noticeDelivery);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { state: 'suported' } }))
    .toThrow(/Unsupported notice delivery route state "suported" for mcp-inbox/u);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'host-toast': { state: 'unavailable' } }))
    .toThrow(/host-toast unavailable without a dated reason/u);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'host-toast': { reason: '  ', state: 'unavailable' } }))
    .toThrow(CapabilityStateError);
  // A reason without a survey date is not dated evidence, however long it is.
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'host-toast': { reason: 'unsupported', state: 'unavailable' } }))
    .toThrow(/host-toast unavailable without a dated reason/u);
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'host-toast': { reason: 'build 20260902 lacks it', state: 'unavailable' } }))
    .toThrow(/host-toast unavailable without a dated reason/u);
  expect(noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'host-toast': { reason: '2026-09-02: no toast API.', state: 'unavailable' } }))
    .toMatchObject({ 'host-toast': { reason: '2026-09-02: no toast API.', state: 'unavailable' } });
  const { 'directed-push': _omitted, ...missing } = rows;
  expect(() => noticeDeliveryAdvertisementFrom('fixture', missing))
    .toThrow(/advertises no notice delivery route directed-push/u);
  // Degraded and prohibited are capability states, not delivery-route states.
  expect(() => noticeDeliveryAdvertisementFrom('fixture', { ...rows, 'mcp-inbox': { reason: 'x', state: 'degraded' } }))
    .toThrow(CapabilityStateError);
});

it('re-validates a JavaScript adapter advertisement at the registry boundary', () => {
  const source = createDefaultRegistry().get('cursor');
  const asAdvertisement = (value: unknown): AgentNoticeDeliveryAdvertisement => value as AgentNoticeDeliveryAdvertisement;

  expect(() => new TargetRegistry().register({
    ...source,
    noticeDelivery: asAdvertisement({ ...source.noticeDelivery, 'mcp-inbox': { state: 'suported' } }),
  })).toThrow(CapabilityStateError);
  expect(() => new TargetRegistry().register({
    ...source,
    noticeDelivery: asAdvertisement({ ...source.noticeDelivery, 'mcp-inbox': 'supported' }),
  })).toThrow(/notice delivery route "mcp-inbox" must declare a state/u);
  expect(() => new TargetRegistry().register({ ...source, noticeDelivery: asAdvertisement('supported') }))
    .toThrow(/must declare notice delivery advertisements as a record/u);
  // The registry never exposes an undated reason as dated evidence.
  expect(() => new TargetRegistry().register({
    ...source,
    noticeDelivery: asAdvertisement({ ...source.noticeDelivery, 'host-toast': { reason: 'unsupported', state: 'unavailable' } }),
  })).toThrow(/host-toast unavailable without a dated reason/u);
  const { noticeDelivery: _declared, ...undeclared } = source;
  const registry = new TargetRegistry().register(undeclared);
  // An adapter that declares no advertisement honestly has no cross-request route.
  expect(registry.noticeDelivery('cursor')).toBeUndefined();
  expect(() => new TargetRegistry().register(source)).not.toThrow();
});
