import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { TargetArtifactWrite } from '../src/adapters/types.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const modelFor = (target: string): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    description: 'Checks host installation.',
    id: 'plugin:install-fixture',
    name: 'install-fixture',
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
    version: '1.2.3',
  },
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: `target:${target}`,
    name: target,
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
  }],
});

const writesFor = (target: string): ReadonlyMap<string, string> => {
  const plan = createDefaultRegistry().get(target).plan(modelFor(target));
  return new Map(plan.entries
    .filter((entry): entry is TargetArtifactWrite => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]));
};

it.each(['claude', 'codex', 'cursor', 'portable', 'plugin'])(
  'emits a concrete INSTALL.md for the %s target',
  (target) => {
    const install = writesFor(target).get('INSTALL.md');

    expect(install).toContain('# Install install-fixture');
    expect(install).toContain('Version: `1.2.3`');
    expect(install).not.toContain('<plugin>');
    expect(install).not.toContain('<marketplace>');
    expect(install).not.toContain('<scope>');
  },
);

it('emits always-installable Claude and Codex local marketplaces with exact commands', () => {
  const claude = writesFor('claude');
  const codex = writesFor('codex');

  expect(JSON.parse(claude.get('.claude-plugin/marketplace.json')!)).toMatchObject({
    name: 'install-fixture-marketplace',
    plugins: [{ name: 'install-fixture', source: './', version: '1.2.3' }],
  });
  expect(claude.get('INSTALL.md')).toContain('claude plugin marketplace add .');
  expect(claude.get('INSTALL.md')).toContain(
    'claude plugin install install-fixture@install-fixture-marketplace --scope user',
  );

  expect(JSON.parse(codex.get('.agents/plugins/marketplace.json')!)).toMatchObject({
    name: 'install-fixture-marketplace',
    plugins: [{ name: 'install-fixture', source: { path: './', source: 'local' } }],
  });
  expect(codex.get('INSTALL.md')).toContain('codex plugin marketplace add .');
  expect(codex.get('INSTALL.md')).toContain(
    'codex plugin add install-fixture@install-fixture-marketplace',
  );
});

it('emits a standalone safe-copy installer only for Cursor-compatible fallback profiles', () => {
  for (const target of ['cursor', 'portable', 'plugin']) {
    const writes = writesFor(target);
    expect(writes.get('INSTALL.md')).toContain('node ./install.mjs');
    expect(writes.get('install.mjs')).toContain("'.cursor', 'plugins', 'local'");
    expect(writes.get('install.mjs')).toContain('install-fixture');
    expect(writes.get('install.mjs')).toContain('1.2.3');
    expect(writes.get('install.mjs')).not.toContain('sudo');
  }
  for (const target of ['claude', 'codex']) {
    expect(writesFor(target).has('install.mjs')).toBe(false);
  }
});

it('documents every real host path from the composite profile', () => {
  const install = writesFor('plugin').get('INSTALL.md');

  expect(install).toContain('claude plugin install install-fixture@install-fixture-marketplace --scope user');
  expect(install).toContain('codex plugin add install-fixture@install-fixture-marketplace');
  expect(install).toContain('node ./install.mjs');
});
