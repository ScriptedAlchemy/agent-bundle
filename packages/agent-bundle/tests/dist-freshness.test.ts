import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  assertFreshDist,
  checkDistFreshness,
  distFreshness,
  formatDistFreshnessFailure,
  isSkippedInputDirectory,
  newestEntry,
  runtimeExampleBuildOutputs,
  workspaceBuildOutputs,
  type DistDescriptor,
  type DistFreshness,
} from '../../../scripts/dist-freshness.mjs';

const workspaceRoot = process.cwd();

/** Fixture clock: sources written first, dist built after, then one later edit. */
const sourceTime = new Date('2026-01-01T00:00:00Z');
const buildTime = new Date('2026-01-02T00:00:00Z');
const editTime = new Date('2026-01-03T00:00:00Z');

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Writes empty files at `paths` (creating directories) under `root`. */
const writeFiles = async (root: string, paths: readonly string[]): Promise<void> => {
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), '');
  }
};

/** Sets `mtime` on `path` and, for a directory, everything beneath it — children first, since creating entries had left the directories at "now". */
const stampTree = async (path: string, mtime: Date): Promise<void> => {
  if ((await lstat(path)).isDirectory()) {
    for (const entry of await readdir(path)) await stampTree(join(path, entry), mtime);
  }
  await utimes(path, mtime, mtime);
};

interface PackageFixture {
  readonly descriptor: DistDescriptor;
  readonly root: string;
}

/**
 * A package whose sources predate its dist: `src` (two levels), the Rslib
 * config, the manifest, a declared-but-absent `tsconfig.json`, and a dist
 * with a nested chunk directory. It sits one level below the temporary
 * root so a test can add a sibling package (`../shared-lib`).
 */
const createPackageFixture = async (): Promise<PackageFixture> => {
  const base = await mkdtemp(join(tmpdir(), 'dist-freshness-'));
  temporaryRoots.push(base);
  const root = join(base, 'pkg');
  await writeFiles(root, ['src/index.ts', 'src/nested/util.ts', 'rslib.config.ts', 'package.json', 'dist/index.js', 'dist/chunks/shared.js']);
  await stampTree(root, sourceTime);
  await stampTree(join(root, 'dist'), buildTime);
  return {
    descriptor: {
      name: 'fixture',
      root,
      inputs: ['src', 'rslib.config.ts', 'package.json', 'tsconfig.json'],
      output: 'dist',
    },
    root,
  };
};

const touch = (path: string, mtime: Date): Promise<void> => utimes(path, mtime, mtime);

