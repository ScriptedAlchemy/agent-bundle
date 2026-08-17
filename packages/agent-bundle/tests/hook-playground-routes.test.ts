import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  HookPlaygroundRoutes,
  type HookPlaygroundRouteService,
} from '../src/dev/hook-playground-routes.ts';
import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundListOptions,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
  HookPlaygroundSimulationOptions,
} from '../src/dev/hook-playground-service.ts';
import { HookSimulationAbortError } from '../src/services/hook-service.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: HookPlaygroundRoutes;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers.origin !== 'http://127.0.0.1:4567') {
    throw routeError('AB8003', 'Request origin is not this foreground server.', 403);
  }
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

const startRoutes = async (
  service?: HookPlaygroundRouteService,
  onAuthorize?: () => void,
): Promise<StartedRoutes> => {
  const routes = new HookPlaygroundRoutes({
    authorize: (request) => {
      authorize(request);
      onAuthorize?.();
    },
    ...(service === undefined ? {} : { service }),
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; message: string; status: number }>;
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ diagnostic: {
        code: diagnostic.code ?? 'AB8007',
        message: diagnostic.message ?? 'Request could not be completed.',
      } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      await routes.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};

const hookFixture: HookPlaygroundHook = Object.freeze({
  binding: Object.freeze({ epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }),
  hook: Object.freeze({
    event: 'sessionStart',
    id: 'hook-a',
    name: 'guard',
    path: 'hooks/guard.mjs',
    target: 'claude',
  }),
});

const simulationFixture: HookPlaygroundSimulation = Object.freeze({
  binding: Object.freeze({ epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }),
  canonicalIntent: Object.freeze({
    event: 'sessionStart',
    hook: 'hook-a',
    input: Object.freeze({ prompt: 'hello' }),
  }),
  canonicalResult: Object.freeze({ decision: 'allow' }),
  hostMapping: Object.freeze({
    canonicalEvent: 'sessionStart',
    nativeEvent: 'SessionStart',
    nativeProjection: 'deterministic',
    nativeSelector: 'hooks.SessionStart[0]',
    target: 'claude',
    wrapperPath: 'hooks/guard.mjs',
  }),
  nativeInput: Object.freeze({ prompt: 'hello' }),
  nativeOutput: Object.freeze({ decision: 'approve' }),
  replay: Object.freeze({
    binding: Object.freeze({ epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }),
    input: Object.freeze({ prompt: 'hello' }),
  }),
});

const diagnosticFixture: HookPlaygroundDiagnosticResult = Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: 'hook.playground.target.unsupported' as const,
    event: 'sessionStart',
    message: 'Target "codex" does not support this hook event.',
    severity: 'error' as const,
    target: 'codex',
  })]),
});

class RecordingService implements HookPlaygroundRouteService {
  readonly calls: unknown[] = [];
  diagnose = false;
  failure: Error | undefined;
  /** Resolves the pending simulation so abort behavior is observable. */
  pending: ((value: HookPlaygroundSimulation) => void) | undefined;
  aborted = false;

  async list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    this.calls.push({ kind: 'list', options: { ...options } });
    if (this.failure !== undefined) throw this.failure;
    return Object.freeze([hookFixture]);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    const { signal, ...recorded } = options;
    this.calls.push({ kind: 'simulate', options: recorded, signalled: signal !== undefined });
    if (this.failure !== undefined) throw this.failure;
    if (this.diagnose) return diagnosticFixture;
    if (this.pending !== undefined) {
      const entered = this.pending;
      this.pending = undefined;
      return new Promise<HookPlaygroundSimulation>((_resolvePromise, rejectPromise) => {
        signal?.addEventListener('abort', () => {
          this.aborted = true;
          rejectPromise(signal?.reason);
        });
        entered(simulationFixture);
      });
    }
    return simulationFixture;
  }

  async replay(
    replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    this.calls.push({
      kind: 'replay',
      replay: { binding: { ...replay.binding }, input: replay.input },
      signalled: options?.signal !== undefined,
    });
    if (this.failure !== undefined) throw this.failure;
    if (this.diagnose) return diagnosticFixture;
    return simulationFixture;
  }
}

