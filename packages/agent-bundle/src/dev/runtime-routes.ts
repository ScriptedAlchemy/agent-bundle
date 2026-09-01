import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  type DevRuntimeSession,
} from './runtime-provider.ts';
import type {
  DevRuntimeAsset,
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateResetRequest,
  DevRuntimeSurface,
} from './runtime-protocol.ts';
import { freezeJsonValue, type JsonValue } from './types.ts';

const bodyLimit = 64 * 1024;
const assetLimit = 4 * 1024 * 1024;
// 16 MiB leaves room for rich timelines while bounding retained replacement snapshots.
const agentDocumentResponseLimit = 16 * 1024 * 1024;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

type Route =
  | Readonly<{ readonly kind: 'status' | 'surfaces' | 'runs' | 'state-reset' }>
  | Readonly<{ readonly id: string; readonly kind: 'run' | 'document' | 'flight' | 'replay' }>
  | Readonly<{ readonly generation: string; readonly kind: 'asset'; readonly path: readonly string[]; readonly surfaceId: string }>;

/**
 * Structural view of the optional `@agent-bundle/runtime` peer. The peer's own
 * types must never appear here: this interface reaches the emitted root
 * declarations, and consumers without the optional peer installed could no
 * longer compile against them. Events stay opaque — this route only
 * re-serializes them.
 */
export interface AgentDocumentRuntimeModule {
  readonly decodeAgentFlight: (
    flight: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ) => AsyncIterable<unknown>;
}

export interface RuntimeRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly loadAgentDocumentRuntime?: () => Promise<AgentDocumentRuntimeModule>;
  readonly runtime?: DevRuntimeSession;
}

let agentDocumentRuntimePromise: Promise<AgentDocumentRuntimeModule> | undefined;

/**
 * Agent Document projection is loaded only for its read route. The runtime is
 * an optional peer, so importing the dev server must remain safe without it.
 */
const loadAgentDocumentRuntime = async (): Promise<AgentDocumentRuntimeModule> => {
  agentDocumentRuntimePromise ??= import('@agent-bundle/runtime')
    .then((runtime) => Object.freeze({
      decodeAgentFlight: (flight: ReadableStream<Uint8Array>, signal: AbortSignal) =>
        runtime.decodeAgentFlightStream(flight, { limits: runtime.DEFAULT_AGENT_RENDER_LIMITS, signal }),
    }))
    .catch((error: unknown) => {
      agentDocumentRuntimePromise = undefined;
      throw error;
    });
  return agentDocumentRuntimePromise;
};

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });

const requestError = (value: RequestDiagnostic): RequestDiagnostic & Error => Object.assign(
  new Error(value.message),
  value,
);

const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic =>
  typeof value === 'object' && value !== null &&
  typeof (value as Partial<RequestDiagnostic>).code === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).message === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).status === 'number';

const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } }));
};

const responseJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const singleHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const unquoteHeaderValue = (value: string): string | undefined => {
  if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) return value;
  if (!/^"(?:[^"\\\r\n]|\\[\t !-~])*"$/u.test(value)) return undefined;
  return value.slice(1, -1).replace(/\\([\t !-~])/gu, '$1');
};

const isJsonRequest = (request: IncomingMessage): boolean => {
  const contentType = singleHeader(request.headers['content-type']);
  if (contentType === undefined) return false;
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const parameter = parts[0]!;
  const equals = parameter.indexOf('=');
  if (equals < 1 || parameter.slice(0, equals).trim().toLowerCase() !== 'charset') return false;
  return unquoteHeaderValue(parameter.slice(equals + 1).trim())?.toLowerCase() === 'utf-8';
};

const readBody = async (request: IncomingMessage): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > bodyLimit) {
      tooLarge = true;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.once('end', () => {
    if (tooLarge) {
      rejectPromise(requestError(diagnostic('AB8010', 'Request body exceeds 64 KiB.', 413)));
      return;
    }
    resolvePromise(Buffer.concat(chunks).toString('utf8'));
  });
  request.once('error', rejectPromise);
});

const rawPathname = (requestTarget: string | undefined): string =>
  requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const hasQuery = (requestTarget: string | undefined): boolean => requestTarget?.includes('?') ?? false;

