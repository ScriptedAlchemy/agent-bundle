/**
 * Interoperable `inputSchema` / `outputSchema` for generated MCP tools (#563).
 *
 * The MCP SDK advertises a route's zod schemas as JSON Schema 2020-12, where a
 * tuple is `prefixItems: [A, B]` plus `items: false`. Cursor validates
 * `structuredContent` with ajv's draft-07 class in non-strict mode — the MCP
 * SDK v1 default — so `prefixItems` is an unknown keyword it ignores and
 * `items: false` applies to every element: every valid tuple fails with
 * `data/…/buckets/0/0 boolean schema is false`. `mcp-schema-projection.ts`
 * rewrites the 2020-12 output so a valid value passes under both dialects
 * while positions and length stay exact under 2020-12, and the generated
 * server wraps every tool route's schemas in it. These tests pin the rule,
 * reproduce the failure with the real validators, and drive the wrapped
 * schemas through the SDK's own server and client.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from '@rstest/core';
import { Ajv } from 'ajv/dist/ajv.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import type { AgentDocument, AgentRenderDispatcher, AgentRenderEvent } from '@agent-bundle/runtime';

import { deepFreeze } from '../src/core/freeze.ts';
import { interoperableJsonSchema, interoperableStandardSchema } from '../src/mcp-schema-projection.ts';
import {
  createGeneratedRouteMcpServer,
  type GeneratedRouteExecutionHost,
  type GeneratedRouteRecord,
  registerGeneratedRoutes,
} from '../src/mcp-server-runtime.ts';

type JsonSchema = Record<string, unknown>;

/** The conversion options the MCP SDK passes to every Standard Schema it advertises. */
const TARGET = { target: 'draft-2020-12' } as const;

interface StandardResult {
  readonly issues?: readonly unknown[];
  readonly value?: unknown;
}

/** The `~standard` surface zod (≥ 4.2) and the agent-bundle wrapper both expose. */
interface StandardSurface {
  readonly jsonSchema: {
    readonly input: (options: typeof TARGET) => unknown;
    readonly output: (options: typeof TARGET) => unknown;
  };
  readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>;
  readonly vendor: string;
  readonly version: number;
}

const standardOf = (schema: unknown): StandardSurface =>
  (schema as { readonly '~standard': StandardSurface })['~standard'];
const asSchema = (value: unknown): JsonSchema => value as JsonSchema;

