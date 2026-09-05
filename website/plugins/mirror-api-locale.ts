import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RspressPlugin } from '@rspress/core';
// The slugger Rspress itself runs over headings (`@rspress/core` re-exports it
// from here for `mdx/remarkPlugins/toc.js`), so ids match byte for byte.
import GithubSlugger from '@rspress/shared/github-slugger';

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

function headingText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, '$1')
    .trim();
}

interface PageAnchors {
  readonly ids: Set<string>;
  /** `### Member` heading id → member name (`build()` → `build`). */
  readonly members: Map<string, string>;
}

function memberName(text: string): string {
  return text.replace(/\(\)$/, '');
}

function collectPageAnchors(markdown: string): PageAnchors {
  const slugger = new GithubSlugger();
  const ids = new Set<string>();
  const members = new Map<string, string>();
  const outsideFences = markdown.replace(/^`{3,}[\s\S]*?^`{3,}[ \t]*$/gm, '');

  for (const match of outsideFences.matchAll(/^(#{1,6}) (.+)$/gm)) {
    const text = headingText(match[2]);
    const id = slugger.slug(text);
    ids.add(id);
    if (match[1].length === 3) {
      members.set(id, memberName(text));
    }
  }
  return { ids, members };
}

/**
 * TypeDoc's first anchor pass hands compound slugs to nested reflections
 * (`EvalRunStoreError.code` → `evalrunstoreerrorcode`), so a later link to the
 * `### EvalRunStoreErrorCode` heading receives a spurious `-1`. Rspress runs
 * github-slugger over the rendered headings instead, where the member's first
 * occurrence has the unsuffixed anchor, so those links are dead. Rewrite a
 * `#name-N` link to `#name` only when the fragment does not exist on the
 * target page (the link is actually dead — a legitimate `#protocol-v1` whose
 * heading exists is never touched), `name` is the id of a `###` member
 * heading there, and the link's label is that member's exact name: ids are
 * case-folded, so `FooCode` and `fooCode` share a base and only the label
 * tells which one the link meant. Anything else is left as TypeDoc wrote it
 * for the build's anchor check to judge.
 */
async function alignTypeDocMemberLinks(directory: string, files: string[]): Promise<void> {
  const anchorsByPage = new Map<string, PageAnchors>();

  for (const relativePath of files) {
    const filePath = path.resolve(directory, relativePath);
    anchorsByPage.set(filePath, collectPageAnchors(await readFile(filePath, 'utf8')));
  }

  for (const relativePath of files) {
    const filePath = path.resolve(directory, relativePath);
    const markdown = await readFile(filePath, 'utf8');
    const aligned = markdown.replace(
      /(\[([^\]]*)\]\()([^)\s#]*#)([^)\s#]+?)(-\d+)(\))/g,
      (link, opening: string, label: string, target: string, base: string, suffix: string, closing: string) => {
        const linkedPath = target.slice(0, -1);
        const targetPath = linkedPath ? path.resolve(path.dirname(filePath), linkedPath) : filePath;
        const anchors = anchorsByPage.get(targetPath);
        if (
          !anchors ||
          anchors.ids.has(base + suffix) ||
          anchors.members.get(base) !== memberName(headingText(label))
        ) {
          return link;
        }
        return `${opening}${target}${base}${closing}`;
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
