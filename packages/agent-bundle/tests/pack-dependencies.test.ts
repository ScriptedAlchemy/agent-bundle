import { expect, it } from '@rstest/core';

import { declaredDependencies, isRegistrySpecifier, packageNameOf } from '../src/build/pack-dependencies.ts';

it.each([
  // Registry: semver ranges, dist-tags, and protocols the workspace manager rewrites at publish time.
  ['^1.2.3', true],
  ['1.2.3', true],
  ['latest', true],
  ['>=1 <2 || 3.x', true],
  ['npm:effect@^4.0.0', true],
  ['workspace:*', true],
  ['catalog:', true],
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
])('isRegistrySpecifier(%j) is %s', (specifier, registry) => {
  expect(isRegistrySpecifier(specifier)).toBe(registry);
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

it('lists installed-dependency fields only, skipping non-string specifiers', () => {
  expect(declaredDependencies({
    dependencies: { a: '^1', broken: 1 },
    devDependencies: { ignored: '^1' },
    optionalDependencies: 'not an object',
    peerDependencies: { b: 'workspace:*' },
  })).toEqual([
    { field: 'dependencies', name: 'a', specifier: '^1' },
    { field: 'peerDependencies', name: 'b', specifier: 'workspace:*' },
  ]);
});
