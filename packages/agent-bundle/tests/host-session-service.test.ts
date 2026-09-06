import { expect, it } from '@rstest/core';

import type { HostSessionStreamMessage } from '../src/dev/sessions/host-session-service.ts';
import {
  HostSessionError,
  HostSessionService,
} from '../src/dev/sessions/host-session-service.ts';
import type {
  PtyAdapter,
  PtyProcess,
  PtySpawnOptions,
} from '../src/dev/sessions/pty.ts';

class FakePty implements PtyProcess {
  readonly kills: NodeJS.Signals[] = [];
  readonly resizes: Array<readonly [number, number]> = [];
  readonly writes: string[] = [];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>();

  constructor(readonly pid: number) {}

  emitData(data: string): void {
    for (const listener of this.#data) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.#exit) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.kills.push(signal);
  }

  onData(listener: (data: string) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): () => void {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  write(data: string): void {
    this.writes.push(data);
  }
}

class FakeAdapter implements PtyAdapter {
  readonly spawns: Array<{
    readonly args: readonly string[];
    readonly file: string;
    readonly options: PtySpawnOptions;
    readonly pty: FakePty;
  }> = [];

  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess {
    const pty = new FakePty(4_000 + this.spawns.length);
    this.spawns.push({ args, file, options, pty });
    return pty;
  }
}

const serviceFor = (adapter: FakeAdapter, overrides: Partial<ConstructorParameters<typeof HostSessionService>[0]> = {}) =>
  new HostSessionService({
    attached: () => ({ destination: '/host/install', epochId: 'epoch-a' }),
    currentEpochId: () => 'epoch-a',
    environment: {
      AGENT_BUNDLE_DEV_TRACE_TOKEN: 'trace-token',
      AGENT_BUNDLE_DEV_TRACE_URL: 'http://127.0.0.1/trace',
      PATH: '/bin',
    },
    loadPty: () => adapter,
    now: () => 1_780_000_000_000,
    projectRoot: '/work/project',
    resolveExecutable: async (host) => `/usr/bin/${host}`,
    ...overrides,
  });

it('launches fixed host argv and exposes authority and environment', async () => {
  const adapter = new FakeAdapter();
  const traces: unknown[] = [];
  const service = serviceFor(adapter, {
    trace: { publish: (entry) => traces.push(entry) as never },
  });

  const session = await service.create({ cols: 120, host: 'claude', prompt: 'inspect it', rows: 32 });

  expect(session).toMatchObject({
    authority: { epochId: 'epoch-a', install: '/host/install', projectRoot: '/work/project' },
    cols: 120,
    host: 'claude',
    prompt: 'inspect it',
    rows: 32,
    state: 'running',
  });
  expect(session.id).toMatch(/^hs_[0-9a-z]{16}$/u);
  expect(adapter.spawns[0]).toMatchObject({
    args: ['inspect it'],
    file: '/usr/bin/claude',
    options: { cols: 120, cwd: '/work/project', name: 'xterm-256color', rows: 32 },
  });
  expect(adapter.spawns[0]?.options.env).toMatchObject({
    AGENT_BUNDLE_DEV_SESSION: session.id,
    AGENT_BUNDLE_DEV_TRACE_TOKEN: 'trace-token',
    AGENT_BUNDLE_DEV_TRACE_URL: 'http://127.0.0.1/trace',
    COLORTERM: 'truecolor',
    TERM: 'xterm-256color',
  });
  expect(JSON.stringify(traces)).not.toContain('inspect it');
  expect(traces).toMatchObject([{
    correlation: { epochId: 'epoch-a', host: 'claude', sessionId: session.id },
    details: { host: 'claude', pid: 4_000 },
    href: `/sessions?session=${session.id}`,
    kind: 'session.started',
    source: 'session',
  }]);
});

it('reports unavailable hosts and enforces four live sessions', async () => {
  const missing = serviceFor(new FakeAdapter(), { resolveExecutable: async () => undefined });
  await expect(missing.availability()).resolves.toMatchObject([
    { host: 'claude', launchable: false, reason: 'claude is not on PATH' },
    { host: 'codex', launchable: false, reason: 'codex is not on PATH' },
  ]);
  await expect(missing.create({ cols: 80, host: 'claude', rows: 24 })).rejects.toMatchObject({ code: 'AB8263' });

  const service = serviceFor(new FakeAdapter());
  for (let index = 0; index < 4; index += 1) {
    await service.create({ cols: 80, host: index % 2 === 0 ? 'claude' : 'codex', rows: 24 });
  }
  await expect(service.create({ cols: 80, host: 'claude', rows: 24 })).rejects.toMatchObject({ code: 'AB8264' });
});

it('replays bounded scrollback before live output', async () => {
  const adapter = new FakeAdapter();
  const service = serviceFor(adapter, { scrollbackBytes: 8 });
  const session = await service.create({ cols: 80, host: 'codex', rows: 24 });
  adapter.spawns[0]!.pty.emitData('discard');
  adapter.spawns[0]!.pty.emitData('retained');
  const messages: HostSessionStreamMessage[] = [];

  const unsubscribe = service.subscribe(session.id, (message) => messages.push(message));
  adapter.spawns[0]!.pty.emitData('live');

  expect(messages.map((message) => message.type)).toEqual(['state', 'output', 'output']);
  expect(messages.slice(1)).toEqual([
    { data: Buffer.from('retained').toString('base64'), type: 'output' },
    { data: Buffer.from('live').toString('base64'), type: 'output' },
  ]);
  unsubscribe();
});

it('attaches the host trace id and uses it for later lifecycle entries', async () => {
  const adapter = new FakeAdapter();
  const traces: Array<{ readonly correlation?: { readonly sessionId?: string }; readonly kind?: string }> = [];
  const service = serviceFor(adapter, {
    trace: { publish: (entry) => traces.push(entry) as never },
  });
  const session = await service.create({ cols: 80, host: 'claude', rows: 24 });
  const messages: HostSessionStreamMessage[] = [];
  service.subscribe(session.id, (message) => messages.push(message));

  service.attach(session.id, 'host-session-42');
  service.attach('hs_0000000000000000', 'ignored');
  service.attach(session.id, undefined);

  expect(service.traceSessionId(session.id)).toBe('host-session-42');
  expect(service.traceSessionId('hs_0000000000000000')).toBe('hs_0000000000000000');
  expect(service.read(session.id)).toMatchObject({ traceSessionId: 'host-session-42' });
  expect(messages.at(-1)).toMatchObject({ session: { traceSessionId: 'host-session-42' }, type: 'state' });
  expect(traces.at(-1)).toMatchObject({
    correlation: { sessionId: 'host-session-42' },
    details: { host: 'claude', hostSessionId: 'host-session-42' },
    kind: 'session.attached',
  });

  adapter.spawns[0]!.pty.emitExit(0);
  expect(traces.at(-1)).toMatchObject({
    correlation: { sessionId: 'host-session-42' },
    kind: 'session.exited',
  });
});

it('terminates with SIGKILL fallback and restarts with the prompt', async () => {
  const adapter = new FakeAdapter();
  const service = serviceFor(adapter, { terminationGraceMs: 5 });
  const original = await service.create({ cols: 90, host: 'claude', prompt: 'seed', rows: 30 });
  const terminating = service.terminate(original.id);
  await expect.poll(() => adapter.spawns[0]?.pty.kills).toEqual(['SIGTERM', 'SIGKILL']);
  adapter.spawns[0]!.pty.emitExit(137, 9);
  await expect(terminating).resolves.toMatchObject({ signal: 'SIGKILL', state: 'terminated' });

  const restarted = await service.restart(original.id, { cols: 100, rows: 40 });
  expect(restarted).toMatchObject({ prompt: 'seed', restartOf: original.id, state: 'running' });
  expect(adapter.spawns[1]).toMatchObject({ args: ['seed'], options: { cols: 100, rows: 40 } });
});

it('validates controls and forgets only exited sessions', async () => {
  const adapter = new FakeAdapter();
  const service = serviceFor(adapter);
  const session = await service.create({ cols: 80, host: 'codex', rows: 24 });
  expect(() => service.input(session.id, 'x'.repeat(16 * 1024 + 1))).toThrow(HostSessionError);
  expect(() => service.resize(session.id, 0, 24)).toThrow(HostSessionError);
  expect(() => service.forget(session.id)).toThrow(expect.objectContaining({ code: 'AB8261', status: 409 }));
  adapter.spawns[0]!.pty.emitExit(0);
  expect(service.forget(session.id)).toBe(true);
  expect(service.read(session.id)).toBeUndefined();
});
