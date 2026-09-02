import { createSchemaValidator, toIssue, type SchemaIssue } from '../ajv-issues.ts';
import provenance from './PROVENANCE.json' with { type: 'json' };
import schema from './frontmatter.schema.json' with { type: 'json' };

export type AgentSkillsFrontmatterIssue = SchemaIssue;

interface AgentSkillsProvenance {
  readonly derivedSchema: { readonly sha256: string };
  readonly sourceRevision: string;
  readonly specification: { readonly url: string };
}

const schemaProvenance = provenance as AgentSkillsProvenance;
const validate = createSchemaValidator().compile(schema);

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
