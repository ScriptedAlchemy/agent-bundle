import { expect, it } from '@rstest/core';

import {
  declaredDependencies,
  isNpmParseable,
  isRegistrySpecifier,
  isValidPackageName,
  isWorkspaceProtocol,
  declarationSpecifiers,
  packageNameOf,
  rewritesWorkspaceProtocols,
} from '../src/build/pack-dependencies.ts';

it.each([
  // Registry: semver ranges, dist-tags, and protocols the workspace manager rewrites at publish time.
  ['^1.2.3', true],
  ['~1.2.3', true],
  ['~1.2', true],
  ['1.2.3', true],
  ['latest', true],
  ['>=1 <2 || 3.x', true],
  ['npm:effect@^4.0.0', true],
  ['npm:@scope/name@latest', true],
  ['npm:effect', true],
  // An alias only ever points at a registry package; its target is classified too.
  ['npm:bar@file:../bar', false],
  ['npm:bar@workspace:*', false],
  ['npm:bar@github:owner/repo', false],
  ['npm:bar@npm:baz@^1', false],
  // Workspace protocols, as written, are not registry specifiers; whether the packer rewrites them is the caller's policy.
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
  // Schemes npm cannot parse at all (EUNSUPPORTEDPROTOCOL), including a typo.
  ['foo:bar', false],
  ['jsr:@scope/name', false],
  ['npm:name@foo:bar', false],
  // Scheme-less selectors: every range form npm accepts, and URL-safe dist-tags; anything else is EINVALIDTAGNAME.
  ['', true],
  ['*', true],
  ['1.x', true],
  ['>=1.2.3 <2.0.0', true],
  ['1.2.3 - 2.3.4', true],
  ['^1.0.0 || ^2.0.0', true],
  ['v1.2.3', true],
  ['1.2.3-beta.1+build.5', true],
  ['next', true],
  ['not a valid spec', false],
  ['npm:name@not a valid spec', false],
  // A known scheme with nothing after it names no package.
  ['npm:', false],
  ['file:', false],
  ['github:', false],
  ['http:%zz', false],
  // A bare tarball filename is a file source npm reads from disk.
  ['foo.tgz', false],
  ['vendor/foo.tar.gz', false],
  ['foo.tar', false],
])('isRegistrySpecifier(%j) is %s', (specifier, registry) => {
  expect(isRegistrySpecifier(specifier)).toBe(registry);
});

it.each([
  ['^1.2.3', true],
  ['latest', true],
  ['npm:name@^1', true],
  ['github:owner/repo', true],
  ['git+ssh://git@github.com/owner/repo.git', true],
  ['https://example.test/name.tgz', true],
  ['file:../local', true],
  ['C:\\vendor\\dep', true],
  ['workspace:*', false],
  ['catalog:', false],
  ['link:../local', false],
  ['portal:../local', false],
  ['foo:bar', false],
  ['git@github.com:owner/repo.git', true],
  ['owner/repo', true],
  ['../local', true],
  ['not a valid spec', false],
  ['npm:', false],
  ['npm:name@', true],
  ['file:', false],
  ['http:%zz', false],
  ['https://', false],
  ['github:', false],
  ['foo.tgz', true],
])('isNpmParseable(%j) is %s', (specifier, parseable) => {
  expect(isNpmParseable(specifier)).toBe(parseable);
});

it.each([
  ['name', true],
  ['@scope/name', true],
  ['some.pkg_name-1~', true],
  ['UPPER', true], // legacy names npm still installs
  ['bad name', false],
  ['.hidden', false],
  ['_private', false],
  ['@scope', false],
  ['@scope/', false],
  ['name/extra', false],
  ['a'.repeat(215), false],
])('isValidPackageName(%j) is %s', (name, valid) => {
  expect(isValidPackageName(name)).toBe(valid);
});

it('tells workspace protocols apart and knows which packers rewrite them', () => {
  expect(isWorkspaceProtocol('workspace:*')).toBe(true);
  expect(isWorkspaceProtocol(' catalog:default')).toBe(true);
  expect(isWorkspaceProtocol('npm:effect@^4')).toBe(false);
  expect(isWorkspaceProtocol('github:owner/repo')).toBe(false);
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

it.each([
  ['import { a } from "effect";', ['effect']],
  ["import type { ZodType } from 'zod';", ['zod']],
  ['export * from "@scope/name/deep";', ['@scope/name/deep']],
  ['import "side-effect";', ['side-effect']],
  ['type T = import("types-only").T;', ['types-only']],
  ['import x = require("legacy");', ['legacy']],
  ["declare const y: typeof import ( 'spaced' );", ['spaced']],
  // A type directive resolves through the package itself or its DefinitelyTyped package.
  ['/// <reference types="node" />', ['node', '@types/node']],
  ["/// <reference types = '@scope/name' />", ['@scope/name', '@types/scope__name']],
  ['import a from "one"; export { b } from "two"; import c = require("three");', ['one', 'two', 'three']],
  ['declare const n: string;', []],
])('declarationSpecifiers(%j) is %j', (source, specifiers) => {
  expect(declarationSpecifiers(source)).toEqual(specifiers);
});

it('lists installed-dependency fields only, skipping non-string specifiers; optional peers are kept but not installed', () => {
  expect(declaredDependencies({
    dependencies: { a: '^1', broken: 1 },
    devDependencies: { ignored: '^1' },
    optionalDependencies: 'not an object',
    peerDependencies: { b: 'workspace:*', optional: '^2' },
    peerDependenciesMeta: { optional: { optional: true } },
  })).toEqual([
    { bundled: false, field: 'dependencies', installed: true, name: 'a', specifier: '^1' },
    { bundled: false, field: 'peerDependencies', installed: true, name: 'b', specifier: 'workspace:*' },
    { bundled: false, field: 'peerDependencies', installed: false, name: 'optional', specifier: '^2' },
  ]);
});

it('lets an optionalDependencies entry supersede the same name under dependencies', () => {
  expect(declaredDependencies({
    dependencies: { both: 'file:../both', only: '^1' },
    optionalDependencies: { both: '^2' },
  })).toEqual([
    { bundled: false, field: 'dependencies', installed: true, name: 'only', specifier: '^1' },
    { bundled: false, field: 'optionalDependencies', installed: true, name: 'both', specifier: '^2' },
  ]);
});

it('marks bundleDependencies entries, by name list or wholesale, as bundled', () => {
  const dependencies = { embedded: 'file:../embedded', fetched: '^1' };
  expect(declaredDependencies({ bundleDependencies: ['embedded'], dependencies }).map((d) => [d.name, d.bundled])).toEqual([
    ['embedded', true],
    ['fetched', false],
  ]);
  expect(declaredDependencies({ bundledDependencies: ['embedded'], dependencies }).map((d) => d.bundled)).toEqual([true, false]);
  expect(declaredDependencies({ bundleDependencies: true, dependencies }).map((d) => d.bundled)).toEqual([true, true]);
  // npm never packs a node_modules entry for a peer, and `true` covers dependencies only.
  expect(declaredDependencies({
    bundleDependencies: ['peer', 'optional'],
    optionalDependencies: { optional: 'file:../optional' },
    peerDependencies: { peer: 'file:../peer' },
  }).map((d) => [d.name, d.bundled])).toEqual([['optional', true], ['peer', false]]);
  expect(declaredDependencies({ bundleDependencies: true, optionalDependencies: { optional: '^1' } })[0]?.bundled).toBe(false);
});
