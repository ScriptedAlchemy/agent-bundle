import { expect, it } from '@rstest/core';

import { AGENT_NOTICE_DELIVERY_ROUTES, selectNoticeDeliveryRoutes } from '@agent-bundle/runtime/notices';
import type { AgentNoticeDeliveryAdvertisement, AgentNoticeDeliveryRoute } from '@agent-bundle/runtime/notices';

import {
  capabilityBooleanView,
  capabilityEvidence,
  capabilityIsSupported,
  intersectCapabilityStates,
  intersectNoticeDeliveryAdvertisements,
  noticeDeliveryAdvertisementFrom,
  supportedCapability,
  unavailableCapability,
  unionCapabilityStates,
} from '../src/adapters/capability-state.ts';
import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.250.json' with { type: 'json' };
import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import cursorCapabilityTable from '../src/adapters/capabilities/cursor-2026-08-28.json' with { type: 'json' };
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
const state = (value: CapabilityState): CapabilityState => Object.freeze(value);

it('keeps the plugin Boolean capability view as the three-host intersection except for LSP', () => {
  const registry = createDefaultRegistry();

  for (const capability of ['commands', 'marketplace', 'hooks', 'mcp', 'rules', 'skills']) {
    expect(registry.supports('plugin', capability)).toBe(
      registry.supports('claude', capability) &&
      registry.supports('codex', capability) &&
      registry.supports('cursor', capability),
    );
  }
  expect(registry.supports('plugin', 'lsp')).toBe(
    registry.supports('claude', 'lsp') && registry.supports('codex', 'lsp'),
  );
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
  expect(registry.get('plugin').capabilities.commands).toEqual(intersectCapabilityStates(
    intersectCapabilityStates(
      registry.get('claude').capabilities.commands!,
      registry.get('codex').capabilities.commands!,
    ),
    registry.get('cursor').capabilities.commands!,
  ));
});

it('records an honest four-state rules row on every adapter', () => {
  const registry = createDefaultRegistry();
  expect(registry.get('cursor').capabilities.rules).toMatchObject({
    evidence: { observedVersion: '2026-08-28', target: 'cursor' },
    state: 'supported',
  });
  expect(registry.get('claude').capabilities.rules).toEqual({
    reason: 'The pinned Claude Code plugin contract (2.1.250) defines no rules component; project guidance ships through CLAUDE.md memory, not a rules directory.',
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
  expect(registry.get('plugin').capabilities.rules).toEqual(intersectCapabilityStates(
    intersectCapabilityStates(
      registry.get('claude').capabilities.rules!,
      registry.get('codex').capabilities.rules!,
    ),
    registry.get('cursor').capabilities.rules!,
  ));
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
  const unified = registry.get('plugin');
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
      // The unified bundle intersects every Codex-only surface with an
      // honest unavailable row for the hosts that lack it.
      expect(unified.capabilities[capability]).toMatchObject({ state: 'unavailable' });
      expect(registry.supports('codex', capability)).toBe(expectedState === 'supported');
      expect(registry.supports('plugin', capability)).toBe(false);
    }
  }

  expect(codexCapabilityTable.tokens).toEqual({
    pluginData: false,
    pluginRoot: 'relative-with-plugin-root-cwd',
    workspaceRoot: false,
  });
});

it('reports Claude LSP support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.lsp).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('codex').capabilities.lsp).toMatchObject({
    reason: expect.stringContaining('no LSP server surface'),
    state: 'unavailable',
  });
  expect(registry.get('plugin').capabilities.lsp).toMatchObject({
    reason: expect.stringContaining('no LSP server surface'),
    state: 'unavailable',
  });
  expect(registry.supports('claude', 'lsp')).toBe(true);
  expect(registry.supports('codex', 'lsp')).toBe(false);
  expect(registry.supports('plugin', 'lsp')).toBe(false);
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
  // Emission dispatch: the composite still writes Claude's `.lsp.json`, so
  // inspection judges the `lsp` kind by the union while the three-host
  // intersection above stays honestly unavailable.
  expect(registry.get('plugin').componentCapabilities?.lsp).toMatchObject({
    evidence: { target: 'claude' },
    state: 'supported',
  });
});

