import type {
  DevLogMessage,
  DevLogRecord,
  DevLogReplay,
  DevLogReplayGap,
} from '../../../agent-bundle/src/contracts/dev-logs.ts';
import {
  parseJsonWithoutDuplicateKeys,
  type JsonValue,
} from '../../../agent-bundle/src/contracts/strict-json.ts';
import { exactKeys, isRecord, parseStrictResponseJson, strictJsonSnapshot } from '../client-helpers.ts';
import { isCredentialKey, redactEvalCredentialText } from '../../../agent-bundle/src/contracts/credentials.ts';
import {
  awaitWithAbort,
  ForegroundRouteClientError,
  type ForegroundRequestAuthority,
} from '../mcp/mcp-route-client.ts';
import { deepFreeze } from '../freeze.ts';


export interface LogClientOptions {
  /** Reuses Workbench's single foreground session and invalidation authority. */
  readonly foreground: ForegroundRequestAuthority;
}

export interface LogStream {
  close(): void;
  readonly done: Promise<void>;
}

export interface LogStreamOptions {
  readonly afterSequence: number;
  readonly onMessage: (message: DevLogMessage) => void;
  /** One page-generation signal owns both the initial replay and its live stream. */
  readonly signal?: AbortSignal;
}

export class LogClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LogClientError';
    this.code = code;
  }
}

const maximumLogFrameBytes = 64 * 1024;
const maximumSummaryLength = 2_048;
const safeContextKeys = new Set(['buildId', 'diagnosticCode', 'epochId', 'hookId', 'projectId', 'runId', 'sessionId', 'target']);
const devLogProducers = Object.freeze(['project', 'build', 'diagnostic', 'mcp', 'hook', 'eval', 'playground'] as const);
const devLogLevels = Object.freeze(['debug', 'info', 'warning', 'error'] as const);
const devLogKinds = deepFreeze({
  build: ['artifact.available', 'build.failed', 'build.started'],
  diagnostic: [
    'artifact.available.diagnostic', 'artifact.status.diagnostic', 'build.failed.diagnostic', 'build.started.diagnostic',
    'dev.host.sync.diagnostic', 'invalidation.diagnostic', 'runtime.event.diagnostic', 'source.changed.diagnostic',
    'source.status.diagnostic',
  ],
  eval: ['eval.run.completed', 'eval.run.failed', 'eval.run.started'],
  hook: ['hook.simulate.completed', 'hook.simulate.failed', 'hook.simulate.started'],
  mcp: ['mcp.logging', 'mcp.stderr', 'mcp.operation.failed', 'mcp.operation.started', 'mcp.operation.succeeded'],
  playground: ['playground.event.appended'],
  project: [
    'artifact.status', 'dev.host.sync', 'dev.shutdown.completed', 'dev.shutdown.started', 'invalidation',
    'project.events.replay-gap', 'project.invalid-source', 'project.load', 'project.prepared', 'runtime.event',
    'source.changed', 'source.status',
  ],
});
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const hasControlOrSeparators = (value: string): boolean => [...value].some((character) =>
  character === '/' || character === '\\' || character <= '\u001F' || character === '\u007F');
const safeProjectRelativePath = /<project>(?:\/[A-Za-z0-9._@+-]+)*/gu;
const isSafeWireText = (value: unknown, maximum = maximumLogFrameBytes): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || redactEvalCredentialText(value) !== value) return false;
  const withoutProjectPaths = value.replace(safeProjectRelativePath, '');
  return !hasControlOrSeparators(withoutProjectPaths) &&
    !/(?:^|[^A-Za-z0-9])(?:file:|[A-Za-z]:|\\\\)/iu.test(withoutProjectPaths);
};
const isSafeDetailKey = (value: string): boolean =>
  !isCredentialKey(value) && !hasControlOrSeparators(value);
const isSafeDetail = (value: JsonValue): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return isSafeWireText(value);
  if (Array.isArray(value)) return value.every(isSafeDetail);
  return Object.entries(value).every(([key, entry]) => isSafeDetailKey(key) && isSafeDetail(entry));
};
const isProducer = (value: unknown): value is keyof typeof devLogKinds =>
  typeof value === 'string' && (devLogProducers as readonly string[]).includes(value);
