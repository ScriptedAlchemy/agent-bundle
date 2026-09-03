import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RspressPlugin } from '@rspress/core';

const MARKDOWN_EXTENSION = '.md';

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectMarkdownFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readDirectory(directory);
  const collected: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      collected.push(...(await collectMarkdownFiles(path.join(directory, entry.name), relativePath)));
      continue;
    }

    if (entry.name.endsWith(MARKDOWN_EXTENSION)) {
      collected.push(relativePath);
    }
  }

  return collected;
}

async function prunePlaceholderDirectories(directory: string): Promise<boolean> {
  const entries = await readDirectory(directory);
  let isEmpty = true;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      isEmpty = false;
      continue;
    }

    const child = path.join(directory, entry.name);
    if (await prunePlaceholderDirectories(child)) {
      await rm(child, { recursive: true, force: true });
    } else {
      isEmpty = false;
    }
  }

  return isEmpty;
}

/**
 * Remove generated Markdown from an API directory while leaving the committed
 * `_meta.json` sidebar in place, so a removed package export cannot survive as
 * a phantom route.
 */
export async function cleanGeneratedApiMarkdown(directory: string): Promise<void> {
  for (const relativePath of await collectMarkdownFiles(directory)) {
    await rm(path.join(directory, relativePath), { force: true });
  }

  await prunePlaceholderDirectories(directory);
}

export interface MirrorApiLocaleOptions {
  /** Docs-root-relative directory that TypeDoc generates, such as `en/api`. */
  sourceDir: string;
  /** Docs-root-relative directories that receive the mirrored Markdown. */
  targetDirs: string[];
}

/**
 * Mirror the TypeDoc reference into the remaining locale roots.
 *
 * Symbols, signatures, and source comments are one package-level contract, so
 * a single TypeDoc run is copied instead of paying for a second TypeScript
 * program. Only `.md` files travel: each locale keeps its own translated
 * `_meta.json` sidebar.
 *
 * Must be registered immediately after `pluginTypeDoc` so the `config` hook
 * runs once the English reference has been written and before route scanning.
 */
export function mirrorApiLocale(options: MirrorApiLocaleOptions): RspressPlugin {
  const { sourceDir, targetDirs } = options;

  return {
    name: 'agent-bundle/mirror-api-locale',
    async config(config) {
      const docsRoot = config.root;
      if (!docsRoot) {
        return config;
      }

      const source = path.join(docsRoot, sourceDir);
      const generatedFiles = await collectMarkdownFiles(source);

      for (const targetDir of targetDirs) {
        const target = path.join(docsRoot, targetDir);
        await cleanGeneratedApiMarkdown(target);

        for (const relativePath of generatedFiles) {
          const destination = path.join(target, relativePath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(path.join(source, relativePath), destination);
        }
      }

      return config;
    },
  };
}
