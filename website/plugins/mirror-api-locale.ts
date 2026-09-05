import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RspressPlugin } from '@rspress/core';

const MARKDOWN_EXTENSION = '.md';
const FRONTMATTER_FENCE = '---';

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

function rspressMemberAnchor(title: string): string {
  return title
    .replace(/\\([\\_*[\]()])/g, '$1')
    .replace(/<[^>]*>/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * TypeDoc reserves some exported names while building its reflection URLs, so
 * links to those `### Member` headings receive a spurious `-1`. Rspress runs
 * github-slugger over the rendered headings instead, where the member's first
 * occurrence has the unsuffixed anchor. Rewrite only such generated links, and
 * only when exactly one heading on the target page — at any depth — produces
 * that anchor: a same-named `##### property` earlier on the page would make
 * the unsuffixed id point at the property, so an ambiguous link is left as
 * TypeDoc wrote it for the build's anchor check to judge.
 */
async function alignTypeDocMemberLinks(directory: string, files: string[]): Promise<void> {
  const memberAnchorCounts = new Map<string, Map<string, number>>();

  for (const relativePath of files) {
    const filePath = path.join(directory, relativePath);
    const markdown = await readFile(filePath, 'utf8');
    const counts = new Map<string, number>();
    const outsideFences = markdown.replace(/^```[\s\S]*?^```[ \t]*$/gm, '');

    for (const match of outsideFences.matchAll(/^#{1,6} (.+)$/gm)) {
      const anchor = rspressMemberAnchor(match[1]);
      counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
    }
    memberAnchorCounts.set(path.resolve(filePath), counts);
  }

  for (const relativePath of files) {
    const filePath = path.join(directory, relativePath);
    const markdown = await readFile(filePath, 'utf8');
    const aligned = markdown.replace(
      /(\]\()([^)\s#]*#)([\p{L}\p{N}_-]+)-\d+(\))/gu,
      (link, opening: string, target: string, anchor: string, closing: string) => {
        const linkedPath = target.slice(0, -1);
        const targetPath = linkedPath
          ? path.resolve(path.dirname(filePath), linkedPath)
          : path.resolve(filePath);
        if (memberAnchorCounts.get(targetPath)?.get(anchor) !== 1) {
          return link;
        }
        return `${opening}${target}${anchor}${closing}`;
      },
    );

    if (aligned !== markdown) {
      await writeFile(filePath, aligned);
    }
  }
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

/**
 * Place `notice` in an `:::info` container directly under the page title.
 *
 * Rspress derives the page title, sidebar label, and prev/next text from the
 * first `# ` line, so the container goes after it, never before. Frontmatter
 * is skipped when present; TypeDoc currently emits none.
 */
function insertNoticeAfterTitle(markdown: string, notice: string, filePath: string): string {
  const lines = markdown.split('\n');
  let searchFrom = 0;

  if (lines[0] === FRONTMATTER_FENCE) {
    const closingFence = lines.indexOf(FRONTMATTER_FENCE, 1);
    if (closingFence === -1) {
      throw new Error(`${filePath}: frontmatter is never closed, cannot place the locale notice`);
    }
    searchFrom = closingFence + 1;
  }

  const titleIndex = lines.findIndex((line, index) => index >= searchFrom && line.startsWith('# '));
  if (titleIndex === -1) {
    throw new Error(`${filePath}: no "# " title to place the locale notice under`);
  }

  lines.splice(titleIndex + 1, 0, '', ':::info', notice, ':::');
  return lines.join('\n');
}

export interface MirrorApiLocaleTarget {
  /** Docs-root-relative directory that receives the mirrored Markdown. */
  dir: string;
  /**
   * Markdown placed in an `:::info` container under every mirrored page's
   * title, written in the target locale's language: the body stays English,
   * and this is where the reader is told so.
   */
  notice?: string;
}

export interface MirrorApiLocaleOptions {
  /** Docs-root-relative directory that TypeDoc generates, such as `en/api`. */
  sourceDir: string;
  /** Locale directories that receive the mirrored Markdown. */
  targets: MirrorApiLocaleTarget[];
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
  const { sourceDir, targets } = options;

  return {
    name: 'agent-bundle/mirror-api-locale',
    async config(config) {
      const docsRoot = config.root;
      if (!docsRoot) {
        return config;
      }

      const source = path.join(docsRoot, sourceDir);
      const generatedFiles = await collectMarkdownFiles(source);
      await alignTypeDocMemberLinks(source, generatedFiles);

      for (const { dir, notice } of targets) {
        const target = path.join(docsRoot, dir);
        await cleanGeneratedApiMarkdown(target);

        for (const relativePath of generatedFiles) {
          const sourcePath = path.join(source, relativePath);
          const destination = path.join(target, relativePath);
          await mkdir(path.dirname(destination), { recursive: true });

          if (notice === undefined) {
            await copyFile(sourcePath, destination);
            continue;
          }

          const markdown = await readFile(sourcePath, 'utf8');
          await writeFile(destination, insertNoticeAfterTitle(markdown, notice, sourcePath));
        }
      }

      return config;
    },
  };
}
