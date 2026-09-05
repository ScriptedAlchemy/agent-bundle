import { cp, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';

/**
 * Emitted artifacts never bundle the yieldable framework error bases
 * (`src/effect/errors.ts`, the `Data.Error` twins of `Error` / `CodedError`).
 *
 * `examples/host-test` emits every artifact class the framework produces:
 * per-event hook wrappers, the hooks Flight worker, CLI bins plus their
 * Flight worker, the framework MCP lifecycle shell plus its Flight worker, a
 * hand-rolled stdio MCP server, and the `install.mjs` script. The classes
 * that already carry the Effect runtime (hook wrappers, bins, framework MCP
 * shell) do so through `src/effect/boundary.ts`, whose coded base is the
 * plain `CodedError`; the classes without Effect (raw stdio server,
 * `install.mjs`) must stay without it. A byte-size gate cannot see a 12 kB
 * delta inside a 2.4 MB unminified wrapper, so this test pins the invariant
 * itself: no emitted file contains the yieldable base, Effect-free classes
 * stay Effect-free, and the wrapper runtime's coded base stays plain.
 */

/** `Symbol.for` key Effect's `Data.Error` registers; present iff Effect's core is bundled. */
const effectCoreMarker = 'effect/Data/Error/plainArgs';
const yieldableBasePattern = /Yieldable(?:Coded|Framework)Error/u;
const plainCodedBase = 'class CodedError extends Error';

type ArtifactClass =
  | 'cli-bin'
  | 'cli-bin-flight-worker'
  | 'hook-flight-worker'
  | 'hook-wrapper'
  | 'install-script'
  | 'mcp-flight-worker'
  | 'mcp-framework-shell'
  | 'mcp-raw-stdio-server';

// Compiled surfaces sit directly under the composite root: `<kind>/<file>` (#555).
const classify = (relativePath: string): ArtifactClass | undefined => {
  const [kind, file] = relativePath.split('/');
  if (kind === 'install.mjs' && file === undefined) return 'install-script';
  if (file === undefined || !file.endsWith('.mjs')) return undefined;
  switch (kind) {
    case 'hooks':
      return file === 'hooks-flight.mjs' ? 'hook-flight-worker' : 'hook-wrapper';
    case 'bin':
      return file.endsWith('-flight.mjs') ? 'cli-bin-flight-worker' : 'cli-bin';
    case 'mcp':
      if (file.endsWith('-flight.mjs')) return 'mcp-flight-worker';
      return file.startsWith('mcp-host-test-raw-') ? 'mcp-raw-stdio-server' : 'mcp-framework-shell';
    default:
      return undefined;
  }
};

/** Classes whose emitted code carries no Effect runtime at all. */
const effectFreeClasses: ReadonlySet<ArtifactClass> = new Set<ArtifactClass>(['install-script', 'mcp-raw-stdio-server']);
/**
 * Classes whose bundled runtime always includes `src/effect/boundary.ts` and
 * therefore the plain `CodedError` (the framework MCP shell only does so on
 * hosts with an event runtime, so it is checked by the yieldable-base scan
 * alone).
 */
const boundaryClasses: ReadonlySet<ArtifactClass> = new Set<ArtifactClass>(['hook-wrapper']);
const everyClass: readonly ArtifactClass[] = [
  'cli-bin',
  'cli-bin-flight-worker',
  'hook-flight-worker',
  'hook-wrapper',
  'install-script',
  'mcp-flight-worker',
  'mcp-framework-shell',
  'mcp-raw-stdio-server',
];

interface EmittedFile {
  readonly artifactClass: ArtifactClass;
  readonly bytes: number;
  readonly content: string;
  readonly relativePath: string;
}

const listFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
};

let projectRoot: string | undefined;
let emitted: readonly EmittedFile[] = [];

beforeAll(async () => {
  const exampleRoot = join(process.cwd(), 'examples', 'host-test');
  projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-emitted-artifact-effect-surface-'));
  // Only what the build reads: the example's tsconfig extends the workspace
  // root and its tests / scripts are not artifact inputs.
  const inputs = new Set(['', 'agent-bundle.config.ts', 'package.json', 'src']);
  await cp(exampleRoot, projectRoot, {
    filter: (source) => inputs.has(relative(exampleRoot, source).split('/')[0] ?? ''),
    recursive: true,
  });
  await symlink(join(exampleRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  const artifactRoot = join(projectRoot, 'artifact');
  const result = await build({ output: artifactRoot, root: projectRoot });
  expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const files: EmittedFile[] = [];
  for (const relativePath of await listFiles(artifactRoot)) {
    const artifactClass = classify(relativePath);
    if (artifactClass === undefined) continue;
    const content = await readFile(join(artifactRoot, relativePath), 'utf8');
    files.push({ artifactClass, bytes: Buffer.byteLength(content), content, relativePath });
  }
  emitted = files;
}, 240_000);

afterAll(async () => {
  if (projectRoot !== undefined) await rm(projectRoot, { force: true, recursive: true });
});

describe('emitted artifacts and the yieldable framework error bases', () => {
  it('emits every artifact class the invariant covers', () => {
    const present = new Set(emitted.map((file) => file.artifactClass));
    expect([...present].sort()).toEqual(everyClass);
  });

  it('never bundles src/effect/errors.ts into an emitted artifact', () => {
    const offenders = emitted
      .filter((file) => yieldableBasePattern.test(file.content))
      .map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it('keeps the Effect-free artifact classes free of the Effect runtime', () => {
    const offenders = emitted
      .filter((file) => effectFreeClasses.has(file.artifactClass) && file.content.includes(effectCoreMarker))
      .map((file) => file.relativePath);
    expect(offenders).toEqual([]);
  });

  it('keeps the wrapper runtime on the plain CodedError base', () => {
    const missing = emitted
      .filter((file) => boundaryClasses.has(file.artifactClass) && !file.content.includes(plainCodedBase))
      .map((file) => file.relativePath);
    expect(missing).toEqual([]);
  });

  it('reports one size per artifact class for the PR record', () => {
    const byClass = new Map<ArtifactClass, number>();
    for (const file of emitted) {
      byClass.set(file.artifactClass, Math.max(byClass.get(file.artifactClass) ?? 0, file.bytes));
    }
    for (const artifactClass of everyClass) {
      expect(byClass.get(artifactClass)).toBeGreaterThan(0);
    }
  });
});
