import { globSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import * as poolLists from '../../../rstest.integration-tests.ts';

/**
 * The pools are defined by subtraction: `rstest.unit.config.ts` collects
 * `workspaceTestFileGlob` minus every list `rstest.integration-tests.ts`
 * exports, and each other pool includes exactly one of those lists. Nothing in
 * Rstest checks that a listed path still exists, so a moved or renamed file
 * would silently fall into the non-isolated, parallel unit pool while its
 * stale entry kept excluding nothing — and a file the glob never matched (a
 * `.tsx`, a `.spec.ts`) has no pool at all unless a list names it. This is the
 * interim guard until the suites move into per-pool directories (#566).
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const isGlob = (entry: string): boolean => /[*?[\]{}]/u.test(entry);

const isFile = (entry: string): boolean => {
  try {
    return statSync(resolve(workspaceRoot, entry)).isFile();
  } catch {
    return false;
  }
};

/** Rstest's default exclusions, so a dependency's or build output's tests never count. */
const isBuildOrDependencyPath = (path: string): boolean => /(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path);

const matchingFiles = (pattern: string): readonly string[] => globSync(pattern, {
  cwd: workspaceRoot,
  exclude: (path: string) => isBuildOrDependencyPath(path),
}).filter(isFile).sort();

/** Files a pool entry collects: the entry itself when literal, its matches when a glob. */
const collectedFiles = (entry: string): readonly string[] => (isGlob(entry) ? matchingFiles(entry) : [entry]);

const { workspaceTestFileGlob, ...exportedLists } = poolLists;
const lists = Object.entries(exportedLists) as ReadonlyArray<readonly [string, readonly string[]]>;

it('exports the include glob plus non-empty string lists, so every pool below is actually checked', () => {
  expect(isGlob(workspaceTestFileGlob)).toBe(true);
  expect(lists.length).toBeGreaterThan(0);
  for (const [name, entries] of lists) {
    expect(Array.isArray(entries), `${name} is not an array`).toBe(true);
    expect(entries.length, `${name} is empty`).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry === 'string'), `${name} holds a non-string entry`).toBe(true);
  }
});

describe.each(lists)('%s', (name, entries) => {
  it('lists only files that exist (a moved or deleted test leaves a stale entry)', () => {
    const missing = entries.filter((entry) => !isGlob(entry) && !isFile(entry));
    expect(missing, `${name}: paths that no longer exist`).toEqual([]);
  });

  it('lists only globs that still match at least one file', () => {
    const empty = entries.filter((entry) => isGlob(entry) && collectedFiles(entry).length === 0);
    expect(empty, `${name}: globs that match nothing`).toEqual([]);
  });

  it('lists every entry once', () => {
    const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
    expect(duplicates, `${name}: repeated entries`).toEqual([]);
  });
});

it('assigns every test file to at most one pool', () => {
  const owners = new Map<string, string[]>();
  for (const [name, entries] of lists) {
    for (const file of entries.flatMap(collectedFiles)) {
      owners.set(file, [...(owners.get(file) ?? []), name]);
    }
  }
  const shared = [...owners].filter(([, names]) => names.length > 1).map(([file, names]) => `${file} <- ${names.join(', ')}`);
  expect(shared, 'files collected by more than one pool list').toEqual([]);
});

it('leaves no test file without a pool', () => {
  // Every `.test.ts` the include glob matches has a pool by construction (the
  // unit pool, unless a list claims it); anything else — another extension,
  // another suffix — runs only if a list names it.
  const everyTestFile = matchingFiles('packages/**/tests/**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs,jsx}');
  const collected = new Set([
    ...matchingFiles(workspaceTestFileGlob),
    ...lists.flatMap(([, entries]) => entries.flatMap(collectedFiles)),
  ]);
  const orphans = everyTestFile.filter((file) => !collected.has(file));
  expect(orphans, 'test files no pool collects: add them to a list in rstest.integration-tests.ts or delete them').toEqual([]);
});
