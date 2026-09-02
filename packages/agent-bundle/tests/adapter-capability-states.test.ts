import { expect, it } from '@rstest/core';

import {
  capabilityBooleanView,
  capabilityEvidence,
  capabilityIsSupported,
  intersectCapabilityStates,
  supportedCapability,
  unavailableCapability,
  unionCapabilityStates,
} from '../src/adapters/capability-state.ts';
import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.250.json' with { type: 'json' };
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
  for (const target of ['codex', 'cursor', 'portable'] as const) {
    expect(registry.get(target).capabilities[capability]).toBeUndefined();
    expect(registry.supports(target, capability)).toBe(false);
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

it.each([
  ['manifestMetadata', 'manifest metadata fields'],
  ['manifestPaths', 'custom manifest path rules'],
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
  const allNativeHosts = [
    'event:agent/start',
    'event:agent/stop',
    'event:session/start',
    'event:stop',
    'event:tool/after',
    'event:tool/before',
  ];

  for (const capability of allNativeHosts) {
    expect(registry.get('cursor').capabilities[capability]).toMatchObject({
      evidence: { observedVersion: '2026-08-28', target: 'cursor' },
      state: 'supported',
    });
  }
  expect(registry.get('cursor').capabilities['event:workspace/open']).toMatchObject({
    evidence: { observedVersion: '2026-08-28', target: 'cursor' },
    state: 'supported',
  });
  for (const target of ['claude', 'codex'] as const) {
    for (const capability of allNativeHosts) {
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
  for (const capability of ['event:agent/start', 'event:agent/stop']) {
    expect(registry.get('plugin').capabilities[capability]).toMatchObject({
      evidence: { target: 'claude+codex+cursor' },
      state: 'supported',
    });
  }
  expect(registry.get('plugin').capabilities['event:workspace/open']).toMatchObject({
    reason: expect.not.stringContaining('pluginPaths'),
    state: 'unavailable',
  });
  expect(registry.get('plugin').capabilities['event:workspace/open']).toMatchObject({
    reason: expect.stringContaining('Claude Code 2.1.250'),
  });
  expect(registry.get('plugin').capabilities['event:workspace/open']).toMatchObject({
    reason: expect.stringContaining('Codex 0.147.0'),
  });
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
