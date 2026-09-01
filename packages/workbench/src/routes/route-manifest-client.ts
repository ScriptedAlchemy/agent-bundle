import { z } from 'zod';

import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  RouteManifest,
  RouteManifestCliCommand,
  RouteManifestCliOption,
  RouteManifestCliSurface,
  RouteManifestConfigEntry,
  RouteManifestProvider,
  RouteManifestRoute,
  RouteManifestServer,
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
  RouteInputSchemaLiteral,
} from '../../../agent-bundle/src/contracts/routes.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export interface RouteManifestClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

/** Carries the foreground diagnostic code so an absent or stale manifest stays distinguishable from a decode failure. */
export class RouteManifestClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'RouteManifestClientError';
    this.code = code;
    this.status = status;
  }
}

const diagnosticSchema: z.ZodType<Diagnostic> = z.strictObject({
  code: z.string(),
  generatedPath: z.string().optional(),
  message: z.string(),
  recovery: z.string().optional(),
  severity: z.enum(['error', 'info', 'warning']),
  sourcePath: z.string().optional(),
  target: z.string().optional(),
});

const configEntrySchema: z.ZodType<RouteManifestConfigEntry> = z.strictObject({
  key: z.string(),
  kind: z.enum(['array', 'boolean', 'null', 'number', 'object', 'string']),
  value: z.string(),
});

const inputSchemaScalarLiteral = z.union([z.boolean(), z.number().finite(), z.string()]);
const inputSchemaLiteral: z.ZodType<RouteInputSchemaLiteral> = z.union([
  inputSchemaScalarLiteral,
  z.array(inputSchemaScalarLiteral),
]);

const inputSchemaArrayItem: z.ZodType<RouteInputArrayItemSchema> = z.union([
  z.strictObject({ type: z.literal('boolean') }),
  z.strictObject({ type: z.literal('number') }),
  z.strictObject({ enum: z.array(z.string()).optional(), type: z.literal('string') }),
]);

const inputSchemaProperty: z.ZodType<RouteInputPropertySchema> = z.union([
  z.strictObject({
    default: inputSchemaLiteral.optional(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    type: z.literal('string'),
  }),
  z.strictObject({
    default: inputSchemaLiteral.optional(),
    description: z.string().optional(),
    type: z.literal('number'),
  }),
  z.strictObject({
    default: inputSchemaLiteral.optional(),
    description: z.string().optional(),
    type: z.literal('boolean'),
  }),
  z.strictObject({
    default: inputSchemaLiteral.optional(),
    description: z.string().optional(),
    items: inputSchemaArrayItem,
    type: z.literal('array'),
  }),
]);

const inputSchema: z.ZodType<RouteInputSchema> = z.strictObject({
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), inputSchemaProperty),
  required: z.array(z.string()).optional(),
  type: z.literal('object'),
});

const routeSchema: z.ZodType<RouteManifestRoute> = z.strictObject({
  config: z.array(configEntrySchema),
  description: z.string().optional(),
  event: z.string().optional(),
  id: z.string(),
  inputSchema: inputSchema.optional(),
  kind: z.enum(['app', 'cli', 'event-route', 'prompt', 'resource', 'script', 'tool']),
  provenance: z.strictObject({ kind: z.literal('conventional') }),
  serverId: z.string().optional(),
  source: z.string(),
});

const serverSchema: z.ZodType<RouteManifestServer> = z.strictObject({
  id: z.string(),
  mode: z.enum(['command', 'conflict', 'custom', 'generated', 'remote']),
  name: z.string(),
  routes: z.array(routeSchema),
});

const cliOptionSchema: z.ZodType<RouteManifestCliOption> = z.strictObject({
  choices: z.array(z.string()).optional(),
  description: z.string().optional(),
  key: z.string(),
  kind: z.enum(['boolean', 'enum', 'number', 'string']),
  option: z.string(),
  positional: z.number().int().nonnegative().optional(),
  repeated: z.boolean(),
  required: z.boolean(),
});

const cliCommandSchema: z.ZodType<RouteManifestCliCommand> = z.strictObject({
  aliases: z.array(z.string()),
  description: z.string().optional(),
  exitCode: z.enum(['result', 'zero']),
  options: z.array(cliOptionSchema),
  path: z.array(z.string()),
  routeId: z.string(),
});

const cliSchema: z.ZodType<RouteManifestCliSurface> = z.strictObject({
  commands: z.array(cliCommandSchema).optional(),
  mode: z.enum(['conflict', 'conventional', 'generated']),
  routes: z.array(routeSchema),
});

const providerSchema: z.ZodType<RouteManifestProvider> = z.strictObject({
  id: z.string(),
  name: z.string(),
  source: z.string(),
});

const manifestSchema: z.ZodType<RouteManifest> = z.strictObject({
  cli: cliSchema.optional(),
  diagnostics: z.array(diagnosticSchema),
  digest: z.string(),
  events: z.array(routeSchema),
  providers: z.array(providerSchema),
  scripts: z.array(routeSchema),
  servers: z.array(serverSchema),
  sourceRevision: z.string(),
});

const responseSchema = z.strictObject({ manifest: manifestSchema });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const diagnosticError = (value: unknown, status: number): RouteManifestClientError => {
  if (
    isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string'
  ) {
    return new RouteManifestClientError(value.diagnostic.code, value.diagnostic.message, status);
  }
  return new RouteManifestClientError('AB8123', `Route manifest request failed with HTTP ${String(status)}.`, status);
};

const manifestBody = (value: unknown): RouteManifest => {
  const result = responseSchema.safeParse(value);
  if (!result.success) throw new RouteManifestClientError('AB8123', 'Route manifest route returned an invalid response.');
  return Object.freeze(result.data.manifest);
};

/** Reads the one compiled route graph the dev server already produced; the browser never re-discovers routes. */
export class RouteManifestClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: RouteManifestClientOptions) {
    this.#foreground = options.foreground;
  }

  async manifest(signal?: AbortSignal): Promise<RouteManifest> {
    const response = await this.#foreground.protectedRequest('/api/routes/manifest', signal === undefined ? {} : { signal });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return manifestBody(body);
  }
}
