import { readFile } from 'node:fs/promises';

import { stringify as stringifyYaml } from 'yaml';

import type { Diagnostic } from '../core/diagnostics.ts';
import { parseMarkdownFrontmatter } from './skill-references.ts';

export interface RuleDocument {
  /** Peeled target restriction; never emitted in Cursor rule frontmatter. */
  readonly authoredTargets?: readonly string[];
  readonly body: string;
  readonly diagnostics: readonly Diagnostic[];
  /** Host-emitted document with authoring-only frontmatter keys stripped. */
  readonly emittedMarkdown: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Exact authored `.mdc` bytes decoded as UTF-8; retained as an identity input. */
  readonly markdown: string;
  readonly source: string;
}

const diagnostic = (
  code: string,
  message: string,
  sourcePath: string,
): Diagnostic => ({ code, message, severity: 'error', sourcePath });

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const allowedFields = new Set(['alwaysApply', 'description', 'globs', 'targets']);

const validateFrontmatter = (
  declared: Readonly<Record<string, unknown>>,
  source: string,
): {
  readonly authoredTargets?: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
} => {
  const diagnostics: Diagnostic[] = [];
  const frontmatter: Record<string, unknown> = {};

  for (const field of Object.keys(declared).filter((field) => !allowedFields.has(field)).sort()) {
    diagnostics.push(diagnostic(
      'AB4902',
      `Rule frontmatter field ${JSON.stringify(field)} is not supported.`,
      source,
    ));
  }

  const description = declared.description;
  if (description !== undefined) {
    if (typeof description === 'string') frontmatter.description = description;
    else diagnostics.push(diagnostic('AB4903', 'Rule frontmatter description must be a string.', source));
  }

  const globs = declared.globs;
  if (globs !== undefined) {
    if (nonemptyString(globs)) {
      frontmatter.globs = globs;
    } else if (Array.isArray(globs) && globs.every(nonemptyString)) {
      frontmatter.globs = [...globs];
    } else {
      diagnostics.push(diagnostic(
        'AB4903',
        'Rule frontmatter globs must be a nonempty string or an array of nonempty strings.',
        source,
      ));
    }
  }

  const alwaysApply = declared.alwaysApply;
  if (alwaysApply !== undefined) {
    if (typeof alwaysApply === 'boolean') frontmatter.alwaysApply = alwaysApply;
    else diagnostics.push(diagnostic('AB4903', 'Rule frontmatter alwaysApply must be a boolean.', source));
  }

  const targets = declared.targets;
  let authoredTargets: readonly string[] | undefined;
  if (targets !== undefined) {
    if (Array.isArray(targets) && targets.every(nonemptyString)) {
      authoredTargets = [...targets];
    } else {
      diagnostics.push(diagnostic(
        'AB4903',
        'Rule frontmatter targets must be an array of nonempty target names.',
        source,
      ));
    }
  }

  return {
    ...(authoredTargets === undefined ? {} : { authoredTargets }),
    diagnostics,
    frontmatter,
  };
};

const emittedMarkdown = (
  markdown: string,
  body: string,
  declared: Readonly<Record<string, unknown>>,
  frontmatter: Readonly<Record<string, unknown>>,
): string => {
  if (!Object.hasOwn(declared, 'targets')) return markdown;
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${stringifyYaml(frontmatter)}---\n${body.startsWith('\n') ? body : `\n${body}`}`;
};

export const parseRule = async (source: string): Promise<RuleDocument> => {
  let markdown: string;
  try {
    markdown = await readFile(source, 'utf8');
  } catch (error: unknown) {
    return {
      body: '',
      diagnostics: [diagnostic(
        'AB4900',
        `Unable to read rule file: ${error instanceof Error ? error.message : String(error)}`,
        source,
      )],
      emittedMarkdown: '',
      frontmatter: {},
      markdown: '',
      source,
    };
  }

  const parsed = parseMarkdownFrontmatter(markdown);
  if (parsed.status === 'missing-frontmatter') {
    return {
      body: parsed.body,
      diagnostics: [],
      emittedMarkdown: markdown,
      frontmatter: {},
      markdown,
      source,
    };
  }
  if (parsed.status === 'malformed-frontmatter') {
    return {
      body: parsed.body,
      diagnostics: [diagnostic(
        'AB4901',
        `Rule YAML frontmatter is invalid: ${parsed.message}`,
        source,
      )],
      emittedMarkdown: markdown,
      frontmatter: {},
      markdown,
      source,
    };
  }

  const validated = validateFrontmatter(parsed.frontmatter, source);
  return {
    ...(validated.authoredTargets === undefined ? {} : { authoredTargets: validated.authoredTargets }),
    body: parsed.body,
    diagnostics: validated.diagnostics,
    emittedMarkdown: emittedMarkdown(markdown, parsed.body, parsed.frontmatter, validated.frontmatter),
    frontmatter: validated.frontmatter,
    markdown,
    source,
  };
};
