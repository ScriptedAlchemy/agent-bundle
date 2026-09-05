import { globSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

/** Workspace-relative, `/`-separated, whatever the platform hands back. */
const toPosix = (path: string): string => path.split(sep).join('/');

const isGlob = (entry: string): boolean => /[*?[\]{}]/u.test(entry);

const isTestFileName = (name: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name);

const isFile = (entry: string): boolean => {
  try {
    return statSync(resolve(workspaceRoot, entry)).isFile();
  } catch {
    return false;
  }
};

/** What Rstest's default `exclude` prunes, so a dependency's or build output's tests never count. */
const prunedSegments: ReadonlySet<string> = new Set(['node_modules', 'dist', '.idea', '.git', '.cache', '.output', '.temp']);

const isPrunedPath = (path: string): boolean => toPosix(path).split('/').some((segment) => prunedSegments.has(segment));

const matchingFiles = (pattern: string): readonly string[] => globSync(pattern, {
  cwd: workspaceRoot,
  exclude: (path: string) => isPrunedPath(path),
}).map(toPosix).filter(isFile).sort();

/** Files a pool entry collects: the entry itself when literal, its matches when a glob. */
const collectedFiles = (entry: string): readonly string[] => (isGlob(entry) ? matchingFiles(entry) : [entry]);

/**
 * Rstest globs with `dot: true`; Node's `fs.globSync` never enters or returns
 * a dot path and has no option to. The two views agree exactly as long as no
 * test file lives under a hidden path, so this walk — which does see dot
 * paths, and prunes what Rstest prunes — reports every test file that breaks
 * the agreement.
 */
const hiddenTestFiles = (directory: string): readonly string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    if (prunedSegments.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return hiddenTestFiles(path);
    if (!entry.isFile() || !isTestFileName(entry.name)) return [];
    const relativePath = toPosix(relative(workspaceRoot, path));
    return relativePath.split('/').some((segment) => segment.startsWith('.')) ? [relativePath] : [];
  });

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

it('keeps every test file on a visible path, so the glob checks below see what Rstest collects', () => {
  expect(hiddenTestFiles(join(workspaceRoot, 'packages')), 'test files under a hidden path (Rstest collects them; this guard cannot)').toEqual([]);
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