describe('distFreshness', () => {
  it('is fresh when every input predates the newest built file, ignoring declared inputs that do not exist', async () => {
    const { descriptor, root } = await createPackageFixture();
    const result = distFreshness(descriptor);
    expect(result.status).toBe('fresh');
    expect(result.output).toBe(join(root, 'dist'));
    expect(new Date(result.newestInput.mtimeMs)).toEqual(sourceTime);
    expect(new Date(result.newestOutput?.mtimeMs ?? 0)).toEqual(buildTime);
    expect(result.newestOutput?.path.startsWith(join(root, 'dist'))).toBe(true);
  });

  it('is stale when a nested source file is newer than the dist, and names that file', async () => {
    const { descriptor, root } = await createPackageFixture();
    await touch(join(root, 'src/nested/util.ts'), editTime);
    const result = distFreshness(descriptor);
    expect(result.status).toBe('stale');
    expect(result.newestInput).toEqual({ mtimeMs: editTime.getTime(), path: join(root, 'src/nested/util.ts') });
  });

  it('is stale when a build config file input is newer than the dist', async () => {
    const { descriptor, root } = await createPackageFixture();
    await touch(join(root, 'rslib.config.ts'), editTime);
    expect(distFreshness(descriptor).status).toBe('stale');
  });

  it('counts input directory mtimes, so a deleted or renamed source is noticed', async () => {
    const { descriptor, root } = await createPackageFixture();
    await touch(join(root, 'src'), editTime);
    const result = distFreshness(descriptor);
    expect(result.status).toBe('stale');
    expect(result.newestInput.path).toBe(join(root, 'src'));
  });

  it('is missing when the dist is absent, empty, or holds only empty directories', async () => {
    const { descriptor, root } = await createPackageFixture();
    await rm(join(root, 'dist'), { recursive: true });
    expect(distFreshness(descriptor)).toMatchObject({ newestOutput: undefined, status: 'missing' });
    await mkdir(join(root, 'dist'));
    expect(distFreshness(descriptor).status).toBe('missing');
    await mkdir(join(root, 'dist/chunks'));
    expect(distFreshness(descriptor).status).toBe('missing');
  });

  it('skips node_modules, dist, .rstest-temp and dot-directories inside inputs', async () => {
    const { descriptor, root } = await createPackageFixture();
    const skipped = ['src/node_modules/dep/index.js', 'src/dist/out.js', 'src/.rstest-temp/chunk.js', 'src/.cache/entry.js'];
    await writeFiles(root, skipped);
    for (const path of skipped) await stampTree(join(root, path, '..'), editTime);
    // Creating the directories moved `src` itself to "now"; put it back so
    // only the skipped trees are newer than the dist.
    await touch(join(root, 'src'), sourceTime);
    const result = distFreshness(descriptor);
    expect(result.status).toBe('fresh');
    expect(new Date(result.newestInput.mtimeMs)).toEqual(sourceTime);
    for (const name of ['node_modules', 'dist', '.rstest-temp', '.git', '.agent-bundle']) {
      expect(isSkippedInputDirectory(name), name).toBe(true);
    }
    for (const name of ['src', 'lib', 'chunks', 'dist-tools']) {
      expect(isSkippedInputDirectory(name), name).toBe(false);
    }
  });

  it('walks an input root that is itself a dist, so a rebuilt workspace dependency flags a bundle that embeds it', async () => {
    const { descriptor, root } = await createPackageFixture();
    await writeFiles(root, ['../shared-lib/dist/index.js']);
    const sharedDist = resolve(root, '../shared-lib/dist');
    await stampTree(sharedDist, editTime);
    const result = distFreshness({ ...descriptor, inputs: [...descriptor.inputs, '../shared-lib/dist'] });
    expect(result.status).toBe('stale');
    // The directory and its file carry the same stamp; either is the evidence.
    expect(result.newestInput.path.startsWith(sharedDist)).toBe(true);
    expect(new Date(result.newestInput.mtimeMs)).toEqual(editTime);
  });

  it('ignores dot-directories inside the dist, so a temp writer there cannot mask staleness', async () => {
    const { descriptor, root } = await createPackageFixture();
    await touch(join(root, 'src/index.ts'), editTime);
    await writeFiles(root, ['dist/.rstest-temp/scratch.js']);
    await stampTree(join(root, 'dist/.rstest-temp'), new Date('2027-01-01T00:00:00Z'));
    const result = distFreshness(descriptor);
    expect(result.status).toBe('stale');
    expect(new Date(result.newestOutput?.mtimeMs ?? 0)).toEqual(buildTime);
  });

  it('rejects a descriptor none of whose inputs exist', async () => {
    const { descriptor } = await createPackageFixture();
    expect(() => distFreshness({ ...descriptor, inputs: ['nope', 'also-nope.ts'] })).toThrow(/none of the 2 declared inputs of fixture exist/u);
  });
});

describe('newestEntry', () => {
  it('returns the file itself for a file, undefined for a missing path, and the newest file of a tree', async () => {
    const { root } = await createPackageFixture();
    expect(newestEntry(join(root, 'package.json'))).toEqual({ mtimeMs: sourceTime.getTime(), path: join(root, 'package.json') });
    expect(newestEntry(join(root, 'missing'))).toBeUndefined();
    await touch(join(root, 'dist/chunks/shared.js'), editTime);
    expect(newestEntry(join(root, 'dist'))).toEqual({ mtimeMs: editTime.getTime(), path: join(root, 'dist/chunks/shared.js') });
  });
});

