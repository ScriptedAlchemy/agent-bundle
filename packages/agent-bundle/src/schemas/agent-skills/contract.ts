import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import provenance from './PROVENANCE.json' with { type: 'json' };
import schema from './frontmatter.schema.json' with { type: 'json' };

export interface AgentSkillsFrontmatterIssue {
  readonly field?: string;
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

interface AgentSkillsProvenance {
  readonly derivedSchema: { readonly sha256: string };
  readonly sourceRevision: string;
  readonly specification: { readonly url: string };
}

const schemaProvenance = provenance as AgentSkillsProvenance;
const validator = new Ajv2020({ allErrors: true, strict: true });
const validate = validator.compile(schema);

const parameter = (error: ErrorObject, name: string): string | undefined => {
  const value = (error.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};

const fieldFor = (error: ErrorObject): string | undefined => {
  if (error.keyword === 'additionalProperties') {
    return parameter(error, 'additionalProperty');
  }
  if (error.keyword === 'required') {
    return parameter(error, 'missingProperty');
  }

  const [field] = error.instancePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  return field;
};

const compareIssues = (
  left: AgentSkillsFrontmatterIssue,
  right: AgentSkillsFrontmatterIssue,
): number => {
  if (left.instancePath !== right.instancePath) {
    return left.instancePath < right.instancePath ? -1 : 1;
  }
  if (left.keyword !== right.keyword) {
    return left.keyword < right.keyword ? -1 : 1;
  }
  if (left.message !== right.message) {
    return left.message < right.message ? -1 : 1;
  }
  return 0;
};

const toIssue = (error: ErrorObject): AgentSkillsFrontmatterIssue => {
  const field = fieldFor(error);
  return Object.freeze({
    ...(field === undefined ? {} : { field }),
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
  });
};

export const agentSkillsSchemaRevision = Object.freeze({
  schemaSha256: schemaProvenance.derivedSchema.sha256,
  sourceRevision: schemaProvenance.sourceRevision,
  specification: schemaProvenance.specification.url,
});

export const validateAgentSkillsFrontmatter = (
  value: unknown,
): readonly AgentSkillsFrontmatterIssue[] => {
  if (validate(value)) return Object.freeze([]);
  return Object.freeze((validate.errors ?? []).map(toIssue).sort(compareIssues));
};
