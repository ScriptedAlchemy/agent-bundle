import { expect, it } from '@rstest/core';

import {
  classifyDependency,
  isWorkspaceProtocol,
  declarationSpecifiers,
  packageNameOf,
  rewritesWorkspaceProtocols,
  shellWords,
} from '../src/build/pack-dependencies.ts';
import { declaredDependencies, isBarePackageName } from '../src/core/package-dependencies.ts';

it.each([
  // Registry: versions, ranges (npm's loose grammar included), and dist-tags.
  ['^1.2.3', 'registry'],
  ['~1.2.3', 'registry'],
  ['1.2.3', 'registry'],
  ['v1.2.3', 'registry'],
  ['1.2.3-beta.1+build.5', 'registry'],
  ['latest', 'registry'],
  ['next', 'registry'],
  ['', 'registry'],
  ['*', 'registry'],
  ['1.x', 'registry'],
  ['>=1 <2 || 3.x', 'registry'],
  ['>=1, <2', 'registry'],
  ['v=1', 'registry'],
  ['1.2.3 - 2.3.4', 'registry'],
  // An `npm:` alias, its prefix case-insensitive, an absent target being `latest`.
  ['npm:effect@^4.0.0', 'registry'],
  ['npm:@scope/name@latest', 'registry'],
  ['npm:effect', 'registry'],
  ['npm:name@', 'registry'],
  ['NPM:effect@^4', 'registry'],
  // "aliases only work for registry deps": a non-registry target fails the manifest read, as does an unnamed
  // or invalidly named alias.
  ['npm:bar@file:../bar', 'unparseable'],
  ['npm:bar@workspace:*', 'unparseable'],
  ['npm:bar@github:owner/repo', 'unparseable'],
  ['npm:bar@npm:baz@^1', 'unparseable'],
  ['npm:name@foo:bar', 'unparseable'],
  ['npm:name@not a valid spec', 'unparseable'],
  ['npm:bad name@1', 'unparseable'],
  ['npm:', 'unparseable'],
  // Workspace protocols, as written, are unparseable to npm; whether the packer rewrites them is the caller's policy.
  ['workspace:*', 'unparseable'],
  ['catalog:', 'unparseable'],
  // Git, over every transport npm knows; any other `git+x` is unsupported.
  ['git+ssh://git@github.com/owner/repo.git', 'fetched'],
  ['git+https://github.com/owner/repo.git', 'fetched'],
  ['git+ftp://host/repo', 'fetched'],
  ['git+rsync://host/repo', 'fetched'],
  ['git://github.com/owner/repo.git', 'fetched'],
  ['git:', 'fetched'],
  ['git+foo://host/repo', 'unparseable'],
  // scp-style: only a host npm recognises parses; `git@host:path` is read as an invalid dist-tag.
  ['git@github.com:owner/repo.git', 'fetched'],
  ['git@host:path', 'unparseable'],
  // Hosted shorthands; an empty one parses, a malformed one does not.
  ['github:owner/repo#131f4b6', 'fetched'],
  ['gitlab:owner/repo', 'fetched'],
  ['bitbucket:owner/repo', 'fetched'],
  ['gist:deadbeef', 'fetched'],
  ['github:', 'fetched'],
  ['github:%zz', 'unparseable'],
  ['owner/repo', 'fetched'],
  ['owner/repo#semver:^1', 'fetched'],
  // Remote tarballs, when the URL is one.
  ['https://pkg.pr.new/owner/repo/@scope/name@42539ff', 'fetched'],
  ['http://example.test/name.tgz', 'fetched'],
  ['http:%zz', 'unparseable'],
  ['https://', 'unparseable'],
  // Paths: `file:`, relative, absolute, home, Windows drive, bare tarball, bare directory.
  ['file:../local', 'fetched'],
  ['file:', 'fetched'],
  ['./vendor/dep', 'fetched'],
  ['../vendor/dep', 'fetched'],
  ['/opt/vendor/dep', 'fetched'],
  ['~/vendor/dep', 'fetched'],
  ['C:\\vendor\\dep', 'fetched'],
  ['c:/vendor/dep', 'fetched'],
  ['foo.tgz', 'fetched'],
  ['foo.tar', 'fetched'],
  ['vendor/foo/bar', 'fetched'],
  // Schemes npm does not support, including other managers' link protocols and a typo.
  ['link:../local', 'unparseable'],
  ['portal:../local', 'unparseable'],
  ['foo:bar', 'unparseable'],
  ['jsr:@scope/name', 'unparseable'],
  // Neither a range nor a URL-safe dist-tag (EINVALIDTAGNAME) — including a value npm reads with its whitespace.
  ['not a valid spec', 'unparseable'],
  ['1.2.3+..', 'unparseable'],
  [' npm:bar@1', 'unparseable'],
])('classifyDependency("name", %j) is %s', (specifier, kind) => {
  expect(classifyDependency('name', specifier)).toBe(kind);
});

