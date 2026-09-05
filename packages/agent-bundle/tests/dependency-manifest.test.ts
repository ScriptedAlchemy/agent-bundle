import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { dependencyManifestPath } from '../src/core/dependency-manifest.ts';

const roots: string[] = [];

/** A fresh temporary tree, realpath'd so the pnpm expectation below compares real paths like for like. */
const temporaryRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-dependency-manifest-')));
  roots.push(root);
  return root;
};

/** Writes `<packageDirectory>/package.json` for `name`, creating the directory, and returns the manifest path. */
const writeManifest = async (packageDirectory: string, name: string): Promise<string> => {
  await mkdir(packageDirectory, { recursive: true });
  const manifest = join(packageDirectory, 'package.json');
  await writeFile(manifest, `${JSON.stringify({ name, version: '1.0.0' })}\n`);
  return manifest;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('dependencyManifestPath', () => {
  it('finds the manifest in the node_modules of the package root itself', async () => {
    const root = await temporaryRoot();
    const manifest = await writeManifest(join(root, 'node_modules', 'left-pad'), 'left-pad');

    await expect(dependencyManifestPath(root, 'left-pad')).resolves.toBe(manifest);
  });

  it('walks up to the ancestor node_modules where hoisting placed a scoped package', async () => {
    const parent = await temporaryRoot();
    const manifest = await writeManifest(join(parent, 'node_modules', '@scope', 'pkg'), '@scope/pkg');
    const app = join(parent, 'app');
    // A nearer node_modules without the package does not end the walk.
    await mkdir(join(app, 'node_modules'), { recursive: true });

    await expect(dependencyManifestPath(app, '@scope/pkg')).resolves.toBe(manifest);
  });

  it('returns undefined when no ancestor node_modules has the package', async () => {
    const root = await temporaryRoot();
    await writeManifest(join(root, 'node_modules', 'other'), 'other');
    await mkdir(join(root, 'app'), { recursive: true });

    await expect(dependencyManifestPath(join(root, 'app'), 'left-pad')).resolves.toBeUndefined();
    await expect(dependencyManifestPath(root, '@scope/pkg')).resolves.toBeUndefined();
  });

  it('returns the path through a symlinked package directory (the pnpm layout) and leaves realpath to the caller', async () => {
    const root = await temporaryRoot();
    const real = await writeManifest(join(root, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg'), 'pkg');
    await symlink(join('.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg'), join(root, 'node_modules', 'pkg'), 'dir');

    const located = await dependencyManifestPath(root, 'pkg');
    expect(located).toBe(join(root, 'node_modules', 'pkg', 'package.json'));
    // The link is where Node would find the package too; `declaredDependencyRoots` realpaths it.
    expect(located === undefined ? undefined : await realpath(located)).toBe(real);
  });
});
