import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

import { serializeRuntimeDefinition } from './serialize-definition.js';

const executableAssets = [
  { name: 'hook', path: 'hook/index.js' },
  { name: 'rsc-worker', path: 'rsc/index.js' },
  { name: 'stdio', path: 'mcp/stdio.js' },
  { name: 'http', path: 'mcp/http.js' },
] as const;

const normalizeRuntimeAsset = (asset: unknown): string => {
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

const readRuntimeAssets = async (distPath: string): Promise<string[]> => {
  const contents = await readFile(join(distPath, 'runtime-assets.json'), 'utf8');
  const parsed = JSON.parse(contents) as { allFiles?: unknown };
  if (!Array.isArray(parsed.allFiles)) {
    throw new Error('runtime-assets.json must contain allFiles');
  }

  const root = resolve(distPath);
  const assets = parsed.allFiles.map(normalizeRuntimeAsset);
  await Promise.all(assets.map(async (asset) => {
    const target = resolve(root, asset);
    const pathFromRoot = relative(root, target);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) {
      throw new Error(`Runtime asset escapes its root: ${asset}`);
    }
    await access(target);
  }));
  return assets;
};

export const emitRuntimeArtifacts = async (distPath: string): Promise<void> => {
  const runtimeAssets = await readRuntimeAssets(distPath);
  for (const executable of executableAssets) {
    if (!runtimeAssets.includes(executable.path)) {
      throw new Error(`runtime-assets.json is missing executable: ${executable.path}`);
    }
  }

  const manifest = {
    ...serializeRuntimeDefinition(),
    executables: executableAssets,
    runtimeAssets,
    schemaVersion: 1,
  };

  await mkdir(distPath, { recursive: true });
  await writeFile(join(distPath, 'agent-runtime.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};