it.each([
  // npm validates the dependency key too (EINVALIDPACKAGENAME): scoped or not, URL-safe, no leading `.` or `_`
  // on an unscoped name, and never a reserved name.
  ['name', 'registry'],
  ['@scope/name', 'registry'],
  ['some.pkg_name-1~', 'registry'],
  ['UPPER', 'registry'],
  ['@_scope/name', 'registry'],
  ['@.scope/name', 'registry'],
  ['@scope/_name', 'registry'],
  ['bad name', 'unparseable'],
  ['.hidden', 'unparseable'],
  ['_private', 'unparseable'],
  ['@scope', 'unparseable'],
  ['@scope/', 'unparseable'],
  ['name/extra', 'unparseable'],
  ['node_modules', 'unparseable'],
  ['Favicon.ico', 'unparseable'],
])('classifyDependency(%j, "^1") is %s', (name, kind) => {
  expect(classifyDependency(name, '^1')).toBe(kind);
});


it('tells workspace protocols apart and knows which packers rewrite them', () => {
  expect(isWorkspaceProtocol('workspace:*')).toBe(true);
  expect(isWorkspaceProtocol('catalog:default')).toBe(true);
  // No packer rewrites a value that merely contains the protocol; npm then reads it as an invalid dist-tag.
  expect(isWorkspaceProtocol(' catalog:default')).toBe(false);
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
  ['declare module "driver-package" { interface Options { verbose?: boolean } }', ['driver-package']],
  ["declare module 'augmented' {}", ['augmented']],
  ["/// <reference types = '@scope/name' />", ['@scope/name', '@types/scope__name']],
  ['import a from "one"; export { b } from "two"; import c = require("three");', ['one', 'two', 'three']],
  ['declare const n: string;', []],
])('declarationSpecifiers(%j) is %j', (source, specifiers) => {
  expect(declarationSpecifiers(source)).toEqual(specifiers);
});

it.each([
  // Quoted arguments are whole words; adjacent segments join into one.
  ['node "scripts/my install.cjs"', ['node', 'scripts/my install.cjs']],
  ['node --import="./setup.mjs" .', ['node', '--import=./setup.mjs', '.']],
  ["a'b c'\"d e\"f", ['ab cd ef']],
  // Operators split without whitespace; a newline is one too.
  ['node install.js&&echo done', ['node', 'install.js', '&&', 'echo', 'done']],
  ['a || b | c ; d & e\nf', ['a', '||', 'b', '|', 'c', ';', 'd', '&', 'e', '\n', 'f']],
  // Backslash escapes: `"`, `\`, `$`, and a backtick inside double quotes, anything unquoted; nothing single-quoted.
  [String.raw`node -e "require(\"optional-driver\")"`, ['node', '-e', 'require("optional-driver")']],
  [String.raw`echo "\\ \$HOME \` \n"`, ['echo', String.raw`\ $HOME ` + '` \\n']],
  [String.raw`echo \"quoted\" my\ file \\`, ['echo', '"quoted"', 'my file', '\\']],
  [String.raw`echo 'lit\eral' 'no\"escape'`, ['echo', String.raw`lit\eral`, String.raw`no\"escape`]],
  // A backslash-newline continues the line, quoted or not.
  ['echo one\\\ntwo "three\\\nfour"', ['echo', 'onetwo', 'threefour']],
  ['', []],
])('shellWords(%j) is %j', (command, words) => {
  expect(shellWords(command)).toEqual(words);
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

it('drops a peer that dependencies or optionalDependencies also names, whose selector npm never reads', () => {
  expect(declaredDependencies({
    dependencies: { concrete: '^1' },
    optionalDependencies: { optional: '^1' },
    peerDependencies: { concrete: 'not a valid spec', optional: 'file:../optional', 'peer-only': '^1' },
  })).toEqual([
    { bundled: false, field: 'dependencies', installed: true, name: 'concrete', specifier: '^1' },
    { bundled: false, field: 'optionalDependencies', installed: true, name: 'optional', specifier: '^1' },
    { bundled: false, field: 'peerDependencies', installed: true, name: 'peer-only', specifier: '^1' },
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

it('reads a bare package name as npm does: a name with no selector, subpath, path, or scheme', () => {
  expect(['sharp', '@scope/name', 'JSONStream'].filter(isBarePackageName)).toEqual(['sharp', '@scope/name', 'JSONStream']);
  expect(['sharp/lib', '@scope/name/sub', 'sharp@1', './x', 'node:fs', 'npm:foo', 'bad name', '@scope/', ''].filter(isBarePackageName)).toEqual([]);
});
