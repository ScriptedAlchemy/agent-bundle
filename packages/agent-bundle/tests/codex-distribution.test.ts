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

it('records dated four-state Codex distribution rows mirrored by the adapter', () => {
  const registry = createDefaultRegistry();
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
    expect(row.evidence.every((line) => /^(?:retrieved )?2026-09-0[23]:/u.test(line)), capability).toBe(true);
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
    notInstallable: 'NOT_AVAILABLE',
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
    { source: 'url', url: 'https://token@git.example.test:8443/team/codex-plugins.git' },
    // RFC 3986 userinfo: user:password and percent-encoded credentials, on every host form.
    { source: 'url', url: 'https://user:token@git.example.test/team/codex-plugins.git' },
    { source: 'url', url: 'https://user%40corp:p%3Ass@git.example.test/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:token@10.0.0.1:8443/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:token@[2001:db8::1]:8443/team/codex-plugins.git' },
    { source: 'url', url: 'ssh://git@git.example.test:2222/team/codex-plugins.git' },
    { source: 'url', url: 'git@git.example.test:~team/codex-plugins.git' },
    { source: 'url', url: 'https://github.com/example/codex%20plugins.git' },
    { package: 'codex-plugin', registry: 'https://npm.example.test:4873/prefix/', source: 'npm' },
    { source: 'url', url: 'https://github.com:65535/example/codex-plugins.git' },
    { source: 'url', url: 'https://github.com:0443/example/codex-plugins.git' },
    { package: 'codex-plugin', registry: 'https://npm.example.test:65535', source: 'npm' },
    { source: 'url', url: 'https://10.0.0.1/team/codex-plugins.git' },
    { source: 'url', url: 'https://192.168.1.250:8443/team/codex-plugins.git' },
    { source: 'url', url: 'git@10.0.0.1:team/codex-plugins.git' },
    { source: 'url', url: 'https://localhost/team/codex-plugins.git' },
    { source: 'url', url: 'https://xn--bcher-kva.example/team/codex-plugins.git' },
    { package: 'codex-plugin', registry: 'https://10.0.0.1:4873/', source: 'npm' },
    // Bracketed IPv6 authorities (RFC 3986 IP-literal) in every URL form Git and npm accept.
    { source: 'url', url: 'ssh://git@[2001:db8::1]/team/codex-plugins.git' },
    { source: 'url', url: 'https://[2001:db8::1]:4873/team/codex-plugins.git' },
    { source: 'url', url: 'https://[::1]/team/codex-plugins.git' },
    { source: 'url', url: 'https://[::ffff:10.0.0.1]/team/codex-plugins.git' },
    { source: 'url', url: 'https://[2001:0db8:85a3:0000:0000:8a2e:0370:7334]/team/codex-plugins.git' },
    { source: 'url', url: 'git@[2001:db8::1]:team/codex-plugins.git' },
    { package: 'codex-plugin', registry: 'https://[2001:db8::1]:4873/', source: 'npm' },
    { package: 'codex-plugin', registry: 'https://[::1]/', source: 'npm' },
    // Git refs follow git check-ref-format: branch, tag, and fully qualified forms.
    ...['release/1.2', 'v1.2.3', 'refs/tags/v1.2.3', 'feature/foo.bar', 'HEAD', 'user/-dash', 'x.lockfile', 'a@b']
      .map((ref) => ({ ref, source: 'url', url: 'https://github.com/example/codex-plugins.git' })),
    // npm version selectors: semver versions, ranges, and dist-tags (npm-package-arg rules), using
    // semver's whitespace grammar (any run of whitespace between comparators, trimmed at the ends).
    ...['1.2.3', '~1.2', '>=1.0.0 <2.0.0', '>=1.0.0  <2.0.0', '>=1.0.0\t<2.0.0', '>= 1.0.0', '~ 1.2', ' 1.2.3 ', '1.2.3 - 2.3.4', '1.0.0  -  2.0.0', '1.x', '*', '>=1.0.0-beta.1', '1.0.0+build.5', '^1 || ^2', '^1||^2', 'v1.2.3', '=1.2.3', 'next', 'beta-2', 'rc.1']
      .map((version) => ({ package: 'codex-plugin', source: 'npm', version })),
  );
  expect(validate(admitted), JSON.stringify(validate.errors)).toBe(true);

  const rejected: readonly unknown[] = [
    '../outside',
    'plugins/my-plugin',
    { path: './plugins/../../outside', source: 'local' },
    { path: '.\\plugins\\my-plugin', source: 'local' },
    // Line terminators must not let a parent segment slip past the containment lookahead.
    './x\n/../../outside',
    { path: './x\n/../../outside', source: 'local' },
    { path: './x\r\n/../../outside', source: 'local' },
    { path: './x\u2028/../../outside', source: 'local' },
    { path: './plugins/my\u0000plugin', source: 'local' },
    { path: './x\n/../../outside', ref: 'main', source: 'git-subdir', url: 'https://github.com/example/codex-plugins.git' },
    { source: 'url', url: 'file:///tmp/plugins' },
    // Scheme-prefix matches with an unusable authority or path are not URLs.
    { source: 'url', url: 'https://%zz/repository.git' },
    { source: 'url', url: 'https://' },
    { source: 'url', url: 'https://github.com' },
    { source: 'url', url: 'https://github.com/example/codex%2plugins.git' },
    { source: 'url', url: 'https://git hub.com/example/codex-plugins.git' },
    { source: 'url', url: 'https://-github.com/example/codex-plugins.git' },
    { source: 'url', url: 'https://github.com:port/example/codex-plugins.git' },
    { source: 'url', url: 'https://github.com:65536/example/codex-plugins.git' },
    { source: 'url', url: 'https://github.com:99999/example/codex-plugins.git' },
    { source: 'url', url: 'ssh://git@github.com:65536/example/codex-plugins.git' },
    { source: 'url', url: 'https://github.com/example/codex-plugins.git?ref=main' },
    { source: 'url', url: 'ssh://%zz/repository.git' },
    { source: 'url', url: 'ssh://github.com' },
    { source: 'url', url: 'git@%zz:example/codex-plugins.git' },
    { source: 'url', url: 'git@github.com:' },
    { source: 'url', url: 'git@github.com:example/codex plugins.git' },
    // Credentials still cannot mask a bad authority, contain raw spaces or bad escapes, or repeat "@".
    { source: 'url', url: 'https://user:token@/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:to ken@git.example.test/team/codex-plugins.git' },
    { source: 'url', url: 'https://us%zzer@git.example.test/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:token@%zz/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:token@github.com:65536/team/codex-plugins.git' },
    { source: 'url', url: 'https://user:token@999.999.999.999/team/codex-plugins.git' },
    { source: 'url', url: 'https://a@b@github.com/team/codex-plugins.git' },
    { source: 'url', url: 'https://github.com/example/codex-plugins.git', sha: 'not-hex' },
    { source: 'git-subdir', url: 'https://github.com/example/codex-plugins.git' },
    { path: './plugins/remote-helper', source: 'git-subdir', url: 'https://%zz/repository.git' },
    { package: '@example/codex-plugin', registry: 'https://%zz/', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://registry.example.test:port', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://registry.example.test:65536', source: 'npm' },
    // Numeric authorities must be in-range dotted-quad IPv4; a last label of digits is not a DNS host.
    { source: 'url', url: 'https://999.999.999.999/team/plugin.git' },
    { source: 'url', url: 'https://256.1.1.1/team/plugin.git' },
    { source: 'url', url: 'https://1.2.3/team/plugin.git' },
    { source: 'url', url: 'https://1.2.3.4.5/team/plugin.git' },
    { source: 'url', url: 'https://example.123/team/plugin.git' },
    { source: 'url', url: 'git@999.999.999.999:team/plugin.git' },
    { source: 'url', url: 'ssh://999.999.999.999/team/plugin.git' },
    { package: '@example/codex-plugin', registry: 'https://999.999.999.999/', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://example.123/', source: 'npm' },
    // IPv6 literals must be bracketed, well-formed, and at most eight groups.
    { source: 'url', url: 'https://[2001:db8::1/team/plugin.git' },
    { source: 'url', url: 'https://[zz::1]/team/plugin.git' },
    { source: 'url', url: 'https://[1:2:3:4:5:6:7:8:9]/team/plugin.git' },
    { source: 'url', url: 'https://[1:2:3:4:5:6:7]/team/plugin.git' },
    { source: 'url', url: 'https://[]/team/plugin.git' },
    { source: 'url', url: 'https://2001:db8::1/team/plugin.git' },
    { package: '@example/codex-plugin', registry: 'https://[2001:db8::1', source: 'npm' },
    { package: '@example/codex-plugin', registry: 'https://[1:2:3:4:5:6:7:8:9]/', source: 'npm' },
    // Selectors npm rejects with EINVALIDTAGNAME or as unparseable ranges.
    ...['foo bar', '%', '', '1.2.3 || foo bar', '>=1.0.0 <', 'latest@1', 'a/b', 'a:b', 'a#b', 'a?b', '1.0.0 -2.0.0']
      .map((version) => ({ package: '@example/codex-plugin', source: 'npm', version })),
    // Dot-prefixed selectors are directory specs to npm-package-arg, not dist-tags.
    ...['.', '..', '.foo', '.latest'].map((version) => ({ package: '@example/codex-plugin', source: 'npm', version })),
    // Refs git check-ref-format refuses (control characters, "..", "@{", ".lock", leading "-", empty components).
    ...['', 'foo bar', 'foo..bar', 'foo@{1}', '@', '-main', 'main.lock', 'a.lock/b', 'refs/heads/', '/main', 'a//b', 'main.', '.hidden', 'a/.b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\tb', 'a\u007fb', 'a\nb']
      .flatMap((ref) => [
        { ref, source: 'url', url: 'https://github.com/example/codex-plugins.git' },
        { path: './plugins/remote-helper', ref, source: 'git-subdir', url: 'https://github.com/example/codex-plugins.git' },
      ]),
    { package: '@example/codex-plugin', registry: 'https://registry.example.test/a b', source: 'npm' },
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
  { code: 'codex.marketplace.policy.installation.not-installable', value: { policy: { installation: 'NOT_AVAILABLE' } } },
] as const)('rejects invalid authored Codex marketplace input with $code', ({ code, value }) => {
  const rejected = emittedMarketplace(withCodexConfig({ marketplace: value }));

  expect(rejected.codes).toContain(code);
  expect(rejected.document).toBeUndefined();
});

it('records the overview-level plugin parts (optional MCP UI, browser extensions, scheduled task templates) as dated rows', () => {
  const registry = createDefaultRegistry();
  const table = codexCapabilityTable.plugin.overviewSurfaces as Readonly<Record<string, {
    readonly evidence: readonly string[];
    readonly reason: string;
    readonly state: string;
  }>>;
  const expected = { browserExtensions: 'unavailable', mcpUi: 'degraded', scheduledTaskTemplates: 'unavailable' } as const;

  expect(Object.keys(table).sort()).toEqual(Object.keys(expected).sort());
  for (const [capability, expectedState] of Object.entries(expected)) {
    const row = table[capability]!;
    expect(row.state, capability).toBe(expectedState);
    expect(row.evidence.length, capability).toBeGreaterThan(1);
    expect(row.evidence.every((line) => /^(?:retrieved|observed) 2026-09-03:/u.test(line)), capability).toBe(true);
    expect(row.reason, capability).toMatch(/\S/u);
    expect(codexAdapter.capabilities[capability]).toMatchObject({
      reason: row.reason,
      state: expectedState,
      ...(expectedState === 'degraded' ? { evidence: { observedVersion: '0.147.0', target: 'codex' } } : {}),
    });
    expect(registry.supports('codex', capability)).toBe(false);
  }
  // No authoring field is inferred: the closed manifest schema rejects any attempt.
  expect(table.mcpUi!.evidence.some((line) => line.includes('_meta.ui.resourceUri'))).toBe(true);
  expect(table.browserExtensions!.reason).toContain('no schema-backed authoring field');
  expect(table.scheduledTaskTemplates!.reason).toContain('no schema-backed authoring field');
});

it('keeps NOT_AVAILABLE documented in the pinned schema but refuses it for the self-installing artifact', () => {
  // Live codex-cli 0.147.0 registers a NOT_AVAILABLE marketplace entry and then refuses
  // `codex plugin add <plugin>@<marketplace>`, the exact command INSTALL.md and installBundle() run.
  expect(codexCapabilityTable.marketplace.policy.notInstallable).toBe('NOT_AVAILABLE');
  expect(codexCapabilityTable.distribution.marketplacePolicy).toMatchObject({
    evidence: expect.arrayContaining([expect.stringContaining('is not available for install in marketplace')]),
    rejected: ['NOT_AVAILABLE'],
  });
  const validate = createAdapterValidator().compile(marketplaceSchema);
  expect(validate({
    ...marketplace('./'),
    plugins: [{ ...entry('./'), policy: { authentication: 'ON_INSTALL', installation: 'NOT_AVAILABLE' } }],
  })).toBe(true);

  const rejected = emittedMarketplace(withCodexConfig({ marketplace: { policy: { installation: 'NOT_AVAILABLE' } } }));
  expect(rejected.codes).toEqual(['codex.marketplace.policy.installation.not-installable']);
  expect(rejected.document).toBeUndefined();
  for (const installation of ['AVAILABLE', 'INSTALLED_BY_DEFAULT']) {
    const admitted = emittedMarketplace(withCodexConfig({ marketplace: { policy: { installation } } }));
    expect(admitted.codes).toEqual([]);
    expect(admitted.document).toMatchObject({ plugins: [{ policy: { authentication: 'ON_INSTALL', installation } }] });
  }
});