/** zod's own 2020-12 output — what the SDK advertises without the projection. */
const zodJson = (schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema =>
  asSchema(standardOf(schema).jsonSchema[io](TARGET));
const projected = (schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema =>
  asSchema(interoperableJsonSchema(zodJson(schema, io)));

/** The draft-07 class resolves `$schema` against its own meta-schemas, so a Cursor-style validation drops the 2020-12 URI. */
const stripSchema = (schema: JsonSchema): JsonSchema =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'));

/** Structural walk over every object node; a property literally named `items` would count too, and no fixture declares one. */
const someNode = (value: unknown, predicate: (node: JsonSchema) => boolean): boolean => {
  if (Array.isArray(value)) return value.some((entry) => someNode(entry, predicate));
  if (typeof value !== 'object' || value === null) return false;
  const node = asSchema(value);
  return predicate(node) || Object.values(node).some((entry) => someNode(entry, predicate));
};
const containsItemsFalse = (value: unknown): boolean => someNode(value, (node) => node['items'] === false);
const containsPrefixItems = (value: unknown): boolean => someNode(value, (node) => Array.isArray(node['prefixItems']));

interface Verdict {
  readonly errors: string;
  readonly valid: boolean;
}

const verdict = (engine: Pick<Ajv, 'compile' | 'errorsText'>, schema: JsonSchema, value: unknown): Verdict => {
  const validate = engine.compile(schema);
  const valid = validate(value);
  return { errors: valid ? '' : engine.errorsText(validate.errors), valid };
};
/** Cursor's validator: ajv's draft-07 class, non-strict — `prefixItems` is ignored and `items` governs every element. */
const cursorVerdict = (schema: JsonSchema, value: unknown): Verdict => verdict(new Ajv({ strict: false }), stripSchema(schema), value);
const lax2020Verdict = (schema: JsonSchema, value: unknown): Verdict => verdict(new Ajv2020({ strict: false }), schema, value);
/** Default-strict 2020-12, with ajv's strict-mode advisories captured instead of written to the console. */
const strict2020Verdict = (schema: JsonSchema, value: unknown): Verdict & { readonly advisories: readonly string[] } => {
  const advisories: string[] = [];
  const record = (...args: unknown[]): number => advisories.push(args.map(String).join(' '));
  return { ...verdict(new Ajv2020({ logger: { error: record, log: record, warn: record } }), schema, value), advisories };
};

const histogram = z.object({
  buckets: z.array(z.tuple([z.number().nullable(), z.number().int().nonnegative()])),
  count: z.number().int().nonnegative(),
  max: z.number().nullable(),
  min: z.number().nullable(),
  sum: z.number(),
});
/** Mirrors cargo-hauler's `protocol-schemas.ts` (`histogramMetricSchema` inside `statusMetricsSchema`) — the shape from the issue. */
const cargoMetrics = z.object({
  metrics: z.object({
    cargo_run_ms: histogram,
    cargo_run_ms_by_kind: z.record(z.string(), histogram).optional(),
    wait_ms_summary: z.object({
      count: z.number().int().nonnegative(),
      max: z.number().nullable(),
      min: z.number().nullable(),
      quantiles: z.array(z.tuple([z.number(), z.number().nullable()])),
      sum: z.number(),
    }).optional(),
  }),
});
const bucketed: z.output<typeof histogram> = { buckets: [[null, 3], [12.5, 0]], count: 3, max: 12.5, min: null, sum: 12.5 };
const cargoSample: z.output<typeof cargoMetrics> = {
  metrics: {
    cargo_run_ms: bucketed,
    cargo_run_ms_by_kind: { build: bucketed },
    wait_ms_summary: { count: 1, max: 1, min: 1, quantiles: [[0.5, null], [0.95, 7]], sum: 1 },
  },
};
const withBuckets = (buckets: unknown): unknown => ({ metrics: { cargo_run_ms: { ...bucketed, buckets } } });

const Node = z.object({
  get children() {
    return z.array(Node);
  },
});
const invalidNode = { root: { children: [{ children: 'x' }] } };

interface Fixture {
  readonly name: string;
  /** Fails the projected schema under 2020-12 by position or length — the precision `prefixItems` and `maxItems` keep. */
  readonly rejectedBy2020: unknown;
  /** Carries an element matching none of the positional schemas, so even the permissive draft-07 reading rejects it. */
  readonly rejectedByBoth: unknown;
  /** How zod's unprojected output fails Cursor's validator; `none` for a shape that never did. */
  readonly reproduction: 'closed-tuple' | 'rest-tuple' | 'none';
  readonly sample: unknown;
  readonly schema: z.ZodType;
}

const fixtures: readonly Fixture[] = [
  {
    name: 'tuple', reproduction: 'closed-tuple', schema: z.object({ t: z.tuple([z.string(), z.number()]) }),
    sample: { t: ['a', 1] }, rejectedBy2020: { t: ['a', 1, 2] }, rejectedByBoth: { t: ['a', true] },
  },
  {
    name: 'nullable tuple element', reproduction: 'closed-tuple', schema: z.object({ t: z.tuple([z.number().nullable(), z.number()]) }),
    sample: { t: [null, 1] }, rejectedBy2020: { t: [1, null] }, rejectedByBoth: { t: ['x', 1] },
  },
  {
    name: 'nested tuple in object', reproduction: 'closed-tuple',
    schema: z.object({ o: z.object({ t: z.tuple([z.tuple([z.number(), z.number()]), z.string()]) }) }),
    sample: { o: { t: [[1, 2], 'a'] } }, rejectedBy2020: { o: { t: ['a', [1, 2]] } }, rejectedByBoth: { o: { t: [[1, 'x'], 'a'] } },
  },
  {
    name: 'array of tuples', reproduction: 'closed-tuple', schema: z.object({ rows: z.array(z.tuple([z.string(), z.number()])) }),
    sample: { rows: [['a', 1], ['b', 2]] }, rejectedBy2020: { rows: [['a', 1], ['b', 2, 3]] }, rejectedByBoth: { rows: [['a', true]] },
  },
  {
    name: 'rest tuple', reproduction: 'rest-tuple', schema: z.object({ t: z.tuple([z.string()]).rest(z.number()) }),
    sample: { t: ['a', 1, 2] }, rejectedBy2020: { t: [1, 2] }, rejectedByBoth: { t: ['a', true] },
  },
  {
    name: 'cargo-hauler metrics', reproduction: 'closed-tuple', schema: cargoMetrics,
    sample: cargoSample, rejectedBy2020: withBuckets([[3, null]]), rejectedByBoth: withBuckets([['x', 3]]),
  },
  {
    name: 'recursive $defs/$ref', reproduction: 'none', schema: z.object({ root: Node }),
    sample: { root: { children: [{ children: [] }] } }, rejectedBy2020: invalidNode, rejectedByBoth: invalidNode,
  },
];

describe('interoperableJsonSchema', () => {
  it('rewrites a closed tuple to the worked example: prefixItems kept, items the positional union, length pinned', () => {
    const nullableNumber = { type: ['number', 'null'] };
    const nonNegativeInt = { maximum: 9007199254740991, minimum: 0, type: 'integer' };
    expect(projected(z.object({ t: z.tuple([z.number().nullable(), z.number().int().nonnegative()]) }))).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        t: { items: { anyOf: [nullableNumber, nonNegativeInt] }, maxItems: 2, minItems: 2, prefixItems: [nullableNumber, nonNegativeInt], type: 'array' },
      },
      required: ['t'],
      type: 'object',
    });
  });

  it('leaves no items: false anywhere in any fixture, where zod emitted one for every closed tuple', () => {
    for (const fixture of fixtures) {
      expect(containsItemsFalse(projected(fixture.schema))).toBe(false);
      expect(containsItemsFalse(zodJson(fixture.schema))).toBe(fixture.reproduction === 'closed-tuple');
    }
  });

  it('collapses structurally equal positions to one bare schema instead of a one-member anyOf', () => {
    expect(projected(z.tuple([z.number(), z.number()]))['items']).toEqual({ type: 'number' });
  });

  it('unions the rest schema with the prefix schemas of an open tuple and adds no maxItems', () => {
    const result = projected(z.tuple([z.string()]).rest(z.number()));
    expect(result['items']).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(result['minItems']).toBe(1);
    expect(result).not.toHaveProperty('maxItems');
  });

  it('keeps the minItems/maxItems zod emits for an optional trailing element', () => {
    expect(projected(z.tuple([z.string(), z.number().optional()])))
      .toMatchObject({ items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, maxItems: 2, minItems: 1 });
  });

  it('never mutates its input and returns a new object', () => {
    const input = deepFreeze(structuredClone(zodJson(cargoMetrics)));
    const before = JSON.stringify(input);
    const result = interoperableJsonSchema(input);
    expect(result).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(containsItemsFalse(result)).toBe(false);
  });

  it('does not walk const, enum, default, or examples payloads that merely look like schemas', () => {
    const payloads: Record<string, unknown> = {
      const: { items: false, prefixItems: [1] },
      default: { items: false },
      enum: [{ items: false }],
      examples: [{ items: false, prefixItems: [] }],
    };
    const schema = {
      properties: Object.fromEntries(Object.entries(payloads).map(([keyword, payload]) => [keyword, { [keyword]: payload }])),
      type: 'object',
    };
    const result = asSchema(asSchema(interoperableJsonSchema(schema))['properties']);
    for (const [keyword, payload] of Object.entries(payloads)) {
      expect(JSON.stringify(asSchema(result[keyword])[keyword])).toBe(JSON.stringify(payload));
    }
  });

  it('passes prefixItems without items, items: true, boolean schemas, and non-objects through unchanged', () => {
    const open = { prefixItems: [{ type: 'string' }], type: 'array' };
    const anything = { items: true, prefixItems: [{ type: 'string' }], type: 'array' };
    expect(interoperableJsonSchema(open)).toEqual(open);
    expect(interoperableJsonSchema(anything)).toEqual(anything);
    for (const value of [true, false, 42, 'x', null]) expect(interoperableJsonSchema(value)).toBe(value);
  });

  it('pins maxItems to the prefix length so a closed tuple stays closed under 2020-12', () => {
    const closed = { items: false, prefixItems: [{ type: 'string' }], type: 'array' };
    const expected = { items: { type: 'string' }, maxItems: 1, prefixItems: [{ type: 'string' }], type: 'array' };
    expect(interoperableJsonSchema(closed)).toEqual(expected);
    expect(interoperableJsonSchema({ ...closed, maxItems: 5 })).toEqual(expected);
  });
});

