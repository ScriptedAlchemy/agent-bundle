import { z } from 'zod';

import type {
  EvalRunEventsReplay,
  EvalRunResult,
  EvalRunSelection,
  EvalSuiteListing,
} from '../../../agent-bundle/src/dev/eval-service.ts';
import { parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../../../agent-bundle/src/core/strict-json.ts';
import type { EvalRunEvent, EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import { awaitWithAbort, type ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export interface EvalClientOptions {
  /** Workbench-owned memory-only session authority shared by all foreground routes. */
  readonly foreground: ForegroundRequestAuthority;
}

export type EvalHarness = 'claude' | 'codex' | 'deterministic';

/** Exactly what a browser may choose: authored suites, authored cases, and a trial count. */
export interface EvalRunStart extends EvalRunSelection {
  readonly harness?: EvalHarness;
  readonly trials?: number;
}

/** The server-owned run identity persisted before background execution starts. */
export interface EvalRunAdmission {
  readonly run: EvalRunRecord;
}

/** The exact durable result of one idempotent cancellation request. */
export interface EvalRunCancellation {
  readonly cancelled: boolean;
  readonly runId: string;
}

export interface EvalEventStream {
  close(): void;
  readonly done: Promise<void>;
}

export interface EvalEventStreamOptions {
  readonly afterSequence: number;
  readonly onEvent: (event: EvalRunEvent) => void;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface EvalArtifact {
  readonly blob: Blob;
  readonly filename: string;
  readonly mediaType: string;
}
export class EvalClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvalClientError';
    this.code = code;
  }
}

const maximumArtifactBytes = 8 * 1024 * 1024;
const maximumEventFrameBytes = 256 * 1024;
const safeArtifactSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const evalHarnesses = new Set<EvalHarness>(['deterministic', 'claude', 'codex']);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const invalidResponse = (): EvalClientError =>
  new EvalClientError('AB8073', 'Eval route returned an invalid response.');
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

const textSchema = z.string();
const safeIntegerSchema = z.number().refine(Number.isSafeInteger);
const nonnegativeIntegerSchema = safeIntegerSchema.refine((value) => value >= 0);
const positiveIntegerSchema = safeIntegerSchema.refine((value) => value >= 1);
const provenanceIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const provenancePathMarker = /(?:^|[^A-Za-z0-9])(?:file:|[A-Za-z]:|\\\\)/iu;
const provenanceIdentifierSchema = z.string().refine((value) =>
  provenanceIdentifier.test(value) && !provenancePathMarker.test(value));
const timestampSchema = z.string().refine(isIsoTimestamp);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceLevelSchema = z.enum(['inferred', 'observed', 'unavailable']);
const outcomeSchema = z.enum(['fail', 'inconclusive', 'pass']);
const assertionKindSchema = z.enum(['exit-code', 'mcp-call', 'no-skill-activation', 'outcome', 'skill-activation']);
const diagnosticSchema = z.strictObject({
  code: textSchema,
  generatedPath: textSchema.optional(),
  message: textSchema,
  recovery: textSchema.optional(),
  severity: z.enum(['error', 'info', 'warning']),
  sourcePath: textSchema.optional(),
  target: textSchema.optional(),
});
const assertionSummarySchema = z.strictObject({ id: textSchema, kind: assertionKindSchema });
const invocationSchema = z.strictObject({
  mode: z.enum(['automatic', 'explicit', 'none']),
  skill: textSchema.optional(),
});
const caseSummarySchema = z.strictObject({
  assertions: z.array(assertionSummarySchema),
  digest: digestSchema,
  hosts: z.array(textSchema),
  id: textSchema,
  invocation: invocationSchema,
  prompt: textSchema,
  trials: positiveIntegerSchema,
});
const suiteSchema = z.strictObject({
  cases: z.array(caseSummarySchema),
  digest: digestSchema,
  name: textSchema,
  sourcePath: textSchema,
});
const suiteListingSchema = z.strictObject({
  diagnostics: z.array(diagnosticSchema),
  suites: z.array(suiteSchema),
});
const artifactBindingSchema = z.strictObject({
  manifestPath: textSchema,
  source: z.enum(['explicit', 'run-owned']),
  targetDigests: z.record(z.string(), digestSchema),
});
const runSummarySchema = z.strictObject({
  cases: nonnegativeIntegerSchema,
  fail: nonnegativeIntegerSchema,
  inconclusive: nonnegativeIntegerSchema,
  pass: nonnegativeIntegerSchema,
  trials: nonnegativeIntegerSchema,
});
const runRecordSchema = z.strictObject({
  agentBundleVersion: textSchema,
  artifact: artifactBindingSchema,
  completedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  harness: textSchema,
  id: textSchema,
  projectRevision: digestSchema,
  schemaVersion: z.literal(1),
  summary: runSummarySchema.optional(),
});
const assertionResultSchema = z.strictObject({
  assertionId: textSchema,
  detail: textSchema,
  evidence: evidenceLevelSchema,
  kind: assertionKindSchema,
  outcome: outcomeSchema,
});
const trialEvidenceSchema = z.strictObject({
  mcp: z.strictObject({
    calls: z.array(z.strictObject({ server: textSchema, tool: textSchema })),
    level: evidenceLevelSchema,
  }),
  process: z.strictObject({
    exitCode: safeIntegerSchema.optional(),
    level: evidenceLevelSchema,
    timedOut: z.boolean(),
  }),
  scripts: z.strictObject({
    level: evidenceLevelSchema,
    results: z.record(z.string(), z.strictObject({ detail: textSchema, outcome: outcomeSchema })),
  }),
  skillActivation: z.strictObject({ activated: z.array(textSchema), level: evidenceLevelSchema }),
});
const harnessFailureSchema = z.strictObject({
  code: z.enum(['EVAL_ARTIFACT_UNAVAILABLE', 'EVAL_FIXTURE_UNAVAILABLE', 'EVAL_GRADER_FAILED', 'EVAL_PROCESS_UNAVAILABLE', 'EVAL_TRACE_UNAVAILABLE']),
  message: textSchema,
  stage: z.enum(['artifact', 'fixture', 'grader', 'preflight', 'trace']),
});
const pluginFailureSchema = z.strictObject({
  code: z.enum(['EVAL_PLUGIN_ASSERTION_FAILED', 'EVAL_PLUGIN_PROCESS_FAILED', 'EVAL_PLUGIN_TIMED_OUT']),
  message: textSchema,
});
const trialInvocationProvenanceSchema = z.union([
  z.strictObject({ mode: z.enum(['automatic', 'none']) }),
  z.strictObject({ mode: z.literal('explicit'), skill: provenanceIdentifierSchema }),
]);
const semanticGraderProvenanceSchema = z.union([
  z.null(),
  z.strictObject({
    id: provenanceIdentifierSchema,
    model: provenanceIdentifierSchema,
    schemaVersion: positiveIntegerSchema,
  }),
  z.strictObject({ state: z.literal('unrecorded') }),
]);
const trialProvenanceSchema = z.strictObject({
  hostCliVersion: provenanceIdentifierSchema.optional(),
  invocation: trialInvocationProvenanceSchema,
  semanticGrader: semanticGraderProvenanceSchema,
});
const trialUsageSchema = z.strictObject({
  inputTokens: nonnegativeIntegerSchema,
  outputTokens: nonnegativeIntegerSchema,
});
const trialRecordSchema = z.strictObject({
  assertions: z.array(assertionResultSchema),
  caseDigest: digestSchema,
  caseId: textSchema,
  completedAt: timestampSchema,
  durationMs: nonnegativeIntegerSchema,
  evidence: trialEvidenceSchema,
  fixtureDigest: digestSchema,
  harnessFailure: harnessFailureSchema.optional(),
  host: textSchema,
  id: textSchema,
  model: textSchema,
  outcome: outcomeSchema,
  pluginFailure: pluginFailureSchema.optional(),
  prompt: textSchema,
  provenance: trialProvenanceSchema.optional(),
  rawArtifacts: z.array(textSchema),
  schemaVersion: z.literal(1),
  startedAt: timestampSchema,
  targetDigest: digestSchema,
  trialIndex: nonnegativeIntegerSchema,
  usage: trialUsageSchema.optional(),
});
const assertionAggregateSchema = z.strictObject({
  assertionId: textSchema,
  fail: nonnegativeIntegerSchema,
  inconclusive: nonnegativeIntegerSchema,
  kind: assertionKindSchema,
  pass: nonnegativeIntegerSchema,
});
const caseAggregateSchema = z.strictObject({
  assertions: z.array(assertionAggregateSchema),
  caseDigest: digestSchema,
  caseId: textSchema,
  fail: nonnegativeIntegerSchema,
  fixtureDigest: digestSchema,
  harnessFailures: nonnegativeIntegerSchema,
  host: textSchema,
  inconclusive: nonnegativeIntegerSchema,
  model: textSchema,
  outcome: outcomeSchema,
  pass: nonnegativeIntegerSchema,
  targetDigest: digestSchema,
  trials: nonnegativeIntegerSchema,
});
const runResultSchema = z.strictObject({
  aggregates: z.array(caseAggregateSchema),
  diagnostics: z.array(diagnosticSchema),
  run: runRecordSchema,
  trials: z.array(trialRecordSchema),
});
const conforms = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const snapshot = (value: unknown): JsonValue => {
  try { return snapshotStrictJsonValue(value); }
  catch { throw invalidResponse(); }
};

const parseResponseJson = (bytes: Uint8Array): JsonValue => {
  try { return snapshot(parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw invalidResponse(); }
};

const eventFor = (value: unknown): EvalRunEvent => {
  if (!exactKeys(value, ['kind', 'payload', 'schemaVersion', 'sequence', 'timestamp']) ||
    typeof value.kind !== 'string' || value.kind.length === 0 || value.kind.length > 512 ||
    value.schemaVersion !== 1 || !safeInteger(value.sequence, 1) || !isIsoTimestamp(value.timestamp)) {
    throw invalidResponse();
  }
  return value as unknown as EvalRunEvent;
};

const replayFor = (value: unknown, afterSequence: number): EvalRunEventsReplay => {
  if (!exactKeys(value, ['replay']) || !isRecord(value.replay)) throw invalidResponse();
  const replay = value.replay;
  if (!(exactKeys(replay, ['cursor', 'events']) || exactKeys(replay, ['cursor', 'events', 'incompleteTrailingRecord'])) ||
    !exactKeys(replay.cursor, ['afterSequence']) || !safeInteger(replay.cursor.afterSequence, afterSequence) ||
    !Array.isArray(replay.events) || !replay.events.every((event) => {
      try { eventFor(event); return true; } catch { return false; }
    }) ||
    (Object.hasOwn(replay, 'incompleteTrailingRecord') && replay.incompleteTrailingRecord !== true)) {
    throw invalidResponse();
  }
  const events = replay.events as readonly EvalRunEvent[];
  if (!events.every((event, index) => event.sequence === afterSequence + index + 1) ||
    replay.cursor.afterSequence !== (events.at(-1)?.sequence ?? afterSequence)) {
    throw invalidResponse();
  }
  return Object.freeze({
    cursor: Object.freeze({ afterSequence: replay.cursor.afterSequence }),
    events: Object.freeze([...events]),
    ...(replay.incompleteTrailingRecord === true ? { incompleteTrailingRecord: true as const } : {}),
  });
};

const suiteListing = (value: unknown): EvalSuiteListing => {
  if (!conforms(suiteListingSchema, value)) throw invalidResponse();
  return value as unknown as EvalSuiteListing;
};

const runResult = (value: unknown): EvalRunResult => {
  if (!exactKeys(value, ['run']) || !conforms(runResultSchema, value.run)) throw invalidResponse();
  return value.run as unknown as EvalRunResult;
};

const runAdmission = (value: unknown): EvalRunAdmission => {
  if (!exactKeys(value, ['run']) || !conforms(runRecordSchema, value.run)) throw invalidResponse();
  return Object.freeze({ run: value.run as unknown as EvalRunRecord });
};

const runCancellation = (value: unknown, runId: string): EvalRunCancellation => {
  if (!exactKeys(value, ['cancelled', 'runId']) || typeof value.cancelled !== 'boolean' || value.runId !== runId) {
    throw invalidResponse();
  }
  return Object.freeze({ cancelled: value.cancelled, runId: value.runId });
};

const runRecords = (value: unknown): readonly EvalRunRecord[] => {
  if (!exactKeys(value, ['runs']) || !Array.isArray(value.runs) || !value.runs.every((entry) => conforms(runRecordSchema, entry))) throw invalidResponse();
  return Object.freeze([...value.runs]) as readonly EvalRunRecord[];
};

const opaqueArtifactRef = (reference: string): string => {
  const segments = reference.split('/');
  if (segments.length < 2 || segments[0] !== 'artifacts' || !segments.every((segment) => safeArtifactSegment.test(segment))) {
    throw invalidResponse();
  }
  try {
    return globalThis.btoa(reference).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  } catch {
    throw invalidResponse();
  }
};

const filenameFor = (value: string | null): string | undefined => {
  const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]*)"$/u.exec(value ?? '');
  return match?.[1];
};

/** A typed, credential-memory-only browser client for persisted Eval evidence. */
export class EvalClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: EvalClientOptions) {
    this.#foreground = options.foreground;
  }

  async suites(signal?: AbortSignal): Promise<EvalSuiteListing> {
    return suiteListing(await this.#json('/api/evals/suites', signal === undefined ? {} : { signal }));
  }

  async runs(signal?: AbortSignal): Promise<readonly EvalRunRecord[]> {
    return runRecords(await this.#json('/api/evals/runs', signal === undefined ? {} : { signal }));
  }

  async read(runId: string, signal?: AbortSignal): Promise<EvalRunResult> {
    return runResult(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}`, signal === undefined ? {} : { signal }));
  }

  async start(selection: EvalRunStart, signal?: AbortSignal): Promise<EvalRunAdmission> {
    if (selection.harness !== undefined && !evalHarnesses.has(selection.harness)) throw invalidResponse();
    return runAdmission(await this.#json('/api/evals/runs', {
      body: JSON.stringify({
        ...(selection.caseIds === undefined ? {} : { caseIds: selection.caseIds }),
        ...(selection.harness === undefined ? {} : { harness: selection.harness }),
        ...(selection.suites === undefined ? {} : { suites: selection.suites }),
        ...(selection.trials === undefined ? {} : { trials: selection.trials }),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }, 202));
  }

  async cancel(runId: string, signal?: AbortSignal): Promise<EvalRunCancellation> {
    return runCancellation(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}/cancel`, {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }, 202), runId);
  }

  async events(runId: string, afterSequence = 0, signal?: AbortSignal): Promise<EvalRunEventsReplay> {
    if (!safeInteger(afterSequence)) throw invalidResponse();
    return replayFor(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}/events?after=${String(afterSequence)}`, { signal }), afterSequence);
  }

  stream(options: EvalEventStreamOptions): EvalEventStream {
    if (!safeInteger(options.afterSequence)) throw invalidResponse();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    return Object.freeze({
      close: () => controller.abort(),
      done: this.#stream(options, controller.signal).finally(() => options.signal?.removeEventListener('abort', forwardAbort)),
    });
  }

  async artifact(runId: string, reference: string, signal?: AbortSignal): Promise<EvalArtifact> {
    const response = await this.#response(
      `/api/evals/runs/${encodeURIComponent(runId)}/artifacts/${opaqueArtifactRef(reference)}`,
      { signal },
    );
    const filename = filenameFor(response.headers.get('content-disposition'));
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
    const declaredSize = Number(response.headers.get('content-length'));
    if (filename === undefined || mediaType === undefined || !Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maximumArtifactBytes) {
      throw invalidResponse();
    }
    try {
      const bytes = new Uint8Array(await awaitWithAbort(signal, () => response.arrayBuffer()));
      if (bytes.byteLength !== declaredSize || bytes.byteLength > maximumArtifactBytes) throw invalidResponse();
      return Object.freeze({ blob: new Blob([bytes], { type: mediaType }), filename, mediaType });
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  async #json(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<JsonValue> {
    const response = await this.#response(path, init, expectedStatus);
    try {
      return parseResponseJson(new Uint8Array(await awaitWithAbort(init.signal, () => response.arrayBuffer())));
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  async #response(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<Response> {
    const response = await this.#foreground.protectedRequest(path, init);
    if (response.ok && (expectedStatus === undefined || response.status === expectedStatus)) return response;
    if (response.ok) throw invalidResponse();
    try {
      const body = parseResponseJson(new Uint8Array(await awaitWithAbort(init.signal, () => response.arrayBuffer())));
      if (exactKeys(body, ['diagnostic']) && exactKeys(body.diagnostic, ['code', 'message']) &&
        typeof body.diagnostic.code === 'string' && typeof body.diagnostic.message === 'string') {
        throw new EvalClientError(body.diagnostic.code, body.diagnostic.message);
      }
      throw new EvalClientError('AB8073', `Eval request failed with HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  async #stream(options: EvalEventStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#response(
        `/api/evals/runs/${encodeURIComponent(options.runId)}/stream?after=${String(options.afterSequence)}`,
        { signal },
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson') || response.body === null) throw invalidResponse();
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const parts: Uint8Array[] = [];
    let partBytes = 0;
    let expected = options.afterSequence + 1;
    const append = (part: Uint8Array): void => {
      if (partBytes + part.byteLength > maximumEventFrameBytes) throw invalidResponse();
      if (part.byteLength > 0) parts.push(part);
      partBytes += part.byteLength;
    };
    const consume = (): void => {
      const bytes = new Uint8Array(partBytes);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      parts.length = 0;
      partBytes = 0;
      if (bytes.byteLength === 0) return;
      const event = eventFor(parseResponseJson(bytes));
      if (event.sequence !== expected) throw invalidResponse();
      expected += 1;
      options.onEvent(event);
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (signal.aborted) return;
        let start = 0;
        for (let index = 0; index < chunk.value.byteLength; index += 1) {
          if (chunk.value[index] !== 0x0a) continue;
          append(chunk.value.subarray(start, index));
          consume();
          if (signal.aborted) return;
          start = index + 1;
        }
        append(chunk.value.subarray(start));
      }
      if (partBytes > 0) throw invalidResponse();
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      if (error instanceof EvalClientError) throw error;
      throw invalidResponse();
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
    }
  }
}
