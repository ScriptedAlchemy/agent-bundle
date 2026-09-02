import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createJiti } from 'jiti';
import { stringify as stringifyYaml } from 'yaml';

import type { Diagnostic } from '../core/diagnostics.ts';
import { MarkdownRenderError, renderElementToMarkdown } from './render-markdown.ts';

/**
 * The rendered-skill convention: `src/skills/<name>/SKILL.tsx` (or `.ts`)
 * default-exports a component and exports a `frontmatter` record; the build
 * compiles the rendered tree to the `SKILL.md` document every host consumes.
 * A hand-authored `SKILL.md` in the same directory always wins (config beats
 * convention; an authored file beats a generated one).
 */
const renderedSkillFileNames = ['SKILL.tsx', 'SKILL.ts'] as const;

/** The source file behind a rendered skill in `skillDir`, when the convention applies. */
export const renderedSkillSourceAt = (skillDir: string): string | undefined => {
  for (const fileName of renderedSkillFileNames) {
    const candidate = join(skillDir, fileName);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // A racing deletion means the convention does not apply.
    }
  }
  return undefined;
};

/** True for the conventional rendered-skill source file names. */
export const isRenderedSkillSourceName = (fileName: string): boolean =>
  (renderedSkillFileNames as readonly string[]).includes(fileName);

export interface CompiledRenderedSkill {
  readonly authoredTargets?: unknown;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  /** The full compiled document: YAML frontmatter followed by the rendered body. */
  readonly markdown: string;
}

export type RenderedSkillCompilation =
  | { readonly document: CompiledRenderedSkill; readonly status: 'compiled' }
  | { readonly diagnostic: Diagnostic; readonly status: 'failed' };

const failure = (code: string, message: string, sourcePath: string): RenderedSkillCompilation => ({
  diagnostic: { code, message, severity: 'error', sourcePath },
  status: 'failed',
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Loads and compiles one rendered skill source to its Markdown document. The
 * module executes through the same jiti pipeline that already runs consumer
 * TypeScript at config-load time, with the automatic JSX runtime resolved
 * from the consumer project.
 */
export const compileRenderedSkill = async (source: string): Promise<RenderedSkillCompilation> => {
  let moduleExports: Record<string, unknown>;
  try {
    const jiti = createJiti(source, {
      interopDefault: true,
      jsx: { runtime: 'automatic' },
      moduleCache: false,
      nativeModules: ['typescript'],
    });
    moduleExports = await jiti.import<Record<string, unknown>>(source);
  } catch (error) {
    return failure('AB3003', `Rendered Skill module failed to load: ${describeError(error)}`, source);
  }

  const component = moduleExports.default;
  if (typeof component !== 'function') {
    return failure(
      'AB3004',
      'Rendered Skill module must default-export a component function.',
      source,
    );
  }
  const frontmatter = moduleExports.frontmatter;
  if (!isPlainRecord(frontmatter)) {
    return failure(
      'AB3004',
      'Rendered Skill module must export a `frontmatter` record with the skill name and description.',
      source,
    );
  }

  let body: string;
  try {
    body = await renderElementToMarkdown({ props: {}, type: component });
  } catch (error) {
    return failure(
      'AB3005',
      error instanceof MarkdownRenderError
        ? error.message
        : `Rendered Skill content failed to render: ${describeError(error)}`,
      source,
    );
  }

  let serializedFrontmatter: string;
  try {
    serializedFrontmatter = stringifyYaml(frontmatter);
  } catch (error) {
    return failure(
      'AB3004',
      `Rendered Skill frontmatter is not serializable YAML: ${describeError(error)}`,
      source,
    );
  }

  const snapshot = structuredClone(frontmatter);
  const skillExport = moduleExports.skill;
  const authoredTargets = isPlainRecord(moduleExports.targets)
    ? structuredClone(moduleExports.targets)
    : isPlainRecord(skillExport) && isPlainRecord(skillExport.targets)
      ? structuredClone(skillExport.targets)
      : undefined;
  return {
    document: {
      ...(authoredTargets === undefined ? {} : { authoredTargets }),
      body,
      frontmatter: snapshot,
      markdown: `---\n${serializedFrontmatter}---\n\n${body}`,
    },
    status: 'compiled',
  };
};
