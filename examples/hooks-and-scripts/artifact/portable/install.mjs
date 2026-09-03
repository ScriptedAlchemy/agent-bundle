#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginName = "hooks-and-scripts";
const pluginVersion = "1.0.0";
const source = resolve(fileURLToPath(new URL('.', import.meta.url)));
const cursorRoot = join(homedir(), '.cursor');
const installRoot = join(cursorRoot, 'plugins', 'local');
const destination = join(installRoot, pluginName);

const exists = async (path) => {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};

const treeHash = async (root, prefix = '') => {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Refusing unsupported filesystem entry ".".');
  }
  const hash = createHash('sha256');
  const visit = async (relative) => {
    const absolute = join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Refusing unsupported filesystem entry ${JSON.stringify(relative || '.')}.`);
    }
    if (metadata.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(join(relative, name));
      return;
    }
    hash.update(relative.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(absolute));
    hash.update('\0');
  };
  for (const name of (await readdir(root)).sort()) await visit(join(prefix, name));
  return hash.digest('hex');
};

const installedVersion = async () => {
  for (const manifest of ['.cursor-plugin/plugin.json', 'plugin.json']) {
    try {
      const value = JSON.parse(await readFile(join(destination, manifest), 'utf8'));
      if (typeof value.version === 'string') return value.version;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return undefined;
};

if (!(await exists(cursorRoot)) || !(await lstat(cursorRoot)).isDirectory()) {
  throw new Error(`Cursor is not installed in ${cursorRoot}.`);
}
await mkdir(installRoot, { recursive: true });
if (await exists(destination)) {
  const currentVersion = await installedVersion();
  if (currentVersion !== undefined && currentVersion !== pluginVersion) {
    throw new Error(`Refusing version collision at ${destination}: found ${currentVersion}, requested ${pluginVersion}.`);
  }
  if (source === destination || await treeHash(source) === await treeHash(destination)) {
    console.log(`Already installed ${pluginName}@${pluginVersion} at ${destination}`);
    process.exit(0);
  }
  throw new Error(`Refusing content collision at ${destination}.`);
}

const stageParent = await mkdtemp(join(installRoot, `.${basename(destination)}.stage-`));
const stage = join(stageParent, 'bundle');
try {
  await cp(source, stage, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
  await treeHash(stage);
  await rename(stage, destination);
  console.log(`Installed ${pluginName}@${pluginVersion} at ${destination}`);
} finally {
  await rm(stageParent, { force: true, recursive: true });
}