describe('validator matrix', () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it("accepts a value the zod schema accepts under Cursor's draft-07 validator once projected", () => {
        expect(() => fixture.schema.parse(fixture.sample)).not.toThrow();
        expect(cursorVerdict(projected(fixture.schema), fixture.sample)).toEqual({ errors: '', valid: true });
      });

      it(fixture.reproduction === 'none'
        ? "passed Cursor's validator before the projection too, so nothing is rewritten"
        : "reproduces the Cursor rejection on zod's unprojected output", () => {
        const before = cursorVerdict(zodJson(fixture.schema), fixture.sample);
        switch (fixture.reproduction) {
          case 'closed-tuple':
            expect(before.valid).toBe(false);
            expect(before.errors).toContain('boolean schema is false');
            break;
          case 'rest-tuple':
            expect(before.valid).toBe(false);
            expect(before.errors).toContain('must be');
            break;
          case 'none':
            expect(before).toEqual({ errors: '', valid: true });
            expect(projected(fixture.schema)).toEqual(zodJson(fixture.schema));
            break;
          default: {
            const unreachable: never = fixture.reproduction;
            throw new TypeError(`Unhandled reproduction ${String(unreachable)}.`);
          }
        }
      });

      it('stays a valid 2020-12 schema under lax and default-strict ajv with $schema kept', () => {
        const interoperable = projected(fixture.schema);
        expect(lax2020Verdict(interoperable, fixture.sample)).toEqual({ errors: '', valid: true });
        const strict = strict2020Verdict(interoperable, fixture.sample);
        expect(strict.valid).toBe(true);
        // ajv's strictTuples advisory fires for rest and optional-tail tuples as zod emits them; the projection adds none.
        const before = strict2020Verdict(zodJson(fixture.schema), fixture.sample).advisories;
        expect(strict.advisories.filter((line) => !before.includes(line))).toEqual([]);
      });

      it('still rejects an invalid value under 2020-12 — a wrong position or an extra element for a tuple', () => {
        expect(() => fixture.schema.parse(fixture.rejectedBy2020)).toThrow();
        expect(lax2020Verdict(projected(fixture.schema), fixture.rejectedBy2020).valid).toBe(false);
      });

      it('rejects an invalid value under draft-07 as well — an element no positional schema admits for a tuple', () => {
        const interoperable = projected(fixture.schema);
        expect(cursorVerdict(interoperable, fixture.rejectedByBoth).valid).toBe(false);
        expect(lax2020Verdict(interoperable, fixture.rejectedByBoth).valid).toBe(false);
      });
    });
  }

  it("reproduces Cursor's exact error text on the unprojected cargo-hauler shape", () => {
    expect(cursorVerdict(zodJson(cargoMetrics), cargoSample).errors).toBe('data/metrics/cargo_run_ms/buckets/0/0 boolean schema is false');
  });

  it('needs no $defs rewrite: recursion passes strict draft-07 and 2020-12 unprojected', () => {
    const recursive = z.object({ root: Node });
    const sample = { root: { children: [{ children: [] }] } };
    expect(verdict(new Ajv(), stripSchema(zodJson(recursive)), sample)).toEqual({ errors: '', valid: true });
    expect(strict2020Verdict(zodJson(recursive), sample).valid).toBe(true);
  });
});