describe('formatDistFreshnessFailure and assertFreshDist', () => {
  const fresh: DistFreshness = {
    name: 'fresh-package',
    newestInput: { mtimeMs: sourceTime.getTime(), path: '/repo/packages/fresh/src/index.ts' },
    newestOutput: { mtimeMs: buildTime.getTime(), path: '/repo/packages/fresh/dist/index.js' },
    output: '/repo/packages/fresh/dist',
    status: 'fresh',
  };
  const stale: DistFreshness = {
    name: '@agent-bundle/runtime',
    newestInput: { mtimeMs: editTime.getTime(), path: '/repo/packages/rsc-runtime/src/index.ts' },
    newestOutput: { mtimeMs: buildTime.getTime(), path: '/repo/packages/rsc-runtime/dist/index.js' },
    output: '/repo/packages/rsc-runtime/dist',
    status: 'stale',
  };
  const missing: DistFreshness = {
    name: 'agent-bundle-workbench',
    newestInput: { mtimeMs: sourceTime.getTime(), path: '/repo/packages/workbench/src/main.tsx' },
    newestOutput: undefined,
    output: '/repo/packages/workbench/dist',
    status: 'missing',
  };

  it('names every stale or missing output with its evidence and ends with the rebuild instruction', () => {
    const message = formatDistFreshnessFailure([fresh, stale, missing], { relativeTo: '/repo' });
    expect(message).not.toContain('fresh-package');
    expect(message).toContain(
      '  @agent-bundle/runtime: stale — packages/rsc-runtime/src/index.ts (2026-01-03T00:00:00.000Z)'
      + ' is newer than packages/rsc-runtime/dist/index.js (2026-01-02T00:00:00.000Z)',
    );
    expect(message).toContain('  agent-bundle-workbench: missing — packages/workbench/dist has no built files');
    expect(message.endsWith('run `pnpm build`.')).toBe(true);
  });

  it('prints paths outside relativeTo as they are', () => {
    expect(formatDistFreshnessFailure([stale], { relativeTo: '/elsewhere' })).toContain('/repo/packages/rsc-runtime/src/index.ts');
  });

  it('formats an all-fresh result set to the empty string', () => {
    expect(formatDistFreshnessFailure([fresh])).toBe('');
  });

  it('assertFreshDist throws the message for a stale fixture and returns for a fresh one', async () => {
    const { descriptor, root } = await createPackageFixture();
    expect(() => assertFreshDist([descriptor])).not.toThrow();
    await touch(join(root, 'src/index.ts'), editTime);
    expect(() => assertFreshDist([descriptor], { relativeTo: root })).toThrow(
      /^Built output is stale or missing[\s\S]*fixture: stale — src\/index\.ts[\s\S]*run `pnpm build`\.$/u,
    );
    expect(checkDistFreshness([descriptor]).map((result) => result.status)).toEqual(['stale']);
  });
});

describe('workspace descriptors', () => {
  it('lists every dist `pnpm build` produces, in build order, and every declared input exists in the repository', () => {
    const outputs = workspaceBuildOutputs(workspaceRoot);
    expect(outputs.map((output) => output.name)).toEqual([
      'rsc-markdown-stream',
      '@agent-bundle/runtime',
      'agent-bundle-workbench',
      'agent-bundle',
      'create-agent-bundle',
    ]);
    for (const output of outputs) {
      expect(output.output).toBe('dist');
      expect(output.root.startsWith(join(workspaceRoot, 'packages'))).toBe(true);
      for (const input of output.inputs) {
        expect(existsSync(resolve(output.root, input)), `${output.name}: ${input}`).toBe(true);
      }
      expect(output.inputs).toContain('src');
      expect(output.inputs).toContain('package.json');
      expect(output.inputs).toContain('../../pnpm-lock.yaml');
    }
  });

  it('gives agent-bundle the Workbench build inputs its Rslib build copies from', () => {
    const agentBundle = workspaceBuildOutputs(workspaceRoot).find((output) => output.name === 'agent-bundle');
    expect(agentBundle?.inputs).toEqual(expect.arrayContaining(['../workbench/src', '../workbench/index.html', '../workbench/rsbuild.config.ts', '../workbench/THIRD_PARTY_NOTICES']));
    expect(agentBundle?.inputs).not.toContain('../workbench/dist');
  });

  it('describes the runtime example per payload tree, bundling the workspace runtime dists as inputs', () => {
    const outputs = runtimeExampleBuildOutputs(workspaceRoot, ['app', 'runtime']);
    expect(outputs.map((output) => output.output)).toEqual(['dist/app', 'dist/runtime']);
    for (const output of outputs) {
      expect(output.root).toBe(join(workspaceRoot, 'examples/rsc-agent-runtime'));
      expect(output.inputs).toEqual(expect.arrayContaining(['src', 'rsbuild.config.ts', '../../packages/rsc-runtime/dist', '../../packages/rsc-markdown-stream/dist']));
      // The dist inputs may be absent on a cold tree; every tracked input exists.
      for (const input of output.inputs.filter((path) => !path.endsWith('/dist'))) {
        expect(existsSync(resolve(output.root, input)), input).toBe(true);
      }
    }
    expect(runtimeExampleBuildOutputs(workspaceRoot)).toHaveLength(2);
  });
});