const isLevel = (value: unknown): boolean => typeof value === 'string' && (devLogLevels as readonly string[]).includes(value);
const isContext = (value: unknown): value is Readonly<Record<string, string>> => isRecord(value) && Object.entries(value).every(([key, entry]) =>
  safeContextKeys.has(key) && typeof entry === 'string' && safeIdentifier.test(entry) && isSafeWireText(entry, 256));
const isDevRecord = (value: unknown): value is DevLogRecord => {
  if (!exactKeys(value, ['context', 'details', 'kind', 'level', 'occurredAt', 'producer', 'sequence', 'summary']) || !isProducer(value.producer)) return false;
  return safeInteger(value.sequence, 1) && isDate(value.occurredAt) && isLevel(value.level) &&
    typeof value.kind === 'string' && (devLogKinds[value.producer] as readonly string[]).includes(value.kind) &&
    isSafeWireText(value.summary, maximumSummaryLength) && isContext(value.context) && isSafeDetail(value.details as JsonValue);
};
const isGap = (value: unknown): value is DevLogReplayGap => exactKeys(value, [
  'earliestAvailableSequence', 'latestDroppedSequence', 'requestedAfterSequence', 'type',
]) && value.type === 'replay.gap' && safeInteger(value.requestedAfterSequence) && safeInteger(value.earliestAvailableSequence, 1) &&
  safeInteger(value.latestDroppedSequence) && value.earliestAvailableSequence === value.latestDroppedSequence + 1 &&
  value.requestedAfterSequence < value.earliestAvailableSequence;
const invalid = (): LogClientError => new LogClientError('AB8093', 'Dev Log route returned an invalid response.');
const snapshot = (value: unknown): JsonValue => strictJsonSnapshot(value, invalid);
const parseResponseJson = (bytes: Uint8Array): JsonValue => parseStrictResponseJson(bytes, invalid);
const parseMessage = (line: string): JsonValue => {
  try { return strictJsonSnapshot(parseJsonWithoutDuplicateKeys(line), invalid); }
  catch { throw invalid(); }
};
const contiguous = (records: readonly DevLogRecord[], afterSequence: number): boolean => records.every((record, index) =>
  record.sequence === afterSequence + index + 1);

const replayFor = (value: unknown, afterSequence: number): DevLogReplay => {
  const detached = snapshot(value);
  if (!exactKeys(detached, ['replay']) || !isRecord(detached.replay)) throw invalid();
  const rawReplay = detached.replay;
  if (
    !(exactKeys(rawReplay, ['cursor', 'records']) || exactKeys(rawReplay, ['cursor', 'gap', 'records'])) ||
    !exactKeys(rawReplay.cursor, ['afterSequence']) || !safeInteger(rawReplay.cursor.afterSequence) ||
    rawReplay.cursor.afterSequence < afterSequence || !Array.isArray(rawReplay.records) || !rawReplay.records.every(isDevRecord) ||
    (Object.hasOwn(rawReplay, 'gap') && !isGap(rawReplay.gap))
  ) throw invalid();
  const records = rawReplay.records;
  const gap: DevLogReplayGap | undefined = Object.hasOwn(rawReplay, 'gap') && isGap(rawReplay.gap)
    ? rawReplay.gap as unknown as DevLogReplayGap
    : undefined;
  if (
    !contiguous(records, gap === undefined ? afterSequence : gap.earliestAvailableSequence - 1) ||
    (gap !== undefined && gap.requestedAfterSequence !== afterSequence) ||
    (records.length > 0 && rawReplay.cursor.afterSequence !== records.at(-1)?.sequence) ||
    (records.length === 0 && rawReplay.cursor.afterSequence !== (gap?.latestDroppedSequence ?? afterSequence))
  ) throw invalid();
  return Object.freeze({
    cursor: Object.freeze({ afterSequence: rawReplay.cursor.afterSequence }),
    ...(gap === undefined ? {} : { gap: Object.freeze({ ...gap }) }),
    records: Object.freeze(records.map((record) => Object.freeze({
      ...record,
      context: Object.freeze({ ...record.context }),
      details: record.details,
    }))),
  });
};