const runtimePathError = (): never => {
  throw requestError(diagnostic('AB8202', 'Runtime route path is not valid.', 400));
};

const decodedSegment = (value: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return runtimePathError();
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) return runtimePathError();
  return decoded;
};

const onlyQuery = (requestTarget: string | undefined, name: string | undefined): URLSearchParams => {
  const url = new URL(requestTarget ?? '/', 'http://runtime.invalid');
  if (name === undefined) {
    if (hasQuery(requestTarget)) runtimePathError();
    return url.searchParams;
  }
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || [...url.searchParams].length !== 1) runtimePathError();
  return url.searchParams;
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/runtime' && !pathname.startsWith('/api/runtime/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'runtime') runtimePathError();
  const segments = parts.slice(3).map(decodedSegment);
  if (segments.length === 1 && (segments[0] === 'status' || segments[0] === 'surfaces' || segments[0] === 'runs')) {
    return Object.freeze({ kind: segments[0] });
  }
  if (segments.length === 2 && segments[0] === 'state' && segments[1] === 'reset') return Object.freeze({ kind: 'state-reset' });
  if (segments[0] === 'runs' && segments[1] !== undefined) {
    if (segments.length === 2) return Object.freeze({ id: segments[1], kind: 'run' });
    if (segments.length === 3 && (segments[2] === 'document' || segments[2] === 'flight' || segments[2] === 'replay')) {
      return Object.freeze({ id: segments[1], kind: segments[2] });
    }
  }
  if (segments[0] === 'assets' && segments[1] !== undefined && segments.length > 2) {
    const query = onlyQuery(requestTarget, 'generation');
    const generation = query.get('generation');
    if (generation === null) return runtimePathError();
    return Object.freeze({ generation: decodedSegment(generation), kind: 'asset', path: Object.freeze(segments.slice(2)), surfaceId: segments[1] });
  }
  return runtimePathError();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasOnly = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0');

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8203', 'Runtime request has an invalid shape.', 400));
};

const jsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  if (!isJsonRequest(request)) {
    throw requestError(diagnostic('AB8009', 'Request body must use application/json.', 415));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(request));
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  if (!isRecord(parsed)) return invalidShape();
  return parsed;
};

const jsonValue = (value: unknown): JsonValue => {
  try {
    return freezeJsonValue(value);
  } catch {
    return invalidShape();
  }
};

const invocation = (value: Record<string, unknown>, surfaces: readonly DevRuntimeSurface[]): DevRuntimeInvocationRequest => {
  if (!hasOnly(value, ['expectedGenerationId', 'fixtureId', 'input', 'surfaceId', 'target'])) return invalidShape();
  const { expectedGenerationId, fixtureId, input, surfaceId, target } = value;
  if (
    !nonemptyString(surfaceId) || !nonemptyString(target) || input === undefined ||
    (expectedGenerationId !== undefined && !nonemptyString(expectedGenerationId)) ||
    (fixtureId !== undefined && !nonemptyString(fixtureId))
  ) return invalidShape();
  const surface = surfaces.find((candidate) => candidate.id === surfaceId);
  if (surface === undefined || !surface.targets.includes(target)) return invalidShape();
  if (fixtureId !== undefined && !surface.fixtures.some((fixture) => fixture.id === fixtureId)) return invalidShape();
  return Object.freeze({
    ...(expectedGenerationId === undefined ? {} : { expectedGenerationId: expectedGenerationId as string }),
    ...(fixtureId === undefined ? {} : { fixtureId: fixtureId as string }),
    input: jsonValue(input),
    surfaceId: surfaceId as string,
    target: target as string,
  });
};

const replay = (value: Record<string, unknown>): DevRuntimeReplayRequest => {
  if (!hasOnly(value, ['expectedGenerationId', 'mode', 'runId'])) return invalidShape();
  const { expectedGenerationId, mode, runId } = value;
  if (!nonemptyString(runId) || (mode !== 'exact' && mode !== 'latest') || (expectedGenerationId !== undefined && !nonemptyString(expectedGenerationId))) {
    return invalidShape();
  }
  return Object.freeze({
    ...(expectedGenerationId === undefined ? {} : { expectedGenerationId: expectedGenerationId as string }),
    mode,
    runId: runId as string,
  });
};