const headers = (): Readonly<Record<string, string>> => ({
  origin: 'http://127.0.0.1:4567',
  'x-agent-bundle-session': 'test-session-token',
});

const jsonHeaders = (): Readonly<Record<string, string>> => ({ ...headers(), 'content-type': 'application/json' });

const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
  body: JSON.stringify(body),
  headers: jsonHeaders(),
  method: 'POST',
});

it('lists epoch-bound hooks and forwards only the declared filter', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const listed = await fetch(`${started.url}/api/hooks?epochId=epoch-a&target=claude`, { headers: headers() });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ hooks: [hookFixture] });

    const unfiltered = await fetch(`${started.url}/api/hooks?epochId=epoch-a`, { headers: headers() });
    expect(unfiltered.status).toBe(200);
    expect(service.calls).toEqual([
      { kind: 'list', options: { epochId: 'epoch-a', target: 'claude' } },
      { kind: 'list', options: { epochId: 'epoch-a' } },
    ]);
  } finally {
    await started.close();
  }
});

it('rejects hook list queries that omit or smuggle parameters', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const queries = [
      '',
      '?target=claude',
      '?epochId=',
      '?epochId=epoch-a&epochId=epoch-b',
      '?epochId=epoch-a&artifact=/tmp/untrusted',
      '?epochId=epoch-a&target=claude&command=/tmp/untrusted',
    ];
    for (const query of queries) {
      const rejected = await fetch(`${started.url}/api/hooks${query}`, { headers: headers() });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8032', message: 'Hook playground request has an invalid shape.' },
      });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('simulates equivalently from inline and fixture canonical input', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const inline = await post(`${started.url}/api/hooks/simulations`, {
      epochId: 'epoch-a',
      hook: 'hook-a',
      input: { inline: { prompt: 'hello' } },
      target: 'claude',
    });
    expect(inline.status).toBe(200);
    const inlineBody = await inline.json();
    expect(inlineBody).toEqual({ simulation: simulationFixture });

    const fixture = await post(`${started.url}/api/hooks/simulations`, {
      epochId: 'epoch-a',
      hook: 'hook-a',
      input: { fixture: { prompt: 'hello' } },
      target: 'claude',
    });
    expect(fixture.status).toBe(200);
    await expect(fixture.json()).resolves.toEqual(inlineBody);

    expect(service.calls).toEqual([
      {
        kind: 'simulate',
        options: { epochId: 'epoch-a', hook: 'hook-a', input: { inline: { prompt: 'hello' } }, target: 'claude' },
        signalled: true,
      },
      {
        kind: 'simulate',
        options: { epochId: 'epoch-a', hook: 'hook-a', input: { fixture: { prompt: 'hello' } }, target: 'claude' },
        signalled: true,
      },
    ]);
  } finally {
    await started.close();
  }
});

it('returns unsupported mapping diagnostics as a visible result rather than an error', async () => {
  const service = new RecordingService();
  service.diagnose = true;
  const started = await startRoutes(service);

  try {
    const simulated = await post(`${started.url}/api/hooks/simulations`, {
      epochId: 'epoch-a',
      hook: 'hook-a',
      input: { inline: { prompt: 'hello' } },
      target: 'codex',
    });
    expect(simulated.status).toBe(200);
    await expect(simulated.json()).resolves.toEqual(diagnosticFixture);
  } finally {
    await started.close();
  }
});

it('replays a saved case against its original epoch binding', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const replayed = await post(`${started.url}/api/hooks/replays`, {
      binding: { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' },
      input: { prompt: 'hello' },
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ simulation: simulationFixture });
    expect(service.calls).toEqual([{
      kind: 'replay',
      replay: { binding: { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }, input: { prompt: 'hello' } },
      signalled: true,
    }]);
  } finally {
    await started.close();
  }
});