it('records dated unavailable native-diagnostics and native-extension rows on every host and the composite (#100)', () => {
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
    expect(registry.get('plugin').capabilities[capability]).toMatchObject({ state: 'unavailable' });
    expect(registry.get('plugin').componentCapabilities?.[capability]).toMatchObject({ state: 'unavailable' });
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
  const plugin = registry.get('plugin');

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
    // Composite: intersection stays honest, emission dispatch follows the Claude half.
    expect(plugin.capabilities[`commands.${field}`]).toMatchObject({ state: 'unavailable' });
    expect(plugin.componentCapabilities?.[`commands.${field}`]).toMatchObject({ evidence: { target: 'claude' }, state: 'supported' });
  }
  expect(cursorCapabilityTable.plugin.commandFrontmatter.evidence.some((entry) => entry.startsWith('2026-09-03: '))).toBe(true);

  // Rules: only Cursor publishes a rules surface, with the three documented .mdc fields.
  for (const field of ['alwaysApply', 'description', 'globs']) {
    expect(cursor[`rules.${field}`]).toMatchObject({ evidence: { target: 'cursor' }, state: 'supported' });
    expect(claude[`rules.${field}`]).toBeUndefined();
    expect(plugin.componentCapabilities?.[`rules.${field}`]).toMatchObject({ evidence: { target: 'cursor' }, state: 'supported' });
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
  // The composite's shared skills/ tree falls back to the portable document for
  // any skill with a host extension or token, so neither feature reaches it.
  for (const capability of ['skills.hostFrontmatter', 'skills.markdownTokens']) {
    expect(plugin.componentCapabilities?.[capability]).toMatchObject({ reason: expect.stringContaining('portable document'), state: 'unavailable' });
    expect(plugin.capabilities[capability]).toEqual(plugin.componentCapabilities?.[capability]);
  }
});

it('judges composite event routes by the same intersection validation applies (#100 event-route kind)', () => {
  const registry = createDefaultRegistry();
  const plugin = registry.get('plugin');
  for (const [capability, state] of Object.entries(plugin.capabilities)) {
    if (!capability.startsWith('event:')) continue;
    expect(plugin.componentCapabilities?.[capability]).toEqual(state);
  }
  expect(plugin.componentCapabilities?.['event:session/start']).toMatchObject({ state: 'supported' });
});

it('reports Claude bin support without inventing coverage on other native hosts', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.bin).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.bin).toMatchObject({
    reason: expect.stringContaining('Claude-only bin'),
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.bin).toBeUndefined();
  }
  expect(registry.supports('claude', 'bin')).toBe(true);
  expect(registry.supports('plugin', 'bin')).toBe(false);
});

it.each([
  ['outputStyles', 'output styles'],
  ['workflows', 'workflows'],
] as const)('reports Claude %s support and honest unavailable composite coverage', (capability, label) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities[capability]).toEqual({
    reason: `The unified bundle emits Claude-only ${label}, but the pinned Codex and Cursor contracts declare no shared ${label} surface.`,
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
  }
  expect(registry.supports('claude', capability)).toBe(true);
  expect(registry.supports('plugin', capability)).toBe(false);
});

it('reports Claude plugin settings support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.settings).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.settings).toMatchObject({
    reason: expect.stringContaining('no plugin settings-defaults surface'),
    state: 'unavailable',
  });
  // Codex and Cursor declare no settings row at all, so an absent capability
  // stays an honest "not declared" rather than an inferred support claim.
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.settings).toBeUndefined();
    expect(registry.supports(target, 'settings')).toBe(false);
  }
  expect(registry.supports('claude', 'settings')).toBe(true);
  expect(registry.supports('plugin', 'settings')).toBe(false);
});

