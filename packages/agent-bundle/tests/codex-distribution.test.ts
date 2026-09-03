import { expect, it } from '@rstest/core';

import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import { codexAdapter } from '../src/adapters/codex.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import marketplaceSchema from '../src/adapters/schemas/codex/marketplace.schema.json' with { type: 'json' };
import { createAdapterValidator } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const distributionRows = {
  allowManagedHooksOnly: 'unavailable',
  featureHooks: 'unavailable',
  featurePlugins: 'unavailable',
  inlineHooksToml: 'unavailable',
  installCacheLayout: 'unavailable',
  legacyClaudeMarketplaceCompatibility: 'unavailable',
  managedRequirements: 'unavailable',
  marketplaceCategory: 'supported',
  marketplaceCliLifecycle: 'degraded',
  marketplaceInterface: 'supported',
  marketplacePolicy: 'supported',
  marketplaceSources: 'degraded',
  personalMarketplaceDiscovery: 'unavailable',
  pluginCliLifecycle: 'degraded',
  pluginEnableState: 'unavailable',
  repoMarketplaceDiscovery: 'supported',
  restrictToAllowedSources: 'unavailable',
  workspacePublishing: 'unavailable',
} as const;

const plugin: NormalizedPlugin = Object.freeze({
  extensions: Object.freeze({}),
  hooks: Object.freeze([]),
  marketplace: true as const,
  mcpServers: Object.freeze([]),
  metadata: Object.freeze({
    description: 'Review code and explain findings.',
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
    version: '1.2.3',
  }),
  runtime: Object.freeze({ node: '22.12.0' }),
  scripts: Object.freeze([]),
  skills: Object.freeze([]),
  targets: Object.freeze([
    Object.freeze({ id: 'target:codex', name: 'codex', provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }) }),
  ]),
});

const withCodexConfig = (value: Readonly<Record<string, unknown>>): NormalizedPlugin => ({
  ...plugin,
  extensions: {
    codex: {
      id: 'extension:codex',
      key: 'codex',
      provenance: { kind: 'config', sourcePath: '/workspace/codex.config.ts' },
      target: 'codex',
      value,
    },
  },
});

const emittedMarketplace = (model: NormalizedPlugin) => {
  const plan = codexAdapter.plan(model);
  const entry = plan.entries.find((candidate) => candidate.relativePath === '.agents/plugins/marketplace.json');
  return {
    codes: plan.diagnostics.map((diagnostic) => diagnostic.code),
    document: entry?.kind === 'write' ? JSON.parse(entry.content) as Record<string, unknown> : undefined,
    entry,
  };
};

const entry = (source: unknown) => ({
  category: 'Productivity',
  name: 'remote-helper',
  policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
  source,
});

const marketplace = (...sources: readonly unknown[]) => ({
  interface: { displayName: 'Local Example Plugins' },
  name: 'local-example-plugins',
  plugins: sources.map(entry),
});

it('records dated four-state Codex distribution rows mirrored by the adapter and intersected by the unified bundle', () => {
  const registry = createDefaultRegistry();
  const unified = registry.get('plugin');
  const table = codexCapabilityTable.distribution as Readonly<Record<string, {
    readonly evidence: readonly string[];
    readonly reason?: string;
    readonly state: string;
  }>>;

  expect(Object.keys(table).sort()).toEqual(Object.keys(distributionRows).sort());
  for (const [capability, expectedState] of Object.entries(distributionRows)) {
    const row = table[capability]!;
    expect(row.state, capability).toBe(expectedState);
    expect(row.evidence.length, capability).toBeGreaterThan(0);
    expect(row.evidence.every((line) => /^(?:retrieved )?2026-09-02:/u.test(line)), capability).toBe(true);
    if (expectedState === 'supported') {
      expect(row.reason).toBeUndefined();
      expect(codexAdapter.capabilities[capability]).toEqual({
        evidence: { observedVersion: '0.147.0', target: 'codex' },
        state: 'supported',
      });
    } else {
      expect(row.reason, capability).toMatch(/\S/u);
      expect(codexAdapter.capabilities[capability]).toMatchObject({ reason: row.reason, state: expectedState });
    }
    expect(registry.supports('codex', capability)).toBe(expectedState === 'supported');
    expect(unified.capabilities[capability]).toMatchObject({ state: 'unavailable' });
    expect(registry.supports('plugin', capability)).toBe(false);
  }
  expect(table.pluginCliLifecycle).toMatchObject({ commands: ['add', 'list', 'remove'] });
  expect(table.marketplaceCliLifecycle).toMatchObject({ commands: ['add', 'list', 'upgrade', 'remove'] });
  expect(table.marketplaceSources).toMatchObject({
    admitted: ['local', 'local-string', 'url', 'git-subdir', 'npm'],
    emitted: 'local',
  });
  expect(table.installCacheLayout).toMatchObject({
    evidence: expect.arrayContaining([expect.stringContaining('manifest version')]),
  });
  expect(codexCapabilityTable.marketplace.policy).toEqual({
    authentication: ['ON_INSTALL', 'ON_USE'],
    installation: ['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'],
  });
});