it('rejects invalid and smuggled hook simulation and replay bodies', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const simulations = [
      { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: {}, target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: { fixture: { a: 1 }, inline: { a: 1 } }, target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: { inline: [] }, target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: { inline: 'prompt' }, target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: { inline: { a: 1 }, path: '/tmp/untrusted' }, target: 'claude' },
      { epochId: '', hook: 'hook-a', input: { inline: { a: 1 } }, target: 'claude' },
      { epochId: 'epoch-a', hook: 'hook-a', input: { inline: { a: 1 } }, target: '' },
      { command: '/tmp/untrusted', epochId: 'epoch-a', hook: 'hook-a', input: { inline: {} }, target: 'claude' },
      { artifact: '/tmp/untrusted', epochId: 'epoch-a', hook: 'hook-a', input: { inline: { a: 1 } }, target: 'claude' },
    ];
    for (const body of simulations) {
      const rejected = await post(`${started.url}/api/hooks/simulations`, body);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8032', message: 'Hook playground request has an invalid shape.' },
      });
    }

    const replays = [
      { binding: { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' } },
      { input: { prompt: 'hello' } },
      { binding: { epochId: 'epoch-a', hook: 'hook-a' }, input: { prompt: 'hello' } },
      { binding: { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }, input: [] },
      { binding: { command: '/tmp/untrusted', epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }, input: {} },
      { binding: { epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }, input: {}, artifact: '/tmp/untrusted' },
    ];
    for (const body of replays) {
      const rejected = await post(`${started.url}/api/hooks/replays`, body);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8032', message: 'Hook playground request has an invalid shape.' },
      });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('rejects unsupported hook playground methods, media types, and paths', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const method = await fetch(`${started.url}/api/hooks?epochId=epoch-a`, { headers: headers(), method: 'DELETE' });
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toEqual({
      diagnostic: { code: 'AB8007', message: 'Route does not accept this method.' },
    });

    const listPost = await post(`${started.url}/api/hooks`, {});
    expect(listPost.status).toBe(405);

    const media = await fetch(`${started.url}/api/hooks/simulations`, {
      body: 'epochId=epoch-a',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });
    expect(media.status).toBe(415);
    await expect(media.json()).resolves.toEqual({
      diagnostic: { code: 'AB8009', message: 'Request body must use application/json.' },
    });

    const invalidJson = await fetch(`${started.url}/api/hooks/simulations`, {
      body: '{',
      headers: jsonHeaders(),
      method: 'POST',
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      diagnostic: { code: 'AB8001', message: 'Request body must be valid JSON.' },
    });

    const oversized = await fetch(`${started.url}/api/hooks/simulations`, {
      body: JSON.stringify({
        epochId: 'epoch-a',
        hook: 'hook-a',
        input: { inline: { prompt: 'x'.repeat(70 * 1024) } },
        target: 'claude',
      }),
      headers: jsonHeaders(),
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      diagnostic: { code: 'AB8010', message: 'Request body exceeds 64 KiB.' },
    });

    const unknownPath = await fetch(`${started.url}/api/hooks/simulations/extra`, { headers: headers() });
    expect(unknownPath.status).toBe(400);
    await expect(unknownPath.json()).resolves.toEqual({
      diagnostic: { code: 'AB8030', message: 'Hook playground route path is not valid.' },
    });

    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('requires the same-session guard before reading any hook state', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const unauthorized = await fetch(`${started.url}/api/hooks?epochId=epoch-a`, {
      headers: { origin: 'http://127.0.0.1:4567' },
    });
    expect(unauthorized.status).toBe(403);
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('reports an absent or closed hook playground service without leaking internals', async () => {
  const absent = await startRoutes();
  try {
    const unavailable = await fetch(`${absent.url}/api/hooks?epochId=epoch-a`, { headers: headers() });
    expect(unavailable.status).toBe(404);
    await expect(unavailable.json()).resolves.toEqual({
      diagnostic: { code: 'AB8031', message: 'Hook playground routes are not available.' },
    });
  } finally {
    await absent.close();
  }

  const service = new RecordingService();
  service.failure = new Error('/private/epoch/path could not be read');
  const started = await startRoutes(service);
  try {
    const failed = await post(`${started.url}/api/hooks/simulations`, {
      epochId: 'epoch-a',
      hook: 'hook-a',
      input: { inline: { prompt: 'hello' } },
      target: 'claude',
    });
    expect(failed.status).toBe(502);
    const body = await failed.json();
    expect(body).toEqual({
      diagnostic: { code: 'AB8033', message: 'Hook playground operation could not be completed.' },
    });

    await started.routes.close();
    const closed = await fetch(`${started.url}/api/hooks?epochId=epoch-a`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8031', message: 'Hook playground routes are not available.' },
    });
  } finally {
    await started.close();
  }
});

it('cancels an in-flight simulation when its request is abandoned', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  const reached = new Promise<void>((resolvePromise) => {
    service.pending = () => resolvePromise();
  });

  try {
    const controller = new AbortController();
    const request = fetch(`${started.url}/api/hooks/simulations`, {
      body: JSON.stringify({
        epochId: 'epoch-a',
        hook: 'hook-a',
        input: { inline: { prompt: 'hello' } },
        target: 'claude',
      }),
      headers: jsonHeaders(),
      method: 'POST',
      signal: controller.signal,
    });
    const settled = request.catch(() => undefined);
    await reached;
    controller.abort();
    await settled;

    const deadline = Date.now() + 2_000;
    while (!service.aborted) {
      if (Date.now() >= deadline) throw new Error('Hook simulation was not aborted.');
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(service.aborted).toBe(true);
  } finally {
    await started.close();
  }
});

/**
 * Every operation settles only after shutdown aborts it, so a close that does not
 * drain its wrapper processes and simulation clones is directly observable.
 */
class DrainingService implements HookPlaygroundRouteService {
  readonly aborts: string[] = [];
  readonly calls: string[] = [];
  readonly failures = new Map<string, Error>();
  readonly settlements: string[] = [];
  readonly #admissions = new Map<string, () => void>();

  /** Resolves once the named operation has reached the service. */
  admitted(operation: string): Promise<void> {
    return new Promise<void>((resolvePromise) => this.#admissions.set(operation, resolvePromise));
  }

  async list(_options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    this.calls.push('list');
    return Object.freeze([hookFixture]);
  }

  async replay(
    _replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    return this.#run('replay', options?.signal);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    return this.#run('simulation', options.signal);
  }

  async #run(operation: string, signal: AbortSignal | undefined): Promise<HookPlaygroundSimulation> {
    this.calls.push(operation);
    this.#admissions.get(operation)?.();
    return new Promise<HookPlaygroundSimulation>((_resolvePromise, rejectPromise) => {
      signal?.addEventListener('abort', () => {
        this.aborts.push(operation);
        setTimeout(() => {
          this.settlements.push(operation);
          rejectPromise(this.failures.get(operation) ?? signal?.reason);
        }, 20);
      });
    });
  }
}

const simulationBody = Object.freeze({
  epochId: 'epoch-a',
  hook: 'hook-a',
  input: Object.freeze({ inline: Object.freeze({ prompt: 'hello' }) }),
  target: 'claude',
});

const replayBody = Object.freeze({
  binding: Object.freeze({ epochId: 'epoch-a', hook: 'hook-a', target: 'claude' }),
  input: Object.freeze({ prompt: 'hello' }),
});

/** Sends a hook simulation whose body is completed only when the test releases it. */
const streamedSimulation = (url: string): {
  readonly finish: (tail: string) => void;
  readonly response: Promise<{ readonly body: string; readonly status: number }>;
} => {
  const target = new URL(`${url}/api/hooks/simulations`);
  const client = httpRequest({
    headers: jsonHeaders(),
    host: target.hostname,
    method: 'POST',
    path: target.pathname,
    port: target.port,
  });
  const response = new Promise<{ readonly body: string; readonly status: number }>((resolvePromise, rejectPromise) => {
    client.once('response', (message) => {
      let body = '';
      message.setEncoding('utf8');
      message.on('data', (chunk: string) => { body += chunk; });
      message.once('end', () => resolvePromise({ body, status: message.statusCode ?? 0 }));
    });
    client.once('error', rejectPromise);
  });
  client.write('{"epochId":"epoch-a","hook":"hook-a",');
  return Object.freeze({ finish: (tail: string) => client.end(tail), response });
};

it('drains a delayed simulation and replay before shutdown resolves', async () => {
  const service = new DrainingService();
  const started = await startRoutes(service);
  const admitted = Promise.all([service.admitted('simulation'), service.admitted('replay')]);

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    const replay = post(`${started.url}/api/hooks/replays`, replayBody);
    await admitted;

    await started.routes.close();

    expect(service.aborts).toEqual(['simulation', 'replay']);
    expect(service.settlements).toEqual(['simulation', 'replay']);
    expect((await simulation).status).toBe(502);
    expect((await replay).status).toBe(502);
  } finally {
    await started.close();
  }
});

it('reports a drained simulation failure with a stable structured identity', async () => {
  const service = new DrainingService();
  service.failures.set('simulation', new Error('/tmp/agent-bundle-hook-playground-a could not be removed'));
  const started = await startRoutes(service);
  const admitted = service.admitted('simulation');

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    await admitted;

    await expect(started.routes.close()).rejects.toMatchObject({
      code: 'AB8034',
      failures: [{ error: service.failures.get('simulation'), operation: 'simulation' }],
      name: 'HookPlaygroundCloseError',
    });
    expect(service.settlements).toEqual(['simulation']);
    expect((await simulation).status).toBe(502);
  } finally {
    await started.close().catch(() => undefined);
  }
});