const reset = (value: Record<string, unknown>): DevRuntimeStateResetRequest => {
  if (!hasOnly(value, ['expectedGenerationId', 'seed', 'stateStoreId'])) return invalidShape();
  const { expectedGenerationId, seed, stateStoreId } = value;
  if (!nonemptyString(stateStoreId) || (expectedGenerationId !== undefined && !nonemptyString(expectedGenerationId))) return invalidShape();
  return Object.freeze({
    ...(expectedGenerationId === undefined ? {} : { expectedGenerationId: expectedGenerationId as string }),
    ...(seed === undefined ? {} : { seed: jsonValue(seed) }),
    stateStoreId: stateStoreId as string,
  });
};

const historyLimit = (requestTarget: string | undefined): number => {
  const url = new URL(requestTarget ?? '/', 'http://runtime.invalid');
  if (!hasQuery(requestTarget)) return 50;
  const values = url.searchParams.getAll('limit');
  if (values.length !== 1 || [...url.searchParams].length !== 1 || !/^(?:[1-9]|[1-4]\d|50)$/u.test(values[0]!)) runtimePathError();
  return Number(values[0]);
};

const providerSessionId = (session: DevRuntimeSession): string => {
  if (!nonemptyString(session.providerSessionId)) {
    throw requestError(diagnostic('AB8205', 'Runtime request could not be completed.', 500));
  }
  return session.providerSessionId;
};

const assertRunOwned = (session: DevRuntimeSession, run: DevRuntimeRun | undefined): DevRuntimeRun => {
  const provider = providerSessionId(session);
  if (run === undefined) {
    throw new DevRuntimeUnavailableError('Runtime run is not available.');
  }
  if (run.vector.providerSessionId !== provider) {
    throw requestError(diagnostic('AB8205', 'Runtime request could not be completed.', 500));
  }
  return run;
};

const responseAsset = (response: ServerResponse, asset: DevRuntimeAsset, cacheControl?: string): void => {
  if (asset.body.byteLength > assetLimit) {
    throw requestError(diagnostic('AB8205', 'Runtime asset exceeds the allowed size.', 404));
  }
  response.writeHead(200, {
    ...(cacheControl === undefined ? {} : { 'cache-control': cacheControl }),
    'content-length': String(asset.body.byteLength),
    'content-type': asset.contentType,
    'x-content-type-options': 'nosniff',
  });
  response.end(asset.body);
};

