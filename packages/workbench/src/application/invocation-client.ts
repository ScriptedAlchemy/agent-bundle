import { z } from 'zod';

import type {
  EventTraceEvent,
  RunningRouteInvocation,
  RouteInvocation,
  RouteInvocationRequest,
  RouteInvocationStreamMessage,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import { parseJsonWithoutDuplicateKeys } from '../../../agent-bundle/src/contracts/strict-json.ts';
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
const invocationSurfaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mcp') }),
  z.strictObject({
    args: z.array(z.string()),
    command: textSchema,
    kind: z.literal('cli'),
  }),
  z.strictObject({
    fixtureId: textSchema.optional(),
    host: z.enum(['claude', 'codex', 'cursor']).optional(),
    kind: z.literal('event'),
  }),
  z.strictObject({ kind: z.literal('script') }),
  z.strictObject({ kind: z.literal('unit-render') }),
]);
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
const outcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success') }),
  z.strictObject({ kind: z.literal('represented-error'), summary: z.string() }),
  z.strictObject({ exitCode: z.number().int(), kind: z.literal('process-exit') }),
]);
const invocationSummaryFields = {
  completedAt: textSchema,
  correlationId: textSchema.optional(),
  diagnostics: z.array(diagnosticSchema),
  event: invocationEventSchema.optional(),
  id: textSchema,
  input: z.json(),
  kind: z.enum(['cli', 'event-route', 'prompt', 'resource', 'script', 'tool']),
  manifestDigest: textSchema,
  outcome: outcomeSchema.optional(),
  routeId: textSchema,
  source: z.string(),
  sourceRevision: textSchema,
  startedAt: textSchema,
  status: z.enum(['cancelled', 'failed', 'succeeded']),
  surface: invocationSurfaceSchema,
  timings: z.array(timingSchema),
} as const;
// A completed boundary always says what the run meant; a boundary that never
// completed has nothing to judge. The wire never gets to imply success by omission.
const outcomeMatchesStatus = (value: Pick<RouteInvocationSummary, 'outcome' | 'status'>): boolean =>
  (value.status === 'succeeded') === (value.outcome !== undefined);
const invocationSummarySchema: z.ZodType<RouteInvocationSummary> =
  z.strictObject(invocationSummaryFields).refine(outcomeMatchesStatus);
const invocationSchema: z.ZodType<RouteInvocation> = z.strictObject({
  ...invocationSummaryFields,
  context: requestContextProvenanceSchema,
  document: agentDocumentSchema.optional(),
  events: z.array(agentRenderEventSchema),
  projection: projectionSchema,
  providers: z.array(providerSchema),
  result: z.json().optional(),
  trace: z.array(eventTraceSchema).optional(),
}).refine(outcomeMatchesStatus);
const invocationResponseSchema = z.strictObject({ invocation: invocationSchema });
const runningInvocationSchema: z.ZodType<RunningRouteInvocation> = z.strictObject({
  id: textSchema,
  routeId: textSchema,
  startedAt: textSchema,
  status: z.literal('running'),
  surface: invocationSurfaceSchema,
});
const runningInvocationResponseSchema = z.strictObject({ invocation: runningInvocationSchema });
const streamMessageSchema: z.ZodType<RouteInvocationStreamMessage> = z.discriminatedUnion('type', [
  z.strictObject({ event: agentRenderEventSchema, type: z.literal('render') }),
  z.strictObject({ event: eventTraceSchema, type: z.literal('trace') }),
  z.strictObject({ type: z.literal('truncated') }),
  z.strictObject({ invocation: invocationSchema, type: z.literal('final') }),
]);
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

  async start(request: RouteInvocationRequest, signal?: AbortSignal): Promise<RunningRouteInvocation> {
    const response = await this.#foreground.protectedRequest('/api/routes/invocations', {
      body: JSON.stringify({ ...request, stream: true }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await bodyFor(response);
    if (!response.ok) throw responseError(body, response.status);
    const decoded = runningInvocationResponseSchema.safeParse(body);
    if (!decoded.success) throw invalid('Route invocation start returned an invalid response.');
    return Object.freeze(decoded.data.invocation);
  }

  async stream(
    id: string,
    listener: (message: RouteInvocationStreamMessage) => void,
    signal?: AbortSignal,
  ): Promise<RouteInvocation> {
    const response = await this.#foreground.protectedRequest(
      `/api/routes/invocations/${opaqueInvocationId(id)}/stream`,
      signal === undefined ? {} : { signal },
    );
    if (!response.ok) throw responseError(await bodyFor(response), response.status);
    if (response.body === null) throw invalid('Route invocation stream returned no body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let final: RouteInvocation | undefined;
    for (;;) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const lines = frame.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (event === undefined || data === undefined) throw invalid('Route invocation stream returned an invalid frame.');
        let parsed: unknown;
        try {
          parsed = parseJsonWithoutDuplicateKeys(data);
        } catch {
          throw invalid('Route invocation stream returned an invalid frame.');
        }
        const decoded = streamMessageSchema.safeParse(parsed);
        if (!decoded.success || decoded.data.type !== event) throw invalid('Route invocation stream returned an invalid frame.');
        listener(decoded.data);
        if (decoded.data.type === 'final') final = decoded.data.invocation;
        boundary = buffered.indexOf('\n\n');
      }
      if (next.done) break;
    }
    if (final === undefined) throw invalid('Route invocation stream ended without a final invocation.');
    return final;
  }

  async cancel(id: string, signal?: AbortSignal): Promise<RouteInvocation> {
    const response = await this.#foreground.protectedRequest(
      `/api/routes/invocations/${opaqueInvocationId(id)}/cancel`,
      { method: 'POST', ...(signal === undefined ? {} : { signal }) },
    );
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
