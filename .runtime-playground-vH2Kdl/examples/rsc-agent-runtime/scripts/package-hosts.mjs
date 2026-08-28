/* global process */

import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(exampleRoot, 'dist');
const pluginsRoot = join(distRoot, 'plugins');
const runtimeRoot = join(distRoot, 'runtime');
const appRoot = join(distRoot, 'app');
const packagingRoot = join(exampleRoot, 'packaging');

const assertDirectory = async (path, message) => {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
};

const normalizedRuntimeAsset = (asset) => {
  if (typeof asset !== 'string') {
    throw new Error('runtime-assets.json must contain string paths');
  }
  const stripped = asset.replace(/^[/\\]+/, '');
  const normalized = normalize(stripped);
  if (stripped.length === 0 || isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Runtime asset escapes its root: ${asset}`);
  }
  return normalized;
};

const verifyRuntimeCopy = async (pluginRoot) => {
  const manifestPath = join(pluginRoot, 'runtime', 'runtime-assets.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.allFiles)) {
    throw new Error('runtime-assets.json must contain allFiles');
  }
  const copiedRuntime = resolve(pluginRoot, 'runtime');
  for (const asset of manifest.allFiles) {
    const normalized = normalizedRuntimeAsset(asset);
    const target = resolve(copiedRuntime, normalized);
    if (relative(copiedRuntime, target).startsWith('..')) {
      throw new Error(`Runtime asset escapes copied root: ${asset}`);
    }
    await access(target);
  }
};

const packageHost = async (host) => {
  const source = join(packagingRoot, host);
  const target = join(pluginsRoot, host);
  await cp(source, target, { recursive: true });
  await cp(runtimeRoot, join(target, 'runtime'), { recursive: true });
  await cp(appRoot, join(target, 'app'), { recursive: true });
  if (host === 'codex') {
    await mkdir(join(target, 'skills'), { recursive: true });
  }
  await verifyRuntimeCopy(target);
};

const run = async () => {
  await assertDirectory(runtimeRoot, 'Build dist/runtime before packaging native hosts.');
  await assertDirectory(appRoot, 'Build dist/app before packaging native hosts.');
  await rm(pluginsRoot, { force: true, recursive: true });
  await mkdir(pluginsRoot, { recursive: true });
  await packageHost('claude');
  await packageHost('codex');
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
