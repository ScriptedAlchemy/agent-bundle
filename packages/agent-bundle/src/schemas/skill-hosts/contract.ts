import type { ErrorObject } from 'ajv/dist/2020.js';

import { createSchemaValidator, toIssue, type SchemaIssue } from '../ajv-issues.ts';
import claudeSchema from './claude-skill-frontmatter.schema.json' with { type: 'json' };
import codexSchema from './codex-openai-yaml.schema.json' with { type: 'json' };
import cursorSchema from './cursor-skill-frontmatter.schema.json' with { type: 'json' };
import provenance from './PROVENANCE.json' with { type: 'json' };

export type SkillHostDocumentIssue = SchemaIssue;

interface SkillHostProvenance {
  readonly derivedSchemas: Readonly<Record<string, { readonly sha256: string }>>;
  readonly retrievedAt: string;
}

const schemaProvenance = provenance as SkillHostProvenance;
const validator = createSchemaValidator();
const validateClaude = validator.compile(claudeSchema);
const validateCursor = validator.compile(cursorSchema);
const validateCodex = validator.compile(codexSchema);

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