/** Fixed runtime browser contract; it never accepts executable provider routing or endpoints. */
export class RuntimeRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #loadAgentDocumentRuntime: () => Promise<AgentDocumentRuntimeModule>;
  readonly #runtime: DevRuntimeSession | undefined;
  #closed = false;

  constructor(options: RuntimeRoutesOptions) {
    this.#authorize = options.authorize;
    this.#loadAgentDocumentRuntime = options.loadAgentDocumentRuntime ?? loadAgentDocumentRuntime;
    this.#runtime = options.runtime;
  }

  close(): void {
    this.#closed = true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    if (parsed.kind !== 'status' && parsed.kind !== 'surfaces') this.#authorize(request);
    if (this.#closed) throw requestError(diagnostic('AB8201', 'Development runtime is not available.', 404));
    try {
      await this.#dispatch(parsed, request, response);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      if (error instanceof DevRuntimeGenerationConflictError) {
        throw requestError(diagnostic(error.code, error.message, 409));
      }
      if (error instanceof DevRuntimeUnavailableError) {
        throw requestError(diagnostic(error.code, error.message, 404));
      }
      throw requestError(diagnostic('AB8205', 'Runtime request could not be completed.', 500));
    }
    return true;
  }

  #session(): DevRuntimeSession {
    if (this.#runtime === undefined) throw new DevRuntimeUnavailableError();
    return this.#runtime;
  }

  async #dispatch(parsed: Route, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    if (parsed.kind === 'status') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      onlyQuery(request.url, undefined);
      return responseJson(response, { status: this.#runtime?.status() ?? null });
    }
    if (parsed.kind === 'surfaces') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      onlyQuery(request.url, undefined);
      return responseJson(response, { surfaces: this.#runtime?.surfaces() ?? [] });
    }
    const session = this.#session();
    if (parsed.kind === 'runs') {
      if (method === 'POST') {
        onlyQuery(request.url, undefined);
        return responseJson(response, {
          run: assertRunOwned(session, await session.invoke(invocation(await jsonBody(request), session.surfaces()))),
        });
      }
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const limit = historyLimit(request.url);
      const provider = providerSessionId(session);
      const runs = [...session.runs(limit)].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
      if (runs.some((run) => run.vector.providerSessionId !== provider)) {
        throw requestError(diagnostic('AB8205', 'Runtime request could not be completed.', 500));
      }
      return responseJson(response, { providerSessionId: provider, runs });
    }
    if (parsed.kind === 'run') {
      onlyQuery(request.url, undefined);
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { run: assertRunOwned(session, session.run(parsed.id)) });
    }
    if (parsed.kind === 'flight') {
      onlyQuery(request.url, undefined);
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const run = assertRunOwned(session, session.run(parsed.id));
      if (run.status !== 'succeeded') throw new DevRuntimeUnavailableError('Runtime run is not available.');
      const asset = await session.readRunFlight(run.id);
      if (asset === undefined) throw new DevRuntimeUnavailableError('Runtime run is not available.');
      return responseAsset(response, { ...asset, contentType: 'application/octet-stream' }, 'no-store');
    }
    if (parsed.kind === 'document') {
      onlyQuery(request.url, undefined);
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const run = assertRunOwned(session, session.run(parsed.id));
      if (run.status !== 'succeeded') throw new DevRuntimeUnavailableError('Runtime run is not available.');
      const asset = await session.readRunFlight(run.id);
      if (asset === undefined) throw new DevRuntimeUnavailableError('Runtime run is not available.');
      let runtime: AgentDocumentRuntimeModule;
      try {
        runtime = await this.#loadAgentDocumentRuntime();
      } catch {
        throw requestError(diagnostic(
          'AB8207',
          'Agent Document decoding requires the optional @agent-bundle/runtime peer.',
          503,
        ));
      }
      try {
        const abortController = new AbortController();
        const flight = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(asset.body);
            controller.close();
          },
        });
        const events: unknown[] = [];
        let responseBytes = Buffer.byteLength('{"events":[]}');
        for await (const event of runtime.decodeAgentFlight(flight, abortController.signal)) {
          const eventBytes = Buffer.byteLength(JSON.stringify(event));
          const separatorBytes = events.length === 0 ? 0 : 1;
          if (responseBytes + separatorBytes + eventBytes > agentDocumentResponseLimit) {
            abortController.abort();
            throw requestError(diagnostic(
              'AB8209',
              'Decoded Agent Document exceeds the 16 MiB response limit.',
              413,
            ));
          }
          responseBytes += separatorBytes + eventBytes;
          events.push(event);
        }
        return responseJson(response, { events });
      } catch (error) {
        if (isRequestDiagnostic(error)) throw error;
        throw requestError(diagnostic('AB8208', 'Stored Flight could not be decoded as an Agent Document.', 409));
      }
    }
    if (parsed.kind === 'replay') {
      onlyQuery(request.url, undefined);
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const replayRequest = replay(await jsonBody(request));
      if (replayRequest.runId !== parsed.id) return invalidShape();
      return responseJson(response, { run: assertRunOwned(session, await session.replay(replayRequest)) });
    }
    if (parsed.kind === 'state-reset') {
      onlyQuery(request.url, undefined);
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { state: await session.resetState(reset(await jsonBody(request))) });
    }
    if (parsed.kind !== 'asset') return;
    if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    const asset = await session.readAsset({
      path: parsed.path,
      runtimeGenerationId: parsed.generation,
      surfaceId: parsed.surfaceId,
    });
    if (asset === undefined) throw new DevRuntimeUnavailableError('Runtime asset is not available.');
    return responseAsset(response, asset);
  }
}
