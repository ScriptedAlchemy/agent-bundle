import {
  type JsonObject,
  snapshotStrictJsonValue,
} from '../core/strict-json.ts';
import {
  compareSchemaIssues,
  createSchemaValidator,
  formatSchemaIssue,
  toIssue,
} from '../schemas/ajv-issues.ts';
import schema from '../../schemas/agent-bundle.manifest.schema.json' with { type: 'json' };

/**
 * The published JSON Schema (draft 2020-12) for `agent-bundle.manifest.json`,
 * also shipped verbatim as `agent-bundle/schemas/agent-bundle.manifest.schema.json`.
 *
 * It mirrors the structural rules of `parseArtifactManifest` — closed keys at
 * every level, required keys, literal unions, SHA-256 and relative-path shapes,
 * and the "present exactly when" conditionals. The parser remains the
 * authority for what a schema cannot state: canonical bytes, sorted arrays,
 * cross-references between sections, digests, and the runtime floor.
 */
export const artifactManifestSchema: JsonObject = Object.freeze(Object.fromEntries(
  Object.entries(schema).map(([key, value]) => [key, snapshotStrictJsonValue(value)]),
));

// The schema states "present exactly when" rules as `if`/`then`/`else`
// conditionals whose `required` keys are declared under the sibling
// `properties`. Ajv's `strictRequired` heuristic compiles the conditional
// before it has recorded those declarations and rejects the schema, so that
// one restriction is relaxed; strictSchema, strictTypes, and strictTuples
// stay on.
const validate = createSchemaValidator({ strictRequired: false }).compile(artifactManifestSchema);

/**
 * Validates a parsed JSON value against `artifactManifestSchema`. Returns no
 * issues when the value conforms, otherwise one formatted line per issue in
 * deterministic order (`/routes must NOT have additional properties: zzz`).
 * Conformance here is necessary but not sufficient: `parseArtifactManifest`
 * still decides whether a document is a manifest.
 */
export const validateArtifactManifestSchema = (value: unknown): readonly string[] => {
  if (validate(value)) return Object.freeze([]);
  return Object.freeze(
    (validate.errors ?? []).map(toIssue).sort(compareSchemaIssues).map(formatSchemaIssue),
  );
};