const claudeAgentCapabilityRows = {
  background: 'agents.background',
  component: 'agents',
  description: 'agents.description',
  disallowedTools: 'agents.disallowedTools',
  effort: 'agents.effort',
  hooks: 'agents.hooks',
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

it('records dated unavailable Claude agent rows and mirrors them through the unified adapter', () => {
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
    expect(row.evidence.every((line) => line.startsWith('retrieved 2026-09-02:'))).toBe(true);
    expect(registry.get('claude').capabilities[capability]).toEqual({
      reason: row.reason,
      state: 'unavailable',
    });
    expect(registry.get('plugin').capabilities[capability]).toEqual(rowName === 'component'
      ? intersectCapabilityStates(
          intersectCapabilityStates(
            registry.get('claude').capabilities.agents!,
            registry.get('cursor').capabilities.agents!,
          ),
          unavailableCapability('The pinned Codex plugin contract publishes no plugin agents component.'),
        )
      : intersectCapabilityStates(
          registry.get('claude').capabilities[capability]!,
          unavailableCapability(
            'The pinned Codex plugin contract publishes no plugin agents component, and the pinned Cursor agents component documents only name and description frontmatter, so no shared agent-frontmatter surface exists.',
          ),
        ));
    expect(registry.supports('claude', capability)).toBe(false);
    expect(registry.supports('plugin', capability)).toBe(false);
  }
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

it('reports Claude userConfig support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.userConfig).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.userConfig).toMatchObject({
    reason: expect.stringContaining('Claude-only userConfig'),
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.userConfig).toBeUndefined();
  }
  expect(registry.supports('claude', 'userConfig')).toBe(true);
  expect(registry.supports('plugin', 'userConfig')).toBe(false);
});

it('reports Claude channels support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.channels).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.channels).toEqual({
    reason: 'The unified bundle emits the Claude-only channels manifest field, but the pinned Codex and Cursor contracts declare no shared message-channel surface.',
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.channels).toBeUndefined();
  }
  expect(registry.supports('claude', 'channels')).toBe(true);
  expect(registry.supports('plugin', 'channels')).toBe(false);
});

it.each([
  ['themes', 'experimental themes'],
  ['monitors', 'background monitors'],
] as const)('reports Claude %s support without inventing shared composite coverage', (capability, reason) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities[capability]).toMatchObject({
    reason: expect.stringContaining(reason),
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
  }
  expect(registry.supports('claude', capability)).toBe(true);
  expect(registry.supports('plugin', capability)).toBe(false);
});

