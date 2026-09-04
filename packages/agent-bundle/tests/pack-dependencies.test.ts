import { expect, it } from '@rstest/core';

import {
  declaredDependencies,
  isRegistrySpecifier,
  packageNameOf,
  rewritesWorkspaceProtocols,
} from '../src/build/pack-dependencies.ts';

const npm = { workspaceProtocols: false };

it.each([
  // Registry: semver ranges, dist-tags, and protocols the workspace manager rewrites at publish time.
  ['^1.2.3', true],
  ['~1.2.3', true],
  ['~1.2', true],
  ['1.2.3', true],
  ['latest', true],
  ['>=1 <2 || 3.x', true],
  ['npm:effect@^4.0.0', true],
  // Workspace protocols are registry specifiers only when the packer rewrites them (see below).
  ['workspace:*', false],
  ['catalog:', false],
  // Git.
  ['git+ssh://git@github.com/owner/repo.git', false],
  ['git+https://github.com/owner/repo.git', false],
  ['git://github.com/owner/repo.git', false],
  ['git@github.com:owner/repo.git', false],
  ['github:owner/repo#131f4b6', false],
  ['gitlab:owner/repo', false],
  ['bitbucket:owner/repo', false],
  ['gist:deadbeef', false],
  ['owner/repo', false],
  ['owner/repo#semver:^1', false],
  // Remote tarballs.
  ['https://pkg.pr.new/owner/repo/@scope/name@42539ff', false],
  ['http://example.test/name.tgz', false],
  // Paths.
  ['file:../local', false],
  ['link:../local', false],
  ['portal:../local', false],
  ['./vendor/dep', false],
  ['../vendor/dep', false],
  ['/opt/vendor/dep', false],
  ['~/vendor/dep', false],
  ['C:\\vendor\\dep', false],
  ['c:/vendor/dep', false],
])('isRegistrySpecifier(%j) under npm is %s', (specifier, registry) => {
  expect(isRegistrySpecifier(specifier, npm)).toBe(registry);
});

it('accepts workspace protocols only for a packer that rewrites them', () => {
  const pnpm = { workspaceProtocols: true };
  expect(isRegistrySpecifier('workspace:*', pnpm)).toBe(true);
  expect(isRegistrySpecifier('catalog:default', pnpm)).toBe(true);
  expect(isRegistrySpecifier('github:owner/repo', pnpm)).toBe(false);
  expect(rewritesWorkspaceProtocols('pnpm/10.18.0 npm/? node/v24.0.0 linux x64')).toBe(true);
  expect(rewritesWorkspaceProtocols('yarn/4.9.1 npm/? node/v24.0.0 linux x64')).toBe(true);
  expect(rewritesWorkspaceProtocols('bun/1.2.0 npm/? node/v24.0.0 linux x64')).toBe(true);
  expect(rewritesWorkspaceProtocols('npm/11.4.2 node/v24.0.0 linux x64 workspaces/false')).toBe(false);
  expect(rewritesWorkspaceProtocols(undefined)).toBe(false);
});

it.each([
  ['effect', 'effect'],
  ['effect/Function', 'effect'],
  ['@scope/name', '@scope/name'],
  ['@scope/name/deep/path.js', '@scope/name'],
  ['left-pad/lib/index.js', 'left-pad'],
  // Not a package.
  ['./a.mjs', undefined],
  ['../a.mjs', undefined],
  ['/abs/a.mjs', undefined],
  ['#internal', undefined],
  ['node:fs', undefined],
  ['fs', undefined],
  ['data:text/javascript,export default 1', undefined],
  ['file:///tmp/a.mjs', undefined],
  ['C:\\a.mjs', undefined],
  ['@scope', undefined],
  ['@scope/', undefined],
  ['', undefined],
])('packageNameOf(%j) is %j', (specifier, name) => {
  expect(packageNameOf(specifier)).toBe(name);
});

it('lists installed-dependency fields only, skipping non-string specifiers and optional peers', () => {
  expect(declaredDependencies({
    dependencies: { a: '^1', broken: 1 },
    devDependencies: { ignored: '^1' },
    optionalDependencies: 'not an object',
    peerDependencies: { b: 'workspace:*', optional: '^2' },
    peerDependenciesMeta: { optional: { optional: true } },
  })).toEqual([
    { field: 'dependencies', name: 'a', specifier: '^1' },
    { field: 'peerDependencies', name: 'b', specifier: 'workspace:*' },
  ]);
});
