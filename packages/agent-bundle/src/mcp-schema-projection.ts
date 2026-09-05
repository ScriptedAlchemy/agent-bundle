/**
 * Interoperable JSON Schema for the tool schemas a generated MCP server
 * advertises (#563).
 *
 * The MCP SDK advertises a tool's `inputSchema`/`outputSchema` by asking the
 * route's Standard Schema for its 2020-12 JSON Schema
 * (`~standard.jsonSchema[io]({ target: 'draft-2020-12' })`) and validates
 * `tools/call` arguments and `structuredContent` through `~standard.validate`.
 * Hosts re-validate against the advertised JSON Schema with a validator of
 * their own, and Cursor's applies draft-07 keyword semantics in non-strict
 * mode: `prefixItems` is an unknown keyword it ignores, while `items: false` —
 * zod's 2020-12 encoding of a fixed tuple such as
 * `z.tuple([z.number().nullable(), z.number().int().nonnegative()])` — is
 * applied to every element. Every element then fails and the host rejects a
 * valid result with `MCP error -32602 … boolean schema is false`. Asking zod
 * for the `draft-7` target instead is no answer: its `items: [A, B]` /
 * `additionalItems` encoding fails to compile under every 2020-12 validator,
 * the SDK's own included.
 *
 * So the 2020-12 output is post-processed. At every schema node with a
 * non-empty `prefixItems` (after the prefix schemas are themselves projected):
 *
 * - `items: false` (closed tuple) becomes the deduplicated union of the
 *   positional schemas — `{ anyOf: [A, B] }`, or the bare schema when every
 *   position agrees — and `maxItems` becomes
 *   `min(existing ?? prefixItems.length, prefixItems.length)`. Under 2020-12
 *   `items` only governs elements past `prefixItems`, of which `maxItems` now
 *   allows none, so the meaning is exact. Under draft-07 `prefixItems` is
 *   ignored and the union applies to every element, so a valid tuple passes
 *   (permissively: position 0 may also match B). `minItems` is kept.
 * - `items: <schema>` (open tuple, `.rest(R)`) becomes the deduplicated union
 *   of `[...prefixItems, R]`. Under 2020-12 this loosens only the rest
 *   positions, which may now also match a prefix schema — an accepted
 *   precision loss: no encoding is exact under 2020-12 and also passes a
 *   draft-07 validator for a rest tuple.
 * - `items` absent or `true` is left alone; both drafts already accept every
 *   valid value.
 *
 * Nothing else is rewritten. `$schema` stays the 2020-12 dialect (the result
 * is still valid 2020-12, so dialect-aware validators lose nothing); `$defs`
 * needs no `definitions` alias because Ajv's core vocabulary resolves `$defs`
 * in every draft; and the remaining 2020-12-only keywords
 * (`unevaluatedProperties`, `dependentRequired`, …) are unknown to a lax
 * draft-07 validator and therefore ignored rather than misapplied. The tuple
 * encoding is the one construct zod 4 emits that such a validator rejects for
 * valid data.
 *
 * The projection is pure: the input is never mutated, every schema node is
 * copied, and recursion follows schema-bearing keywords only — never `const`,
 * `enum`, `default`, or `examples`, whose values are carried over by reference.
 */
import { stableJson } from './core/digest.ts';
import { isRecord } from './core/strict-json.ts';

/**
 * Keywords whose value is one schema (an object or a boolean). `items` is
 * handled apart: it may also hold a draft-07 positional schema array.
 */
const SINGLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** Keywords whose value maps property names, patterns, or definition names to schemas. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

/**
 * The union of a tuple's member schemas, deduplicated by canonical JSON; a
 * single distinct member is emitted bare rather than as a one-member `anyOf`.
 */
const unionOf = (members: readonly unknown[]): unknown => {
  const distinct = new Map<string, unknown>();
  for (const member of members) {
    const key = stableJson(member);
    if (!distinct.has(key)) distinct.set(key, member);
  }
  const unique = [...distinct.values()];
  return unique.length === 1 ? unique[0] : { anyOf: unique };
};

/**
 * The tuple rule from the module comment, applied to a node whose keywords
 * are already projected. The node is this module's own copy, so it is
 * extended by spread rather than mutated in place: `items` keeps its
 * position, `maxItems` keeps its position or is appended.
 */
