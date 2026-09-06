import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import { diagnostic, isRequestDiagnostic, requestError, responseDiagnostic } from '../src/dev/http.ts';
import { HostSessionRoutes } from '../src/dev/sessions/host-session-routes.ts';
import { HostSessionService } from '../src/dev/sessions/host-session-service.ts';
import type { PtyAdapter, PtyProcess, PtySpawnOptions } from '../src/dev/sessions/pty.ts';

class FakePty implements PtyProcess {
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>();
  constructor(readonly pid: number) {}
  emitData(data: string): void { for (const listener of this.#data) listener(data); }
  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.#exit) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
  kill(): void {}
  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): void {
    this.#exit.add(listener);
  }
  resize(): void {}
  write(): void {}
}

class FakeAdapter implements PtyAdapter {
  readonly processes: FakePty[] = [];
  spawn(_file: string, _args: readonly string[], _options: PtySpawnOptions): PtyProcess {
    const process = new FakePty(5_000 + this.processes.length);
    this.processes.push(process);
    return process;
  }
}

const startRoutes = async (authorized = true, withService = true) => {
  const adapter = new FakeAdapter();
  const service = new HostSessionService({
    attached: () => ({ destination: '/host/install', epochId: 'epoch-a' }),
    currentEpochId: () => 'epoch-a',
    loadPty: () => adapter,
    projectRoot: '/work/project',
    resolveExecutable: async (host) => `/usr/bin/${host}`,
  });
  const routes = new HostSessionRoutes({
    authorize: () => {
      if (!authorized) throw requestError(diagnostic('AB8004', 'refused', 403));
    },
    ...(withService ? { service } : {}),
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => responseDiagnostic(
      response,
      isRequestDiagnostic(error) ? error : diagnostic('TEST', String(error), 500),
    ));
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    adapter,
    close: async () => {
      const closing = routes.close();
      for (const process of adapter.processes) process.emitExit(0, 15);
      await closing;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
    service,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const json = { 'content-type': 'application/json' };

it('serves the frozen collection, item, control, restart, and delete contract', async () => {
  const started = await startRoutes();
  try {
    const created = await fetch(`${started.url}/api/sessions`, {
      body: JSON.stringify({ cols: 80, host: 'claude', prompt: 'hello', rows: 24 }),
      headers: json,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { readonly session: { readonly id: string } };

    await expect(fetch(`${started.url}/api/sessions`).then((response) => response.json())).resolves.toMatchObject({
      hosts: [{ host: 'claude', launchable: true }, { host: 'codex', launchable: true }],
      sessions: [{ id: body.session.id }],
    });
    await expect(fetch(`${started.url}/api/sessions/${body.session.id}`).then((response) => response.json()))
      .resolves.toMatchObject({ session: { id: body.session.id } });
    expect((await fetch(`${started.url}/api/sessions/${body.session.id}/input`, {
      body: JSON.stringify({ data: 'typed' }), headers: json, method: 'POST',
    })).status).toBe(204);
    expect((await fetch(`${started.url}/api/sessions/${body.session.id}/resize`, {
      body: JSON.stringify({ cols: 100, rows: 40 }), headers: json, method: 'POST',
    })).status).toBe(204);
    expect((await fetch(`${started.url}/api/sessions/${body.session.id}`, { method: 'DELETE' })).status).toBe(409);

    const terminating = fetch(`${started.url}/api/sessions/${body.session.id}/terminate`, {
      body: '{}', headers: json, method: 'POST',
    });
    started.adapter.processes[0]!.emitExit(0, 15);
    expect((await terminating).status).toBe(200);
    const restarted = await fetch(`${started.url}/api/sessions/${body.session.id}/restart`, {
      body: JSON.stringify({ cols: 120, rows: 50 }), headers: json, method: 'POST',
    });
    expect(restarted.status).toBe(201);
    await expect(restarted.json()).resolves.toMatchObject({
      session: { prompt: 'hello', restartOf: body.session.id },
    });
  } finally {
    await started.close();
  }
});

it('refuses unauthorized, malformed, unknown, and unavailable requests', async () => {
  const unauthorized = await startRoutes(false);
  const started = await startRoutes();
  const unavailable = await startRoutes(true, false);
  try {
    expect((await fetch(`${unauthorized.url}/api/sessions`)).status).toBe(403);
    for (const request of [
      fetch(`${started.url}/api/sessions`, {
        body: JSON.stringify({ cols: 80, host: 'claude', rows: 24, surprise: true }),
        headers: json,
        method: 'POST',
      }),
      fetch(`${started.url}/api/sessions/bad%2Fid`),
      fetch(`${started.url}/api/sessions?extra=true`),
    ]) {
      const response = await request;
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8261' } });
    }
    const unknown = await fetch(`${started.url}/api/sessions/hs_0000000000000000`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8262' } });
    const closed = await fetch(`${unavailable.url}/api/sessions`);
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8265' } });
  } finally {
    await Promise.all([unauthorized.close(), started.close(), unavailable.close()]);
  }
});

it('replays scrollback before live SSE output and closes after end', async () => {
  const started = await startRoutes();
  try {
    const session = await started.service.create({ cols: 80, host: 'codex', rows: 24 });
    started.adapter.processes[0]!.emitData('old');
    const response = await fetch(`${started.url}/api/sessions/${session.id}/stream`);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    started.adapter.processes[0]!.emitData('live');
    started.adapter.processes[0]!.emitExit(0);
    let text = '';
    while (!text.includes('event: end')) text += (await reader.read()).value ?? '';
    expect(text.indexOf(Buffer.from('old').toString('base64')))
      .toBeLessThan(text.indexOf(Buffer.from('live').toString('base64')));
    expect(text).toContain('event: state');
    expect(text).toContain('event: end');
  } finally {
    await started.close();
  }
});
