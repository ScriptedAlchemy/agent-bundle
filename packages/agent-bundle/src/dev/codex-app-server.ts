import { createConnection } from 'node:net';
import { join } from 'node:path';

import WebSocket from 'ws';

import { isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';

const requestTimeoutMs = 30_000;

type CodexAppServerRequest = <Result>(
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<Result>;

/** Runs one initialized client exchange over Codex's documented local control socket, when present. */
export const withCodexAppServer = async <Result>(
  codexRoot: string,
  action: (request: CodexAppServerRequest) => Promise<Result>,
): Promise<Result | undefined> => {
  const socketPath = join(codexRoot, 'app-server-control', 'app-server-control.sock');
  if (!await exists(socketPath)) return undefined;

  const socket = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection(socketPath),
    handshakeTimeout: 5_000,
    perMessageDeflate: false,
  });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => rejectPromise(error);
      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        resolvePromise();
      });
    });
  } catch (error) {
    socket.terminate();
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ECONNREFUSED')) return undefined;
    throw error;
  }

  let nextId = 0;
  const pending = new Map<number, {
    readonly reject: (error: Error) => void;
    readonly resolve: (result: unknown) => void;
  }>();
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('Codex app-server connection closed before responding.')));
  socket.on('message', (data) => {
    let message: Readonly<Record<string, unknown>> | undefined;
    try {
      const parsed = JSON.parse(data.toString()) as unknown;
      message = isRecord(parsed) ? parsed : undefined;
    } catch {
      return;
    }
    if (message === undefined) return;
    if (typeof message.method === 'string') return;
    const id = message.id;
    if (typeof id !== 'number') return;
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    if (message.error !== undefined) {
      request.reject(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)}`));
    } else {
      request.resolve(message.result);
    }
  });
  const request: CodexAppServerRequest = <Response>(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Response> => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Codex app-server ${method} timed out.`));
    }, requestTimeoutMs);
    pending.set(id, {
      reject: (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
      resolve: (result) => {
        clearTimeout(timeout);
        resolvePromise(result as Response);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  try {
    await request('initialize', {
      capabilities: {},
      clientInfo: {
        name: 'agent_bundle',
        title: 'Agent Bundle',
        version: '0.1.0',
      },
    });
    socket.send('{"method":"initialized"}');
    return await action(request);
  } finally {
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolvePromise();
      }, 1_000);
      socket.once('close', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      socket.close();
    });
  }
};