const messageFor = (line: string): DevLogMessage => {
  const parsed = parseMessage(line);
  if (isDevRecord(parsed) || isGap(parsed)) return parsed;
  throw invalid();
};
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
const diagnosticMessages = new Map<string, string>([
  ['AB8090', 'Dev Log route path is not valid.'],
  ['AB8091', 'Dev Log cursor is not valid.'],
  ['AB8092', 'Dev Log cursor is ahead of retained history.'],
  ['AB8093', 'Dev Log route returned an invalid response.'],
]);
const diagnosticFor = (value: unknown): LogClientError => {
  if (!exactKeys(value, ['diagnostic']) || !exactKeys(value.diagnostic, ['code', 'message']) ||
    typeof value.diagnostic.code !== 'string' || typeof value.diagnostic.message !== 'string') return invalid();
  const message = diagnosticMessages.get(value.diagnostic.code);
  return message === undefined ? invalid() : new LogClientError(value.diagnostic.code, message);
};

/** Same-origin cursor client for redacted production logs; it has no raw attachment API. */
export class LogClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: LogClientOptions) {
    this.#foreground = options.foreground;
  }

  async replay(afterSequence = 0, signal?: AbortSignal): Promise<DevLogReplay> {
    if (!safeInteger(afterSequence)) throw invalid();
    const body = await this.#json(`/api/logs/replay?after=${String(afterSequence)}`, { signal });
    return replayFor(body, afterSequence);
  }

  stream(options: LogStreamOptions): LogStream {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    return Object.freeze({
      close: () => controller.abort(),
      done: this.#stream(options, controller.signal).finally(() => options.signal?.removeEventListener('abort', forwardAbort)),
    });
  }

  async #json(path: string, init: RequestInit): Promise<JsonValue> {
    try {
      const response = await this.#response(path, init);
      const bytes = await awaitWithAbort(init.signal, () => response.arrayBuffer());
      return parseResponseJson(new Uint8Array(bytes));
    } catch (error) {
      if (error instanceof LogClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalid();
    }
  }

  async #response(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.#foreground.protectedRequest(path, init);
      if (response.ok) return response;
      const bytes = await awaitWithAbort(init.signal, () => response.arrayBuffer());
      throw diagnosticFor(parseResponseJson(new Uint8Array(bytes)));
    } catch (error) {
      if (error instanceof LogClientError || isAbort(error) || init.signal?.aborted) throw error;
      if (error instanceof ForegroundRouteClientError) throw new LogClientError(error.code, error.message);
      throw invalid();
    }
  }

  async #stream(options: LogStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try { response = await this.#response(`/api/logs/stream?after=${String(options.afterSequence)}`, { signal }); }
    catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (response.body === null) throw invalid();
    const reader = response.body.getReader();
    const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancelReader, { once: true });
    if (signal.aborted) cancelReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const frameParts: Uint8Array[] = [];
    let frameBytes = 0;
    let expectedSequence = options.afterSequence + 1;
    const append = (part: Uint8Array): void => {
      if (frameBytes + part.byteLength > maximumLogFrameBytes) throw invalid();
      if (part.byteLength > 0) frameParts.push(part);
      frameBytes += part.byteLength;
    };
    const consumeFrame = (): void => {
      const bytes = new Uint8Array(frameBytes);
      let offset = 0;
      for (const part of frameParts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      frameParts.length = 0;
      frameBytes = 0;
      if (signal.aborted) return;
      const line = decoder.decode(bytes).trim();
      if (line.length === 0) return;
      const message = messageFor(line);
      if ('sequence' in message) {
        if (message.sequence !== expectedSequence) throw invalid();
        expectedSequence += 1;
      } else {
        if (message.requestedAfterSequence !== expectedSequence - 1) throw invalid();
        expectedSequence = message.earliestAvailableSequence;
      }
      options.onMessage(message);
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
          consumeFrame();
          if (signal.aborted) return;
          start = index + 1;
        }
        append(chunk.value.subarray(start));
      }
      if (frameBytes > 0) throw invalid();
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      if (error instanceof LogClientError) throw error;
      throw invalid();
    } finally {
      signal.removeEventListener('abort', cancelReader);
      await reader.cancel().catch(() => undefined);
    }
  }

}