const interoperableTuple = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const prefixItems = schema['prefixItems'];
  if (!Array.isArray(prefixItems) || prefixItems.length === 0) return schema;
  const items = schema['items'];
  if (items === false) {
    const maxItems = schema['maxItems'];
    return {
      ...schema,
      items: unionOf(prefixItems),
      maxItems: typeof maxItems === 'number' ? Math.min(maxItems, prefixItems.length) : prefixItems.length,
    };
  }
  if (isRecord(items)) return { ...schema, items: unionOf([...prefixItems, items]) };
  return schema;
};

const projectSchemaArray = (schemas: readonly unknown[]): readonly unknown[] =>
  schemas.map((schema) => interoperableJsonSchema(schema));

const projectSchemaMap = (schemas: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, interoperableJsonSchema(schema)]));

/**
 * Projects one keyword's value. A value that is not schema-bearing — or is
 * not the shape its keyword calls for — passes through by reference.
 */
const projectKeyword = (keyword: string, value: unknown): unknown => {
  if (keyword === 'items') return Array.isArray(value) ? projectSchemaArray(value) : interoperableJsonSchema(value);
  if (SINGLE_SCHEMA_KEYWORDS.has(keyword)) return interoperableJsonSchema(value);
  if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) return Array.isArray(value) ? projectSchemaArray(value) : value;
  if (SCHEMA_MAP_KEYWORDS.has(keyword)) return isRecord(value) ? projectSchemaMap(value) : value;
  return value;
};

/**
 * Pure post-processor: 2020-12 JSON Schema in, interoperable 2020-12 JSON
 * Schema out, as a new structure. Boolean schemas and non-schema values are
 * returned as they are.
 */
export const interoperableJsonSchema = (schema: unknown): unknown => {
  if (!isRecord(schema)) return schema;
  const projected: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) projected[keyword] = projectKeyword(keyword, value);
  return interoperableTuple(projected);
};

/** The options a Standard JSON Schema converter receives (`target`, optional `libraryOptions`), forwarded verbatim. */
type StandardJsonSchemaOptions = Readonly<Record<string, unknown>>;

interface StandardJsonSchemaConverter {
  readonly input: (options: StandardJsonSchemaOptions) => unknown;
  readonly output: (options: StandardJsonSchemaOptions) => unknown;
}

/**
 * The `~standard` object of a Standard Schema that also implements Standard
 * JSON Schema (zod ≥ 4.2). Structural, like the runtime's own probe, so the
 * package takes no dependency on `@standard-schema/spec`.
 */
interface StandardSchemaProps {
  readonly jsonSchema: StandardJsonSchemaConverter;
  readonly validate: (value: unknown) => unknown;
  readonly vendor: string;
  readonly version: number;
}

interface StandardSchemaWithJsonSchema {
  readonly '~standard': StandardSchemaProps;
}

const isStandardJsonSchemaConverter = (value: unknown): value is StandardJsonSchemaConverter =>
  isRecord(value) && typeof value['input'] === 'function' && typeof value['output'] === 'function';

const isStandardSchemaWithJsonSchema = (schema: unknown): schema is StandardSchemaWithJsonSchema => {
  if (schema === null || schema === undefined) return false;
  if (typeof schema !== 'object' && typeof schema !== 'function') return false;
  const props = (schema as { readonly '~standard'?: unknown })['~standard'];
  return isRecord(props) && typeof props['validate'] === 'function' && isStandardJsonSchemaConverter(props['jsonSchema']);
};

/**
 * Wraps a Standard Schema that implements `~standard.jsonSchema` in one whose
 * `jsonSchema.input(options)` / `.output(options)` return the interoperable
 * projection of the original's answer to the same `options` — same `io`, so
 * zod's `additionalProperties: false` stays an output-only detail — while
 * `validate` delegates to the original `~standard` object (called as its
 * method, so `this` is preserved). `version` is copied; `vendor` names this
 * package. Anything else — `null`, `undefined`, a non-object, a value without
 * `~standard`, or one whose `~standard` lacks `validate` or a complete
 * `jsonSchema` — is returned unchanged, so the SDK applies its own conversion
 * or error exactly as before.
 */
export const interoperableStandardSchema = <T>(schema: T): T => {
  if (!isStandardSchemaWithJsonSchema(schema)) return schema;
  const std = schema['~standard'];
  const wrapped: StandardSchemaWithJsonSchema = {
    '~standard': {
      jsonSchema: {
        input: (options) => interoperableJsonSchema(std.jsonSchema.input(options)),
        output: (options) => interoperableJsonSchema(std.jsonSchema.output(options)),
      },
      validate: (value) => std.validate(value),
      vendor: 'agent-bundle',
      version: std.version,
    },
  };
  return wrapped as T;
};
