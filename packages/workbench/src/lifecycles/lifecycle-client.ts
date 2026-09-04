import { z } from 'zod';

import type {
  Lifecycle,
  LifecycleBinding,
  LifecycleDiagnostic,
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayDiagnosticResult,
  LifecycleReplayRequest,
  LifecycleReplaySource,
  LifecycleTarget,
} from '../../../agent-bundle/src/contracts/lifecycles.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import {
  agentDocumentSchema,
  agentRenderEventSchema,
} from '../runtime/agent-document-client.ts';
import { deeplyFrozenHookValue } from '../hooks/hook-client.ts';
import { requestContextProvenanceSchema } from '../request-provenance.ts';

export type {
  Lifecycle,
  LifecycleBinding as LifecycleReplayBinding,
  LifecycleDiagnostic,
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayRequest,
  LifecycleReplaySource,
  LifecycleTarget,
};

export type LifecycleReplayResult =
  | LifecycleReplayDiagnosticResult
  | Readonly<{ readonly replay: LifecycleReplay }>;

export interface LifecycleClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export const LIFECYCLE_STALE_DIGEST_CODE = 'AB8213';

export class LifecycleClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'LifecycleClientError';
    this.code = code;
    this.status = status;
  }
}

export class LifecycleStaleDigestError extends LifecycleClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = 'LifecycleStaleDigestError';
  }
}

const invalidResponse = (): LifecycleClientError =>
  new LifecycleClientError('AB8233', 'Lifecycle replay route returned an invalid response.');

const textSchema = z.string();
const canonicalEventSchema = z.enum([
  'session/start',
  'tool/before',
  'tool/after',
  'stop',
  'agent/start',
  'agent/stop',
  'workspace/open',
]);
const jsonRecordSchema = z.record(z.string(), z.json());
const diagnosticSchema = z.strictObject({
  code: textSchema,
  message: textSchema,
  severity: z.enum(['error', 'warning']),
  target: textSchema.optional(),
});
const fixtureSchema = z.strictObject({
  label: textSchema,
  native: jsonRecordSchema,
});
const targetSchema = z.strictObject({
  fixture: fixtureSchema.optional(),
  hostContractRevision: textSchema,
  nativeEvent: textSchema,
  target: textSchema,
});
const lifecycleSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  event: canonicalEventSchema,
  routeId: textSchema,
  routePath: textSchema,
  targets: z.array(targetSchema),
});
const listResponseSchema = z.strictObject({
  lifecycles: z.array(lifecycleSchema),
  manifestDigest: textSchema,
});
const bindingSchema = z.strictObject({
  manifestDigest: textSchema,
  routeId: textSchema,
  target: textSchema,
});
// The canonical payload: each mapped field carries its value beside the host
// key it was read from (#466). Field names are the framework's vocabulary and
// are not re-enumerated here so a new family field never invalidates a replay.
const payloadFieldSchema = z.strictObject({
  nativeKey: textSchema,
  value: z.json(),
});
const canonicalSchema = z.strictObject({
  event: canonicalEventSchema,
  idempotencyKey: textSchema,
  observedAt: textSchema,
  payload: z.record(z.string(), payloadFieldSchema),
  provenance: z.strictObject({
    host: textSchema,
    hostContractRevision: textSchema,
    nativeEvent: textSchema,
    source: z.literal('native'),
  }),
  sequence: z.number().int().nonnegative(),
});
const replaySchema = z.strictObject({
  binding: bindingSchema,
  canonical: canonicalSchema,
  document: agentDocumentSchema.optional(),
  events: z.array(agentRenderEventSchema),
  nativeInput: jsonRecordSchema,
  nativeResponse: jsonRecordSchema.optional(),
  projectionDiagnostic: z.strictObject({ code: textSchema, message: textSchema }).optional(),
  requestContext: requestContextProvenanceSchema,
  source: z.enum(['fixture', 'observed']),
});
const replayDiagnosticSchema = z.strictObject({
  code: textSchema,
  event: canonicalEventSchema,
  message: textSchema,
  severity: z.literal('error'),
  target: textSchema,
});
const replayResponseSchema = z.union([
  z.strictObject({ diagnostics: z.array(replayDiagnosticSchema) }),
  z.strictObject({ replay: replaySchema }),
]);
const errorResponseSchema = z.strictObject({
  diagnostic: z.strictObject({
    code: textSchema,
    message: textSchema,
  }),
});

const frozenInput = (value: unknown): unknown => {
  try {
    return deeplyFrozenHookValue(value);
  } catch {
    throw invalidResponse();
  }
};

const decode = <Output>(schema: z.ZodType<Output>, value: unknown): Output => {
  const parsed = schema.safeParse(frozenInput(value));
  if (!parsed.success) throw invalidResponse();
  return frozenInput(parsed.data) as Output;
};

const failureFor = (value: unknown, status: number): LifecycleClientError => {
  let parsed: z.infer<typeof errorResponseSchema> | undefined;
  try {
    const result = errorResponseSchema.safeParse(frozenInput(value));
    if (result.success) parsed = result.data;
  } catch {
    // Invalid failure bodies fall through to the status-only diagnostic.
  }
  if (parsed === undefined) {
    return new LifecycleClientError('AB8233', `Lifecycle replay request failed with HTTP ${String(status)}.`, status);
  }
  const { code, message } = parsed.diagnostic;
  if (code === LIFECYCLE_STALE_DIGEST_CODE) {
    return new LifecycleStaleDigestError(code, message, status);
  }
  return new LifecycleClientError(code, message, status);
};

/** Strict browser client for semantic lifecycle discovery and deterministic replay. */
export class LifecycleClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: LifecycleClientOptions) {
    this.#foreground = options.foreground;
  }

  async list(signal?: AbortSignal): Promise<LifecycleListResponse> {
    return decode(listResponseSchema, await this.#json('/api/lifecycles', signal === undefined ? {} : { signal }));
  }

  async replay(request: LifecycleReplayRequest, signal?: AbortSignal): Promise<LifecycleReplayResult> {
    return decode(replayResponseSchema, await this.#json('/api/lifecycles/replays', {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }));
  }

  async #json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw failureFor(body, response.status);
    return body;
  }
}