it('reports Claude dependency support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.dependencies).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.dependencies).toMatchObject({
    reason: expect.stringContaining('Claude Code only'),
    state: 'unavailable',
  });
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.dependencies).toBeUndefined();
    expect(registry.supports(target, 'dependencies')).toBe(false);
  }
  expect(registry.supports('claude', 'dependencies')).toBe(true);
  expect(registry.supports('plugin', 'dependencies')).toBe(false);
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
    evidence: { observedVersion: '2.1.250', target: 'claude' },
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
        evidence: { observedVersion: '2.1.250', target: 'claude' },
        state: 'supported',
      });
    } else {
      expect(registry.get('claude').capabilities[capability]).toEqual({
        reason: row.reason,
        state: 'unavailable',
      });
    }
    expect(registry.get('plugin').capabilities[capability]).toMatchObject({
      state: 'unavailable',
    });
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
    expect(registry.get('plugin').capabilities[capability]).toMatchObject({
      state: 'unavailable',
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

it.each([
  ['marketplaceManifest', 'completed marketplace manifest'],
  ['allowCrossMarketplaceDependenciesOn', 'cross-marketplace dependency allowlist'],
] as const)('reports Claude %s support and honest unavailable composite coverage', (capability, reason) => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities[capability]).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities[capability]).toMatchObject({
    reason: expect.stringContaining(reason),
    state: 'unavailable',
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
  expect(registry.supports('plugin', capability)).toBe(false);
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

it('reports Claude manifestPaths support without inventing shared composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.manifestPaths).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('plugin').capabilities.manifestPaths).toMatchObject({
    reason: expect.stringContaining('custom manifest path rules'),
    state: 'unavailable',
  });
  // Neither the pinned Cursor contract nor Agent Plugins 1.0.0 (#307) defines
  // custom manifest path rules.
  for (const target of ['cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities.manifestPaths).toBeUndefined();
    expect(registry.supports(target, 'manifestPaths')).toBe(false);
  }
  expect(registry.supports('claude', 'manifestPaths')).toBe(true);
  expect(registry.supports('plugin', 'manifestPaths')).toBe(false);
});

it('reports manifest metadata support on every native host and the three-host composite', () => {
  const registry = createDefaultRegistry();

  for (const target of ['claude', 'codex', 'cursor'] as const) {
    expect(registry.get(target).capabilities.manifestMetadata).toMatchObject({
      evidence: { target },
      state: 'supported',
    });
    expect(registry.supports(target, 'manifestMetadata')).toBe(true);
  }
  expect(registry.get('plugin').capabilities.manifestMetadata).toMatchObject({
    evidence: { target: 'claude+codex+cursor' },
    state: 'supported',
  });
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

it('mirrors Codex manifest metadata and path states through the unified adapter', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('codex').capabilities.manifestMetadata).toMatchObject({
    evidence: { target: 'codex' },
    state: 'supported',
  });
  expect(registry.get('codex').capabilities.manifestPaths).toMatchObject({
    evidence: { target: 'codex' },
    reason: expect.stringContaining('canonical'),
    state: 'degraded',
  });
  expect(registry.get('plugin').capabilities.manifestMetadata).toEqual(intersectCapabilityStates(
    intersectCapabilityStates(
      registry.get('claude').capabilities.manifestMetadata!,
      registry.get('codex').capabilities.manifestMetadata!,
    ),
    registry.get('cursor').capabilities.manifestMetadata!,
  ));
  expect(registry.get('plugin').capabilities.manifestPaths).toEqual(intersectCapabilityStates(
    intersectCapabilityStates(
      registry.get('claude').capabilities.manifestPaths!,
      registry.get('codex').capabilities.manifestPaths!,
    ),
    unavailableCapability(
      'The pinned Cursor plugin contract does not share the Codex and Claude custom manifest path rules.',
    ),
  ));
});

it('intersects supported composite capabilities and merges both evidence records', () => {
  const intersection = intersectCapabilityStates(
    supportedCapability(evidence('claude')),
    supportedCapability(evidence('codex')),
  );

  expect(intersection.state).toBe('supported');
  if (intersection.state !== 'supported') throw new Error('Expected a supported capability intersection.');
  expect(intersection.evidence).toMatchObject({
    observedVersion: 'claude@claude-version+codex@codex-version',
    target: 'claude+codex',
  });
});

it('applies prohibited, unavailable, degraded, and supported intersection precedence', () => {
  const supported = supportedCapability(evidence('supported'));
  const degraded = state({ state: 'degraded', reason: 'degraded host', evidence: evidence('degraded') });
  const unavailable = state({ state: 'unavailable', reason: 'unavailable host' });
  const prohibited = state({ state: 'prohibited', reason: 'prohibited host' });

  for (const other of [supported, degraded, unavailable]) {
    expect(intersectCapabilityStates(other, prohibited)).toEqual(prohibited);
    expect(intersectCapabilityStates(prohibited, other)).toEqual(prohibited);
  }
  for (const other of [supported, degraded]) {
    expect(intersectCapabilityStates(other, unavailable)).toEqual(unavailable);
    expect(intersectCapabilityStates(unavailable, other)).toEqual(unavailable);
  }
  expect(intersectCapabilityStates(supported, degraded)).toMatchObject({
    state: 'degraded',
    reason: 'degraded host',
  });
  expect(intersectCapabilityStates(degraded, supported)).toMatchObject({
    state: 'degraded',
    reason: 'degraded host',
  });
});

it('unions host capability states according to composite emission dispatch', () => {
  const supported = supportedCapability(evidence('supported'));
  const unavailable = unavailableCapability('unavailable host');
  const prohibited = state({ state: 'prohibited', reason: 'prohibited host' });

  expect(unionCapabilityStates(supported, unavailable)).toEqual(supported);
  expect(unionCapabilityStates(unavailable, supported)).toEqual(supported);
  expect(unionCapabilityStates(
    unavailableCapability('second unavailable host'),
    unavailable,
  )).toEqual({
    reason: 'second unavailable host; unavailable host',
    state: 'unavailable',
  });
  expect(unionCapabilityStates(prohibited, supported)).toEqual(supported);
  expect(unionCapabilityStates(supported, prohibited)).toEqual(supported);
});

it('keeps the Boolean compatibility view thin and exhaustive', () => {
  expect(capabilityBooleanView({
    degraded: { state: 'degraded', reason: 'partial' },
    prohibited: { state: 'prohibited', reason: 'policy' },
    supported: supportedCapability(evidence('supported')),
    unavailable: { state: 'unavailable', reason: 'missing' },
  })).toEqual({
    degraded: false,
    prohibited: false,
    supported: true,
    unavailable: false,
  });
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
  const supported = supportedCapability(evidence('cursor'));

  // The bug this covers: the exhaustive default returned the capability object,
  // so an untyped adapter's typo read as truthy support.
  expect(() => capabilityIsSupported(unknown)).toThrow(CapabilityStateError);
  expect(() => capabilityIsSupported(unknown)).toThrow(/outside the degraded\/prohibited\/supported\/unavailable contract/u);
  expect(() => capabilityBooleanView({ mcp: unknown })).toThrow(CapabilityStateError);
  expect(() => intersectCapabilityStates(unknown, supported)).toThrow(CapabilityStateError);
  expect(() => intersectCapabilityStates(supported, unknown)).toThrow(CapabilityStateError);

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

it('validates lowersConfigExtensions at registration and answers extension lowering per target (#100)', () => {
  const source = createDefaultRegistry().get('cursor');
  for (const malformedValue of ['claude', ['claude', 42], [' ']]) {
    expect(() => new TargetRegistry().register({
      ...source,
      lowersConfigExtensions: malformedValue as never,
    })).toThrow(/lowersConfigExtensions must be an array of nonempty extension keys/u);
  }
  const registry = createDefaultRegistry();
  // Own key, declared composite sides, and nothing else.
  expect(registry.lowersConfigExtension('claude', 'claude')).toBe(true);
  expect(registry.lowersConfigExtension('plugin', 'claude')).toBe(true);
  expect(registry.lowersConfigExtension('plugin', 'codex')).toBe(true);
  expect(registry.lowersConfigExtension('cursor', 'claude')).toBe(false);
  expect(registry.lowersConfigExtension('portable', 'claude')).toBe(false);
  expect(registry.lowersConfigExtension('missing', 'claude')).toBe(false);
  // Ownership is answered from the registration snapshot: mutating a live
  // adapter's configExtension afterwards changes nothing.
  const mutable = { ...createDefaultRegistry().get('cursor'), configExtension: { key: 'mutable' }, name: 'mutable-host' };
  const snapshotted = new TargetRegistry().register(mutable);
  mutable.configExtension.key = 'renamed';
  expect(snapshotted.lowersConfigExtension('mutable-host', 'mutable')).toBe(true);
  expect(snapshotted.lowersConfigExtension('mutable-host', 'renamed')).toBe(false);
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
  for (const capability of [
    'event:agent/start',
    'event:agent/stop',
    'event:compact/before',
    'event:prompt/submit',
    'event:session/end',
  ]) {
    expect(registry.get('plugin').capabilities[capability]).toMatchObject({
      evidence: { target: 'claude+codex+cursor' },
      state: 'supported',
    });
  }
  expect(registry.get('plugin').capabilities['event:tool/failure']).toMatchObject({
    reason: expect.stringContaining('no tool-failure'),
    state: 'unavailable',
  });
  expect(registry.get('plugin').capabilities['event:compact/after']).toMatchObject({
    reason: expect.stringContaining('no postCompact'),
    state: 'unavailable',
  });
  const workspaceOpen = registry.get('plugin').capabilities['event:workspace/open'];
  expect(workspaceOpen).toMatchObject({
    reason: expect.not.stringContaining('pluginPaths'),
    state: 'unavailable',
  });
  expect(workspaceOpen).toMatchObject({ reason: expect.stringContaining('Claude Code 2.1.250') });
  expect(workspaceOpen).toMatchObject({ reason: expect.stringContaining('Codex 0.147.0') });
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
  for (const target of ['portable', 'plugin'] as const) {
    expect(registry.get(target).capabilities.install).toMatchObject({
      reason: expect.stringContaining('profile'),
      state: 'unavailable',
    });
    expect(registry.supports(target, 'install')).toBe(false);
  }
});

it('pins dated deferral rows for every explicitly deferred native callback from #258', async () => {
  const { readFile } = await import('node:fs/promises');
  const tables = {
    claude: JSON.parse(await readFile(new URL('../src/adapters/capabilities/claude-2.1.250.json', import.meta.url), 'utf8')) as Record<string, unknown>,
    codex: JSON.parse(await readFile(new URL('../src/adapters/capabilities/codex-0.147.0.json', import.meta.url), 'utf8')) as Record<string, unknown>,
    cursor: JSON.parse(await readFile(new URL('../src/adapters/capabilities/cursor-2026-08-28.json', import.meta.url), 'utf8')) as Record<string, unknown>,
  };
  const expected = {
    claude: [
      'ConfigChange-policy_settings', 'CwdChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult',
      'InstructionsLoaded', 'MessageDisplay', 'Notification', 'PostModelSwitch', 'PostToolBatch',
      'PreModelSwitch', 'Setup', 'UserPromptExpansion', 'WorktreeCreate', 'WorktreeRemove',
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

it('advertises notice delivery routes per host with dated unavailability (#99 stage 4)', async () => {
  const { readFile } = await import('node:fs/promises');
  const routes = ['current-response', 'directed-push', 'host-toast', 'mcp-inbox', 'mcp-resource-updated', 'next-event'];
  const files = {
    claude: 'claude-2.1.250.json',
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

it('records dated Cursor contract rows and mirrors every one through the unified adapter (#189)', () => {
  const registry = createDefaultRegistry();
  const cursor = registry.get('cursor');
  const unified = registry.get('plugin');
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
    expect(unified.capabilities[capability]).toBeDefined();
    if (capability === 'manifestMetadata') {
      expect(unified.capabilities[capability]).toMatchObject({ state: 'supported' });
    } else {
      expect(unified.capabilities[capability]).toMatchObject({ state: 'unavailable' });
      expect(registry.supports('plugin', capability)).toBe(false);
    }
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
    hooks: './hooks/hooks.json',
    mcpServers: './mcp.json',
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
  // The unified bundle serves all three hosts, so it advertises their intersection.
  const plugin = registry.noticeDelivery('plugin')!;
  expect(plugin).toEqual(intersectNoticeDeliveryAdvertisements(
    intersectNoticeDeliveryAdvertisements(registry.noticeDelivery('claude')!, registry.noticeDelivery('codex')!),
    registry.noticeDelivery('cursor')!,
  ));
  expect(selectNoticeDeliveryRoutes(plugin)).toEqual({
    kind: 'selected',
    routes: ['mcp-resource-updated', 'mcp-inbox', 'next-event'],
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

it('intersects host advertisements so a composite only claims routes every host supports', () => {
  const claude = createDefaultRegistry().noticeDelivery('claude')!;
  const partial: AgentNoticeDeliveryAdvertisement = Object.freeze({
    ...claude,
    'mcp-resource-updated': Object.freeze({ reason: '2026-09-02: host B drops resources/updated.', state: 'unavailable' as const }),
    'next-event': Object.freeze({ reason: '2026-09-02: host B has no hooks.', state: 'unavailable' as const }),
  });
  const merged = intersectNoticeDeliveryAdvertisements(claude, partial);
  expect(merged['mcp-inbox']).toEqual({ state: 'supported' });
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
