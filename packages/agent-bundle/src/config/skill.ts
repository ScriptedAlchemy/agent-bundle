import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';
import type { Ignore } from 'ignore';

import type { Diagnostic } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import {
  isProjectPathIgnored,
  readProjectIgnoreRules,
  toPosixPath,
} from './ignore.ts';
import {
  compileRenderedSkill,
  isRenderedSkillSourceName,
  type RenderedSkillLoaderOptions,
  renderedSkillSourceAt,
} from './rendered-skill.ts';
import { parseSkillMarkdown } from './skill-references.ts';

/** What a rendered skill module observes while it evaluates; see {@link RenderedSkillLoaderOptions}. */
export type ParseSkillOptions = RenderedSkillLoaderOptions;

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
  /**
   * Present when the document was compiled from the rendered-skill convention
   * (`SKILL.tsx`/`SKILL.ts`): `source` names the component module, and
   * `markdown` holds the compiled document the build must emit as SKILL.md.
   */
  rendered?: true;
  resources: SkillResource[];
  source: string;
  /** Typed `targets` export from a rendered skill, or peeled `targets` frontmatter. */
  authoredTargets?: unknown;
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
    (source) =>
      !isProjectPathIgnored(rules, root, source) &&
      // The rendered-skill source files are build inputs, never shipped resources.
      !isRenderedSkillSourceName(toPosixPath(relative(skillDir, source))),
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
  message: `Skill YAML frontmatter is invalid: ${errorMessage(error)}`,
  sourcePath: source,
});

const renderedSourceShadowNudge = (source: string, renderedSource: string): Diagnostic => ({
  code: 'AB4735',
  severity: 'info',
  message: `${renderedSource} is present but the hand-authored SKILL.md wins; the rendered skill source is shadowed.`,
  recovery: 'Optional: remove SKILL.md to adopt the rendered skill, or remove the component module to silence this nudge.',
  sourcePath: source,
});

const parseRenderedSkill = async (
  dir: string,
  renderedSource: string,
  resources: SkillResource[],
  options: ParseSkillOptions,
): Promise<SkillDocument> => {
  const compiled = await compileRenderedSkill(renderedSource, options);
  if (compiled.status === 'failed') {
    return {
      body: '',
      diagnostics: [compiled.diagnostic],
      dir,
      frontmatter: {},
      markdown: '',
      rendered: true,
      resources,
      source: renderedSource,
    };
  }
  return {
    ...(compiled.document.authoredTargets === undefined
      ? {}
      : { authoredTargets: compiled.document.authoredTargets }),
    body: compiled.document.body,
    diagnostics: [],
    dir,
    frontmatter: compiled.document.frontmatter,
    markdown: compiled.document.markdown,
    rendered: true,
    resources,
    source: renderedSource,
  };
};

export const parseSkill = async (
  skillDir: string,
  projectRoot?: string,
  /** Reuses the caller's compiled ignore rules; discovery parses many skills under one root. */
  projectIgnoreRules?: Ignore,
  options: ParseSkillOptions = {},
): Promise<SkillDocument> => {
  const dir = resolve(skillDir);
  const source = join(dir, 'SKILL.md');
  const root = projectRoot === undefined ? await findProjectRoot(dir) : resolve(projectRoot);
  const rules = projectIgnoreRules ?? await readProjectIgnoreRules(root);
  const resources = await resourceList(dir, root, rules);
  const renderedSource = renderedSkillSourceAt(dir);

  let markdown: string;
  try {
    markdown = await readFile(source, 'utf8');
  } catch (error: unknown) {
    if (renderedSource !== undefined && isErrno(error, 'ENOENT')) {
      return parseRenderedSkill(dir, renderedSource, resources, options);
    }
    return {
      body: '',
      diagnostics: [
        {
          code: 'AB3000',
          severity: 'error',
          message: `Unable to read Skill Markdown: ${errorMessage(error)}`,
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

  const shadowNudges = renderedSource === undefined ? [] : [renderedSourceShadowNudge(source, renderedSource)];
  const parsed = parseSkillMarkdown(markdown);
  if (parsed.status === 'missing-frontmatter') {
    return {
      body: parsed.body,
      diagnostics: [missingFrontmatter(source), ...shadowNudges],
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
      diagnostics: [...shadowNudges],
      dir,
      frontmatter: parsed.frontmatter,
      markdown,
      resources,
      source,
    };
  }

  return {
    body: parsed.body,
    diagnostics: [malformedFrontmatter(source, parsed.message), ...shadowNudges],
    dir,
    frontmatter: {},
    markdown,
    resources,
    source,
  };
};
