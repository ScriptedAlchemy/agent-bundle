import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';
import type { Ignore } from 'ignore';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import {
  isProjectPathIgnored,
  readProjectIgnoreRules,
  toPosixPath,
} from './ignore.ts';
import { parseSkillMarkdown } from './skill-references.ts';

export interface SkillResource {
  bytes: number;
  relativePath: string;
  source: string;
}

export interface SkillDocument {
  body: string;
  diagnostics: Diagnostic[];
  dir: string;
  frontmatter: Record<string, unknown>;
  /** Exact authored/emitted Markdown; splitting remains server-owned. */
  markdown: string;
  resources: SkillResource[];
  source: string;
}

const findProjectRoot = async (skillDir: string): Promise<string> => {
  let current = resolve(skillDir);

  while (true) {
    try {
      await access(join(current, '.gitignore'));
      return current;
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(skillDir);
    }
    current = parent;
  }
};

const resourceList = async (
  skillDir: string,
  root: string,
  rules: Ignore,
): Promise<SkillResource[]> => {
  const sources = await fastGlob('**/*', {
    absolute: true,
    cwd: skillDir,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  });
  const includedSources = sources.filter(
    (source) => !isProjectPathIgnored(rules, root, source),
  );

  return Promise.all(
    includedSources
      .sort((left, right) => {
        const leftPath = toPosixPath(relative(skillDir, left));
        const rightPath = toPosixPath(relative(skillDir, right));
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
      })
      .map(async (source) => ({
        bytes: (await stat(source)).size,
        relativePath: toPosixPath(relative(skillDir, source)),
        source,
      })),
  );
};

const missingFrontmatter = (source: string): Diagnostic => ({
  code: 'AB3001',
  severity: 'error',
  message: 'Skill Markdown must start with YAML frontmatter.',
  sourcePath: source,
});

const malformedFrontmatter = (source: string, error: unknown): Diagnostic => ({
  code: 'AB3002',
  severity: 'error',
  message: `Skill YAML frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`,
  sourcePath: source,
});

export const parseSkill = async (
  skillDir: string,
  projectRoot?: string,
  /** Reuses the caller's compiled ignore rules; discovery parses many skills under one root. */
  projectIgnoreRules?: Ignore,
): Promise<SkillDocument> => {
  const dir = resolve(skillDir);
  const source = join(dir, 'SKILL.md');
  const root = projectRoot === undefined ? await findProjectRoot(dir) : resolve(projectRoot);
  const rules = projectIgnoreRules ?? await readProjectIgnoreRules(root);
  const resources = await resourceList(dir, root, rules);

  let markdown: string;
  try {
    markdown = await readFile(source, 'utf8');
  } catch (error: unknown) {
    return {
      body: '',
      diagnostics: [
        {
          code: 'AB3000',
          severity: 'error',
          message: `Unable to read Skill Markdown: ${error instanceof Error ? error.message : String(error)}`,
          sourcePath: source,
        },
      ],
      dir,
      frontmatter: {},
      markdown: '',
      resources,
      source,
    };
  }

  const parsed = parseSkillMarkdown(markdown);
  if (parsed.status === 'missing-frontmatter') {
    return {
      body: parsed.body,
      diagnostics: [missingFrontmatter(source)],
      dir,
      frontmatter: {},
      markdown,
      resources,
      source,
    };
  }

  if (parsed.status === 'valid') {
    return {
      body: parsed.body,
      diagnostics: [],
      dir,
      frontmatter: parsed.frontmatter,
      markdown,
      resources,
      source,
    };
  }

  return {
    body: parsed.body,
    diagnostics: [malformedFrontmatter(source, parsed.message)],
    dir,
    frontmatter: {},
    markdown,
    resources,
    source,
  };
};