describe('interoperableStandardSchema', () => {
  it('returns anything that is not a Standard Schema with JSON Schema support unchanged', () => {
    const opaque = { parse: (value: unknown) => value };
    const validateOnly = { '~standard': { validate: (value: unknown) => ({ value }), vendor: 'x', version: 1 } };
    const jsonOnly = { '~standard': { jsonSchema: { input: () => ({}), output: () => ({}) }, vendor: 'x', version: 1 } };
    for (const value of [undefined, null, {}, opaque, validateOnly, jsonOnly]) {
      expect(interoperableStandardSchema(value)).toBe(value);
    }
  });

  it('wraps a zod schema in a new Standard Schema branded agent-bundle at the same version', () => {
    const wrapped = interoperableStandardSchema(cargoMetrics);
    expect(wrapped).not.toBe(cargoMetrics);
    expect(standardOf(wrapped).vendor).toBe('agent-bundle');
    expect(standardOf(wrapped).version).toBe(1);
    expect(standardOf(cargoMetrics).vendor).toBe('zod');
  });

  it('delegates validation to the wrapped schema', async () => {
    const std = standardOf(interoperableStandardSchema(cargoMetrics));
    const accepted = await std.validate(cargoSample);
    expect(accepted.issues).toBeUndefined();
    expect(accepted.value).toEqual(cargoSample);
    const rejected = await std.validate(withBuckets([['x', 3]]));
    expect(rejected.issues?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('projects both io variants and keeps the io distinction zod draws', () => {
    const std = standardOf(interoperableStandardSchema(cargoMetrics));
    const output = asSchema(std.jsonSchema.output(TARGET));
    const input = asSchema(std.jsonSchema.input(TARGET));
    expect(output).toEqual(projected(cargoMetrics, 'output'));
    expect(input).toEqual(projected(cargoMetrics, 'input'));
    expect(output['additionalProperties']).toBe(false);
    expect(input).not.toHaveProperty('additionalProperties');
    expect(containsItemsFalse(output) || containsItemsFalse(input)).toBe(false);
    expect(containsPrefixItems(output) && containsPrefixItems(input)).toBe(true);
  });
});

/** A generated server host that cannot render: `tools/list` never asks it to. */
const stubHost: GeneratedRouteExecutionHost = {
  availability: () => 'available',
  close: async () => undefined,
  execute: async () => {
    throw new Error('not rendered');
  },
  identity: { artifactEpoch: 'epoch', instanceId: 'test' },
  markUnavailable: () => undefined,
};

const metricsInput = z.object({ range: z.tuple([z.number(), z.number()]).optional(), verbose: z.boolean().optional() });
const metricsRoute: GeneratedRouteRecord = {
  config: {},
  id: 'mcp/metrics/tools/metrics',
  kind: 'tool',
  module: { default: () => undefined, inputSchema: metricsInput, resultSchema: cargoMetrics },
  name: 'metrics',
};

/** Connects the pair over an in-memory transport, runs the scenario, and closes both whatever happens. */
const withSession = async (server: McpServer, client: Client, scenario: () => Promise<void>): Promise<void> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await scenario();
  } finally {
    await client.close();
    await server.close();
  }
};
const within = (): { readonly signal: AbortSignal } => ({ signal: AbortSignal.timeout(5_000) });

/** The tool as `tools/list` advertises it — the listing also primes the client's own output validation for `callTool`. */
const advertised = async (client: Client, name: string): Promise<{ readonly inputSchema: JsonSchema; readonly outputSchema: JsonSchema }> => {
  const { tools } = await client.listTools(undefined, within());
  const tool = tools.find((candidate) => candidate.name === name);
  return { inputSchema: asSchema(tool?.inputSchema), outputSchema: asSchema(tool?.outputSchema) };
};

/**
 * A client validating `structuredContent` the way MCP SDK v1 hosts (Cursor among
 * them) do: ajv's draft-07 class, non-strict, meta-schema validation off — the
 * construction the SDK documents as its pre-SEP-1613 default (`validators/ajv`),
 * minus `ajv-formats`, which no fixture needs.
 */
const cursorEquivalentClient = (): Client => new Client(
  { name: 'cursor-equivalent', version: '0.0.0' },
  { jsonSchemaValidator: new AjvJsonSchemaValidator(new Ajv({ allErrors: true, strict: false, validateFormats: true, validateSchema: false })) },
);

const expectInteroperable = (schema: JsonSchema): void => {
  expect(containsItemsFalse(schema)).toBe(false);
  expect(containsPrefixItems(schema)).toBe(true);
  expect(() => new Ajv({ strict: false }).compile(stripSchema(schema))).not.toThrow();
  expect(() => new Ajv2020({ strict: false }).compile(schema)).not.toThrow();
};

describe('generated server schema advertisement', () => {
  it('advertises projected inputSchema and outputSchema through createGeneratedRouteMcpServer', async () => {
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host: stubHost,
      plugin: { name: 'metrics', version: '0.0.0' },
      routes: { [metricsRoute.id]: metricsRoute },
    });
    const client = new Client({ name: 'list-tools', version: '0.0.0' });
    await withSession(server, client, async () => {
      const { inputSchema, outputSchema } = await advertised(client, 'metrics');
      expectInteroperable(inputSchema);
      expectInteroperable(outputSchema);
      expect(asSchema(inputSchema['properties'])['range']).toEqual({
        items: { type: 'number' }, maxItems: 2, minItems: 2, prefixItems: [{ type: 'number' }, { type: 'number' }], type: 'array',
      });
      // io preserved through the wrapper: zod closes objects for output only.
      expect(inputSchema).not.toHaveProperty('additionalProperties');
      expect(outputSchema['additionalProperties']).toBe(false);
    });
  });

  it('serves a tools/call whose structured content a Cursor-equivalent client accepts against the advertised outputSchema', async () => {
    // The Flight worker needs React's `react-server` condition (the projection
    // pool), so the dispatcher completes with a fixed document; the SDK's
    // argument validation, `renderGeneratedRoute`, `resultSchema.parse`, the
    // structured-content attachment, the SDK's output validation, and the
    // client's own output validation all run for real.
    const root: AgentDocument['root'] = { children: [{ kind: 'text', text: 'metrics' }], kind: 'result' };
    const document: AgentDocument = { root, status: 'success', value: cargoSample, version: 1 };
    const invocations: unknown[] = [];
    const dispatcher: AgentRenderDispatcher = {
      dispatch: async () => document,
      stream: (request) => {
        invocations.push(request.invocation);
        return new ReadableStream<AgentRenderEvent>({
          start(controller) {
            controller.enqueue({ document, sequence: 1, type: 'complete' });
            controller.close();
          },
        });
      },
    };
    const server = new McpServer({ name: 'metrics', version: '0.0.0' });
    registerGeneratedRoutes(server, { [metricsRoute.id]: metricsRoute }, dispatcher, 'epoch');
    const client = cursorEquivalentClient();
    await withSession(server, client, async () => {
      const { outputSchema } = await advertised(client, 'metrics');
      const result = await client.callTool({ arguments: { range: [1, 2] }, name: 'metrics' }, within());
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(cargoSample);
      expect(cursorVerdict(outputSchema, result.structuredContent)).toEqual({ errors: '', valid: true });
      expect(invocations).toEqual([{ kind: 'tool', props: { input: { range: [1, 2] }, operationId: metricsRoute.id } }]);
      // The wrapper still validates: the SDK reports the input failure as a tool error.
      const rejected = await client.callTool({ arguments: { range: ['1', 2] }, name: 'metrics' }, within());
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain('Input validation error');
    });
  });

  it("reproduces the Cursor rejection on raw zod schemas and clears it with the wrapper on the SDK's own McpServer", async () => {
    const respond = async () => ({ content: [{ text: 'metrics', type: 'text' as const }], structuredContent: cargoSample });
    const server = new McpServer({ name: 'metrics', version: '0.0.0' });
    server.registerTool('raw', { inputSchema: metricsInput, outputSchema: cargoMetrics }, respond);
    server.registerTool('wrapped', {
      inputSchema: interoperableStandardSchema(metricsInput),
      outputSchema: interoperableStandardSchema(cargoMetrics),
    }, respond);
    const client = cursorEquivalentClient();
    await withSession(server, client, async () => {
      await client.listTools(undefined, within());
      await expect(client.callTool({ arguments: { range: [1, 2] }, name: 'raw' }, within()))
        .rejects.toThrow('data/metrics/cargo_run_ms/buckets/0/0 boolean schema is false');
      const result = await client.callTool({ arguments: { range: [1, 2] }, name: 'wrapped' }, within());
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(cargoSample);
    });
  });
});