it('shares one shutdown outcome across concurrent and repeated close calls', async () => {
  const service = new DrainingService();
  service.failures.set('simulation', new Error('simulation clone could not be released'));
  const started = await startRoutes(service);
  const admitted = service.admitted('simulation');

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    await admitted;

    const first = started.routes.close().catch((error: unknown) => error);
    const second = started.routes.close().catch((error: unknown) => error);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    const third = await started.routes.close().catch((error: unknown) => error);

    expect(secondOutcome).toBe(firstOutcome);
    expect(third).toBe(firstOutcome);
    expect(service.aborts).toEqual(['simulation']);
    expect(service.settlements).toEqual(['simulation']);
    expect((await simulation).status).toBe(502);
  } finally {
    await started.close().catch(() => undefined);
  }
});

it('refuses hook operations admitted once shutdown has begun', async () => {
  const service = new DrainingService();
  let reachedAuthorize!: () => void;
  const authorized = new Promise<void>((resolvePromise) => { reachedAuthorize = resolvePromise; });
  const started = await startRoutes(service, () => reachedAuthorize());

  try {
    const streamed = streamedSimulation(started.url);
    await authorized;
    const closing = started.routes.close();
    streamed.finish('"input":{"inline":{"prompt":"hello"}},"target":"claude"}');
    await closing;

    const raced = await streamed.response;
    expect(raced.status).toBe(503);
    expect(JSON.parse(raced.body)).toEqual({
      diagnostic: { code: 'AB8031', message: 'Hook playground routes are not available.' },
    });

    const rejected = await post(`${started.url}/api/hooks/simulations`, simulationBody);
    expect(rejected.status).toBe(503);
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

/** Re-enters shutdown from its own abort callback, as a cleanup listener would. */
class ReentrantCloseService implements HookPlaygroundRouteService {
  nested: Promise<void> | undefined;
  routes: HookPlaygroundRoutes | undefined;
  readonly #admitted: Promise<void>;
  #admit!: () => void;

  constructor() {
    this.#admitted = new Promise<void>((resolvePromise) => { this.#admit = resolvePromise; });
  }

  get admitted(): Promise<void> {
    return this.#admitted;
  }

  async list(_options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    return Object.freeze([hookFixture]);
  }

  async replay(
    _replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<never> {
    return this.#run(options?.signal);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<never> {
    return this.#run(options.signal);
  }

  #run(signal: AbortSignal | undefined): Promise<never> {
    this.#admit();
    return new Promise<never>((_resolvePromise, rejectPromise) => {
      const cancel = (): void => {
        this.nested = this.routes?.close();
        rejectPromise(signal?.reason);
      };
      if (signal === undefined || signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

it('publishes one shutdown outcome before any abort callback can re-enter close', async () => {
  const service = new ReentrantCloseService();
  const started = await startRoutes(service);
  service.routes = started.routes;

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    await service.admitted;

    const first = started.routes.close();
    expect(service.nested).toBe(first);
    await first;
    expect((await simulation).status).toBe(502);
  } finally {
    await started.close();
  }
});

/** Begins shutdown synchronously while the route is still admitting the operation. */
class ShutdownDuringAdmissionService implements HookPlaygroundRouteService {
  aborted = false;
  closing: Promise<void> | undefined;
  routes: HookPlaygroundRoutes | undefined;
  readonly #admitted: Promise<void>;
  #admit!: () => void;

  constructor() {
    this.#admitted = new Promise<void>((resolvePromise) => { this.#admit = resolvePromise; });
  }

  get admitted(): Promise<void> {
    return this.#admitted;
  }

  async list(_options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    return Object.freeze([hookFixture]);
  }

  async replay(
    _replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<never> {
    return this.#run(options?.signal);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<never> {
    return this.#run(options.signal);
  }

  #run(signal: AbortSignal | undefined): Promise<never> {
    this.closing = this.routes?.close();
    this.#admit();
    return new Promise<never>((_resolvePromise, rejectPromise) => {
      const cancel = (): void => {
        this.aborted = true;
        rejectPromise(signal?.reason);
      };
      if (signal === undefined || signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

it('drains an operation whose service begins shutdown during its own admission', async () => {
  const service = new ShutdownDuringAdmissionService();
  const started = await startRoutes(service);
  service.routes = started.routes;
  const client = new AbortController();

  try {
    const simulation = fetch(`${started.url}/api/hooks/simulations`, {
      body: JSON.stringify(simulationBody),
      headers: jsonHeaders(),
      method: 'POST',
      signal: client.signal,
    }).then((response) => response.status, () => undefined);
    await service.admitted;

    await service.closing;

    expect(service.aborted).toBe(true);
    expect(await simulation).toBe(502);
  } finally {
    client.abort();
    await started.close();
  }
});

it('reports a cleanup failure that reuses the executor cancellation message', async () => {
  const service = new DrainingService();
  const failure = new Error('Hook simulation aborted.');
  service.failures.set('simulation', failure);
  const started = await startRoutes(service);
  const admitted = service.admitted('simulation');

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    await admitted;

    await expect(started.routes.close()).rejects.toMatchObject({
      code: 'AB8034',
      failures: [{ error: failure, operation: 'simulation' }],
      name: 'HookPlaygroundCloseError',
    });
    expect((await simulation).status).toBe(502);
  } finally {
    await started.close().catch(() => undefined);
  }
});

/**
 * A name is not an identity either. A simulation clone that could not be removed,
 * or a wrapper process tree that refused to settle, stays a real shutdown failure
 * even when it reproduces the executor cancellation's name, message, and code.
 */
it('retains a cleanup failure that reproduces the executor cancellation surface', async () => {
  const forged = [
    Object.assign(new Error('Hook simulation aborted.'), {
      code: 'hook.simulation.aborted',
      name: 'AbortError',
    }),
    Object.assign(new Error('Hook simulation aborted. Wrapper process tree did not settle after termination.'), {
      code: 'hook.simulation.termination.unsettled',
      name: 'HookSimulationTerminationError',
    }),
  ];

  for (const failure of forged) {
    const service = new DrainingService();
    service.failures.set('simulation', failure);
    const started = await startRoutes(service);
    const admitted = service.admitted('simulation');

    try {
      const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
      await admitted;

      await expect(started.routes.close()).rejects.toMatchObject({
        code: 'AB8034',
        failures: [{ error: failure, operation: 'simulation' }],
        name: 'HookPlaygroundCloseError',
      });
      expect(service.settlements).toEqual(['simulation']);
      expect((await simulation).status).toBe(502);
    } finally {
      await started.close().catch(() => undefined);
    }
  }
});

it('keeps the executor cancellation itself silent even when shutdown races its settlement', async () => {
  const service = new DrainingService();
  service.failures.set('simulation', new HookSimulationAbortError());
  const started = await startRoutes(service);
  const admitted = service.admitted('simulation');

  try {
    const simulation = post(`${started.url}/api/hooks/simulations`, simulationBody);
    await admitted;

    await expect(started.routes.close()).resolves.toBeUndefined();
    expect(service.settlements).toEqual(['simulation']);
    expect((await simulation).status).toBe(502);
  } finally {
    await started.close();
  }
});
