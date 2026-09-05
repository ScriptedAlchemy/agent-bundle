import { z } from 'zod';

import type {
  EventTraceEvent,
  RouteInvocation,
  RouteInvocationRequest,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import {
  agentDocumentSchema,
  agentRenderEventSchema,
} from '../runtime/agent-document-client.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import { diagnosticSchema } from '../client-helpers.ts';
import { requestContextProvenanceSchema } from '../request-provenance.ts';

export interface InvocationClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export class InvocationClientError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[] | undefined;
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    options: Readonly<{ readonly diagnostics?: readonly Diagnostic[]; readonly status?: number }> = {},
  ) {
    super(message);
    this.name = 'InvocationClientError';
    this.code = code;
    this.diagnostics = options.diagnostics;
    this.status = options.status;
  }
}

const textSchema = z.string().min(1);
const jsonObjectSchema = z.record(z.string(), z.json());
const timingSchema = z.strictObject({
  durationMs: z.number().finite().nonnegative(),
  phase: textSchema,
  startedAt: textSchema,
});
const providerSchema = z.strictObject({
  durationMs: z.number().finite().nonnegative().optional(),
  id: textSchema,
  message: z.string().optional(),
  name: textSchema,
  status: z.enum(['failed', 'mounted', 'skipped', 'unobserved']),
});
const cliProjectionSchema = z.strictObject({
  exitCode: z.number().int(),
  json: z.json().optional(),
  text: z.string(),
});
const hostProjectionSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  host: z.enum(['claude', 'codex', 'cursor']),
  native: jsonObjectSchema.optional(),
});
const projectionSchema = z.strictObject({
  cli: cliProjectionSchema.optional(),
  hosts: z.array(hostProjectionSchema).optional(),
  mcp: jsonObjectSchema.optional(),
});
const invocationEventSchema = z.strictObject({
  canonical: jsonObjectSchema,
  event: textSchema,
  host: z.enum(['claude', 'codex', 'cursor']).optional(),
  native: jsonObjectSchema.optional(),
});
const eventTraceWireSchema = z.strictObject({
  at: z.number().finite().nonnegative(),
  count: z.number().int().nonnegative().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: z.strictObject({
    code: z.string().optional(),
    message: z.string(),
    name: textSchema,
  }).optional(),
  execution: z.strictObject({
    event: textSchema,
    executionId: textSchema,
    host: textSchema,
    nativeEvent: textSchema,
  }),
  kind: z.enum([
    'preflight.start',
    'preflight.outcome',
    'execute.start',
    'providers.start',
    'providers.finish',
    'render.start',
    'render.finish',
    'failure',
  ]),
  outcome: z.enum(['execute', 'continue', 'deny']).optional(),
  phase: z.enum(['preflight', 'execute', 'providers', 'render']),
  runtime: z.enum(['shared', 'standalone']).optional(),
  sequence: z.number().int().nonnegative(),
});
const eventTraceSchema = z.custom<EventTraceEvent>(
  (value) => eventTraceWireSchema.safeParse(value).success,
);
const invocationSummaryFields = {
  completedAt: textSchema,
  correlationId: textSchema.optional(),
  diagnostics: z.array(diagnosticSchema),
  event: invocationEventSchema.optional(),
  id: textSchema,
  input: z.json(),
  kind: z.enum(['cli', 'event-route', 'prompt', 'resource', 'script', 'tool']),
  manifestDigest: textSchema,
  routeId: textSchema,
  source: z.string(),
  sourceRevision: textSchema,
  startedAt: textSchema,
  status: z.enum(['failed', 'succeeded']),
  timings: z.array(timingSchema),
} as const;
const invocationSummarySchema: z.ZodType<RouteInvocationSummary> =
  z.strictObject(invocationSummaryFields);
const invocationSchema: z.ZodType<RouteInvocation> = z.strictObject({
  ...invocationSummaryFields,
  context: requestContextProvenanceSchema,
  document: agentDocumentSchema.optional(),
  events: z.array(agentRenderEventSchema),
  projection: projectionSchema,
  providers: z.array(providerSchema),
  result: z.json().optional(),
  trace: z.array(eventTraceSchema).optional(),
});
const invocationResponseSchema = z.strictObject({ invocation: invocationSchema });
const invocationListResponseSchema = z.strictObject({
  invocations: z.array(invocationSummarySchema),
});
const diagnosticResponseSchema = z.strictObject({
  diagnostic: z.strictObject({
    code: textSchema,
    message: z.string(),
  }),
  diagnostics: z.array(diagnosticSchema).optional(),
});

const invalid = (message: string): InvocationClientError =>
  new InvocationClientError('AB8230', message);

const responseError = (value: unknown, status: number): InvocationClientError => {
  const decoded = diagnosticResponseSchema.safeParse(value);
  if (decoded.success) {
    return new InvocationClientError(decoded.data.diagnostic.code, decoded.data.diagnostic.message, {
      ...(decoded.data.diagnostics === undefined ? {} : { diagnostics: Object.freeze(decoded.data.diagnostics) }),
      status,
    });
  }
  return new InvocationClientError(
    'AB8230',
    `Route invocation request failed with HTTP ${String(status)}.`,
    { status },
  );
};

const opaqueInvocationId = (value: string): string => {
  if (
    value.length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) {
    throw invalid('Route invocation ID is not a valid opaque segment.');
  }
  return encodeURIComponent(value);
};

const bodyFor = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

const invocationBody = (value: unknown): RouteInvocation => {
  const decoded = invocationResponseSchema.safeParse(value);
  if (!decoded.success) throw invalid('Route invocation route returned an invalid response.');
  return Object.freeze(decoded.data.invocation);
};

const invocationListBody = (value: unknown): readonly RouteInvocationSummary[] => {
  const decoded = invocationListResponseSchema.safeParse(value);
  if (!decoded.success) throw invalid('Route invocation list route returned an invalid response.');
  return Object.freeze(decoded.data.invocations);
};

export class InvocationClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor({ foreground }: InvocationClientOptions) {
    this.#foreground = foreground;
  }

  async invoke(request: RouteInvocationRequest, signal?: AbortSignal): Promise<RouteInvocation> {
    const response = await this.#foreground.protectedRequest('/api/routes/invocations', {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await bodyFor(response);
    if (!response.ok) throw responseError(body, response.status);
    return invocationBody(body);
  }

  async list(limit = 50, signal?: AbortSignal): Promise<readonly RouteInvocationSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw invalid('Route invocation list limit must be an integer from 1 through 50.');
    }
    const response = await this.#foreground.protectedRequest(
      `/api/routes/invocations?limit=${String(limit)}`,
      signal === undefined ? {} : { signal },
    );
    const body = await bodyFor(response);
    if (!response.ok) throw responseError(body, response.status);
    return invocationListBody(body);
  }

  async read(id: string, signal?: AbortSignal): Promise<RouteInvocation> {
    const response = await this.#foreground.protectedRequest(
      `/api/routes/invocations/${opaqueInvocationId(id)}`,
      signal === undefined ? {} : { signal },
    );
    const body = await bodyFor(response);
    if (!response.ok) throw responseError(body, response.status);
    return invocationBody(body);
  }
}
