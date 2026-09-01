import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import { validateAgentSkillsFrontmatter } from '../agent-skills/contract.ts';
import claudeSchema from './claude-skill-frontmatter.schema.json' with { type: 'json' };
import codexSchema from './codex-openai-yaml.schema.json' with { type: 'json' };
import cursorSchema from './cursor-skill-frontmatter.schema.json' with { type: 'json' };
import provenance from './PROVENANCE.json' with { type: 'json' };

export interface SkillHostDocumentIssue {
  readonly field?: string;
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

interface SkillHostProvenance {
  readonly derivedSchemas: Readonly<Record<string, { readonly sha256: string }>>;
  readonly retrievedAt: string;
}

const schemaProvenance = provenance as SkillHostProvenance;
const validator = new Ajv2020({ allErrors: true, strict: true });
const validateClaude = validator.compile(claudeSchema);
const validateCursor = validator.compile(cursorSchema);
const validateCodex = validator.compile(codexSchema);

const parameter = (error: ErrorObject, name: string): string | undefined => {
  const value = (error.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};

const fieldFor = (error: ErrorObject): string | undefined => {
  if (error.keyword === 'additionalProperties') return parameter(error, 'additionalProperty');
  if (error.keyword === 'required') return parameter(error, 'missingProperty');
  const [field] = error.instancePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  return field;
};

const toIssue = (error: ErrorObject): SkillHostDocumentIssue => {
  const field = fieldFor(error);
  return Object.freeze({
    ...(field === undefined ? {} : { field }),
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
  });
};

const issuesFrom = (
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): readonly SkillHostDocumentIssue[] => {
  if (valid) return Object.freeze([]);
  return Object.freeze((errors ?? []).map(toIssue));
};

export const skillHostSchemaRevision = Object.freeze({
  claudeSha256: schemaProvenance.derivedSchemas['claude-skill-frontmatter.schema.json']?.sha256,
  codexSha256: schemaProvenance.derivedSchemas['codex-openai-yaml.schema.json']?.sha256,
  cursorSha256: schemaProvenance.derivedSchemas['cursor-skill-frontmatter.schema.json']?.sha256,
  retrievedAt: schemaProvenance.retrievedAt,
});

export const validateClaudeSkillFrontmatter = (value: unknown): readonly SkillHostDocumentIssue[] =>
  issuesFrom(validateClaude(value), validateClaude.errors);

export const validateCursorSkillFrontmatter = (value: unknown): readonly SkillHostDocumentIssue[] =>
  issuesFrom(validateCursor(value), validateCursor.errors);

export const validateCodexOpenaiYaml = (value: unknown): readonly SkillHostDocumentIssue[] =>
  issuesFrom(validateCodex(value), validateCodex.errors);

export const validatePortableSkillFrontmatter = validateAgentSkillsFrontmatter;
