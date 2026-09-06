import { readFile } from 'node:fs/promises';

import type { Diagnostic } from '../core/diagnostics.ts';
import { errorMessage } from '../core/errors.ts';
import { parseMarkdownFrontmatter } from './skill-references.ts';

export interface CommandDocument {
  /** Peeled target restriction; never emitted in host command frontmatter. */
  readonly authoredTargets?: readonly string[];
  readonly body: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Exact authored `.md` bytes decoded as UTF-8. */
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

const allowedFields = new Set([
  'allowedTools',
  'argumentHint',
  'description',
  'disableModelInvocation',
  'model',
  'targets',
]);

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
      'AB4922',
      `Command frontmatter field ${JSON.stringify(field)} is not supported.`,
      source,
    ));
  }

  const allowedTools = declared.allowedTools;
  if (allowedTools !== undefined) {
    if (nonemptyString(allowedTools)) {
      frontmatter.allowedTools = allowedTools;
    } else if (Array.isArray(allowedTools) && allowedTools.every(nonemptyString)) {
      frontmatter.allowedTools = [...allowedTools];
    } else {
      diagnostics.push(diagnostic(
        'AB4923',
        'Command frontmatter allowedTools must be a nonempty string or an array of nonempty strings.',
        source,
      ));
    }
  }

  for (const field of ['argumentHint', 'description', 'model'] as const) {
    const value = declared[field];
    if (value === undefined) continue;
    if (typeof value === 'string') frontmatter[field] = value;
    else diagnostics.push(diagnostic('AB4923', `Command frontmatter ${field} must be a string.`, source));
  }

  const disableModelInvocation = declared.disableModelInvocation;
  if (disableModelInvocation !== undefined) {
    if (typeof disableModelInvocation === 'boolean') {
      frontmatter.disableModelInvocation = disableModelInvocation;
    } else {
      diagnostics.push(diagnostic(
        'AB4923',
        'Command frontmatter disableModelInvocation must be a boolean.',
        source,
      ));
    }
  }

  const targets = declared.targets;
  let authoredTargets: readonly string[] | undefined;
  if (targets !== undefined) {
    if (Array.isArray(targets) && targets.every(nonemptyString)) {
      authoredTargets = [...targets];
    } else {
      diagnostics.push(diagnostic(
        'AB4923',
        'Command frontmatter targets must be an array of nonempty target names.',
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

export const parseCommand = async (source: string): Promise<CommandDocument> => {
  let markdown: string;
  try {
    markdown = await readFile(source, 'utf8');
  } catch (error: unknown) {
    return {
      body: '',
      diagnostics: [diagnostic(
        'AB4920',
        `Unable to read command file: ${errorMessage(error)}`,
        source,
      )],
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
      frontmatter: {},
      markdown,
      source,
    };
  }
  if (parsed.status === 'malformed-frontmatter') {
    return {
      body: parsed.body,
      diagnostics: [diagnostic(
        'AB4921',
        `Command YAML frontmatter is invalid: ${parsed.message}`,
        source,
      )],
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
    frontmatter: validated.frontmatter,
    markdown,
    source,
  };
};