it('admits every documented marketplace source form and rejects escapes, credentials, and selectors', () => {
  const validate = createAdapterValidator().compile(marketplaceSchema);
  const admitted = marketplace(
    './plugins/my-plugin',
    { path: './plugins/my-plugin', source: 'local' },
    { ref: 'main', source: 'url', url: 'https://github.com/example/codex-plugins.git' },
    { sha: '0123456789abcdef0123456789abcdef01234567', source: 'url', url: 'git@github.com:example/codex-plugins.git' },
    { path: './plugins/remote-helper', ref: 'main', source: 'git-subdir', url: 'https://github.com/example/codex-plugins.git' },
    { path: './plugins/remote-helper', source: 'git-subdir', url: 'ssh://git@github.com/example/codex-plugins.git' },
    { package: '@example/codex-plugin', registry: 'https://registry.npmjs.org', source: 'npm', version: '^1.2.0' },
    { package: 'codex-plugin', source: 'npm' },
    { package: 'codex-plugin', source: 'npm', version: 'latest' },
  );
  expect(validate(admitted), JSON.stringify(validate.errors)).toBe(true);

  const rejected: readonly unknown[] = [
    '../outside',
    'plugins/my-plugin',
    { path: './plugins/../../outside', source: 'local' },
    { path: '.\\plugins\\my-plugin', source: 'local' },
    { source: 'url', url: 'file:///tmp/plugins' },
    { source: 'url', url: 'https://github.com/example/codex-plugins.git', sha: 'not-hex' },
    { source: 'git-subdir', url: 'https://github.com/example/codex-plugins.git' },
    { package: '@example/codex-plugin', source: 'npm', version: 'file:../local' },
    { package: '@example/codex-plugin', source: 'npm', version: 'https://example.test/pkg.tgz' },
    { package: '@example/codex-plugin', source: 'npm', version: 'npm:other@1.0.0' },
    { package: '@example/codex-plugin', registry: 'http://registry.example.test', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://user:token@registry.example.test', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://registry.example.test/?auth=1', source: 'npm' },
    { source: 'npm' },
    { source: 'git', url: 'https://github.com/example/codex-plugins.git' },
  ];
  for (const source of rejected) {
    expect(validate(marketplace(source)), JSON.stringify(source)).toBe(false);
  }
  for (const policy of [
    { authentication: 'ON_INSTALL' },
    { authentication: 'ALWAYS', installation: 'AVAILABLE' },
    { authentication: 'ON_INSTALL', installation: 'HIDDEN' },
  ]) {
    expect(validate({ ...marketplace('./'), plugins: [{ ...entry('./'), policy }] }), JSON.stringify(policy)).toBe(false);
  }
  expect(validate({ ...marketplace('./'), plugins: [{ ...entry('./'), category: undefined }] })).toBe(false);
});

it('emits the marketplace entry with documented defaults and follows the authored interface category', () => {
  const generated = emittedMarketplace(plugin);
  expect(generated.codes).toEqual([]);
  expect(generated.document).toEqual({
    interface: { displayName: 'review-tools' },
    name: 'review-tools-marketplace',
    plugins: [{
      category: 'Productivity',
      name: 'review-tools',
      policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
      source: { path: './', source: 'local' },
    }],
  });

  const categorized = emittedMarketplace(withCodexConfig({ interface: { category: 'Developer Tools' } }));
  expect(categorized.codes).toEqual([]);
  expect(categorized.document).toMatchObject({ plugins: [{ category: 'Developer Tools' }] });
  expect(categorized.entry).toMatchObject({ sourceInputs: expect.arrayContaining(['/workspace/codex.config.ts']) });
});

it('emits every authored Codex marketplace field', () => {
  const authored = emittedMarketplace(withCodexConfig({
    interface: { category: 'Developer Tools' },
    marketplace: {
      category: 'Security',
      displayName: 'Review Tools Marketplace',
      policy: { authentication: 'ON_USE', installation: 'INSTALLED_BY_DEFAULT' },
    },
  }));
  expect(authored.codes).toEqual([]);
  expect(authored.document).toEqual({
    interface: { displayName: 'Review Tools Marketplace' },
    name: 'review-tools-marketplace',
    plugins: [{
      category: 'Security',
      name: 'review-tools',
      policy: { authentication: 'ON_USE', installation: 'INSTALLED_BY_DEFAULT' },
      source: { path: './', source: 'local' },
    }],
  });
  expect(authored.entry).toMatchObject({ sourceInputs: expect.arrayContaining(['/workspace/codex.config.ts']) });
});

it.each([
  { code: 'codex.marketplace.invalid', value: [] },
  { code: 'codex.marketplace.invalid', value: 'AVAILABLE' },
  { code: 'codex.marketplace.field.unknown', value: { source: { source: 'npm', package: 'x' } } },
  { code: 'codex.marketplace.category.invalid', value: { category: '' } },
  { code: 'codex.marketplace.display-name.invalid', value: { displayName: '   ' } },
  { code: 'codex.marketplace.policy.invalid', value: { policy: 'ON_USE' } },
  { code: 'codex.marketplace.policy.field.unknown', value: { policy: { approval: 'prompt' } } },
  { code: 'codex.marketplace.policy.authentication.invalid', value: { policy: { authentication: 'ALWAYS' } } },
  { code: 'codex.marketplace.policy.installation.invalid', value: { policy: { installation: 'HIDDEN' } } },
] as const)('rejects invalid authored Codex marketplace input with $code', ({ code, value }) => {
  const rejected = emittedMarketplace(withCodexConfig({ marketplace: value }));

  expect(rejected.codes).toContain(code);
  expect(rejected.document).toBeUndefined();
});
