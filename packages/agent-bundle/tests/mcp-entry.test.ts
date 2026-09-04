import { describe, expect, it } from '@rstest/core';

import {
  createHeartbeat,
  redirectConsoleToStderr,
  runGeneratedStdioMcpEntry,
  runStdioServer,
  type LifecycleServer,
  type LifecycleSignalSource,
  type LifecycleStdin,
  type LifecycleTransport,
} from '../src/mcp-entry.ts';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeTransport extends LifecycleTransport {
  readonly closed: () => number;
}

const fakeTransport = (close: () => Promise<void> | void = () => undefined): FakeTransport => {
  let closed = 0;
  return {
    close: () => {
      closed += 1;
      return close();
    },
    closed: () => closed,
    onclose: undefined,
    onmessage: undefined,
  };
};

interface FakeServer extends LifecycleServer {
  readonly closed: () => number;
  readonly connected: () => readonly LifecycleTransport[];
}

const fakeServer = (): FakeServer => {
  const connected: LifecycleTransport[] = [];
  let closed = 0;
  return {
    close: () => {
      closed += 1;
    },
    closed: () => closed,
    connect: async (transport) => {
      const lifecycleTransport = transport as LifecycleTransport;
      // The real SDK installs onmessage during connect; the lifecycle wraps it.
      lifecycleTransport.onmessage = () => undefined;
      connected.push(lifecycleTransport);
    },
    connected: () => connected,
  };
};

class FakeSignals implements LifecycleSignalSource {
  readonly #listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }

  listenerCount(signal: 'SIGINT' | 'SIGTERM'): number {
    return this.#listeners.get(signal)?.size ?? 0;
  }

  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }
}

interface FakeStdin extends LifecycleStdin {
  emitEnd(): void;
  listenerCount(): number;
}

const fakeStdin = (): FakeStdin => {
  const listeners = new Set<() => void>();
  return {
    emitEnd: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
    off: (_event, listener) => listeners.delete(listener),
    once: (_event, listener) => listeners.add(listener),
  };
};

interface Harness {
  readonly exitCodes: number[];
  readonly lines: string[];
  readonly server: FakeServer;
  readonly signals: FakeSignals;
  readonly stdin: FakeStdin;
  readonly transport: FakeTransport;
}

const startLifecycle = async (
  overrides: Partial<Parameters<typeof runStdioServer>[0]> = {},
): Promise<Harness & { readonly handle: Awaited<ReturnType<typeof runStdioServer>> }> => {
  const harness: Harness = {
    exitCodes: [],
    lines: [],
    server: fakeServer(),
    signals: new FakeSignals(),
    stdin: fakeStdin(),
    transport: fakeTransport(),
  };
  const handle = await runStdioServer({
    exit: (code) => harness.exitCodes.push(code),
    heartbeat: false,
    server: harness.server,
    shutdownTimeoutMs: 100,
    signals: harness.signals,
    stdin: harness.stdin,
    transport: harness.transport,
    writeLine: (line) => harness.lines.push(line),
    ...overrides,
  });
  return { ...harness, handle };
};

describe('runStdioServer lifecycle', () => {
  it('connects the server and wraps onmessage for activity tracking', async () => {
    const { handle, server, transport } = await startLifecycle();
    expect(server.connected()).toEqual([transport]);
    expect(typeof transport.onmessage).toBe('function');
    await handle.shutdown();
  });

  it('exits 130 on SIGINT and unregisters every listener', async () => {
    const { exitCodes, server, signals, stdin, transport } = await startLifecycle();
    expect(signals.listenerCount('SIGINT')).toBe(1);
    signals.emit('SIGINT');
    await wait(10);
    expect(exitCodes).toEqual([130]);
    expect(transport.closed()).toBe(1);
    expect(server.closed()).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(stdin.listenerCount()).toBe(0);
  });

  it('exits 143 on SIGTERM', async () => {
    const { exitCodes, signals } = await startLifecycle();
    signals.emit('SIGTERM');
    await wait(10);
    expect(exitCodes).toEqual([143]);
  });

  it('exits 0 on stdin EOF so the client can respawn', async () => {
    const { exitCodes, stdin } = await startLifecycle();
    stdin.emitEnd();
    await wait(10);
    expect(exitCodes).toEqual([0]);
  });

  it('exits 0 when the transport closes underneath the server', async () => {
    const { exitCodes, transport } = await startLifecycle();
    transport.onclose?.();
    await wait(10);
    expect(exitCodes).toEqual([0]);
  });

  it('races a wedged transport close against the bounded shutdown timer', async () => {
    const wedged = fakeTransport(() => new Promise<void>(() => undefined));
    const { exitCodes, handle } = await startLifecycle({ shutdownTimeoutMs: 30, transport: wedged });
    const started = Date.now();
    await handle.shutdown(9);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(exitCodes).toEqual([9]);
  });

  it('runs shutdown exactly once across concurrent triggers', async () => {
    const { exitCodes, handle, server, signals, stdin } = await startLifecycle();
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    stdin.emitEnd();
    await handle.shutdown(0);
    await wait(10);
    expect(exitCodes).toEqual([130]);
    expect(server.closed()).toBe(1);
  });
});

describe('heartbeat', () => {
  it('logs on the interval and throttles activity logging', async () => {
    const lines: string[] = [];
    const heartbeat = createHeartbeat({
      activityThrottleMs: 10_000,
      intervalMs: 20,
      name: 'curator',
      writeLine: (line) => lines.push(line),
    });
    heartbeat.noteActivity();
    heartbeat.noteActivity();
    heartbeat.noteActivity();
    await wait(70);
    heartbeat.stop();
    const activity = lines.filter((line) => line.includes('(activity)'));
    const interval = lines.filter((line) => line.includes('(interval)'));
    expect(activity).toHaveLength(1);
    expect(interval.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain('[curator] stdio heartbeat');
  });

  it('feeds request activity from the wrapped transport onmessage', async () => {
    const lines: string[] = [];
    const { handle, transport } = await startLifecycle({
      heartbeat: true,
      heartbeatIntervalMs: 60_000,
      writeLine: (line) => lines.push(line),
    });
    (transport.onmessage as (message: never) => void)(undefined as never);
    expect(lines.some((line) => line.includes('(activity)'))).toBe(true);
    await handle.shutdown();
  });
});

describe('stdout protocol guard', () => {
  it('redirects console and raw stdout to stderr, then restores stdout only', () => {
    const originalConsole = { error: console.error, log: console.log };
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const guard = redirectConsoleToStderr();
      console.log('module side effect');
      process.stdout.write('stray raw write');
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks.join('')).toContain('module side effect');
      expect(stderrChunks.join('')).toContain('stray raw write');

      guard.restoreProtocolStdout();
      process.stdout.write('{"jsonrpc":"2.0"}');
      console.log('still stderr');
      expect(stdoutChunks).toEqual(['{"jsonrpc":"2.0"}']);
      expect(stderrChunks.join('')).toContain('still stderr');
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  });

  it('adopts an installed guard instead of stacking a second one, and installs anew once restored', () => {
    // The generated stdio prelude installs the guard as the entry's first
    // import and the lifecycle calls this again: a second install would
    // capture the redirect as the original and "restore" stdout to stderr.
    const originalConsole = { error: console.error, log: console.log };
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const first = redirectConsoleToStderr();
      const second = redirectConsoleToStderr();
      expect(second).toBe(first);
      second.restoreProtocolStdout();
      process.stdout.write('{"jsonrpc":"2.0"}');
      expect(stdoutChunks).toEqual(['{"jsonrpc":"2.0"}']);
      // Restored means uninstalled: the next call installs a fresh guard
      // whose original is the real stdout again.
      const third = redirectConsoleToStderr();
      expect(third).not.toBe(first);
      process.stdout.write('swallowed');
      third.restoreProtocolStdout();
      process.stdout.write('{"id":1}');
      expect(stdoutChunks).toEqual(['{"jsonrpc":"2.0"}', '{"id":1}']);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  });

  it('keeps one guard under a consumer wrapper over stdout and restores the real stdout, discarding the wrapper', () => {
    // A consumer module that wraps `process.stdout.write` at module scope
    // wraps the redirect, not the protocol stream. Adoption must not depend
    // on the write's identity: a second guard would record the wrapper as
    // the original and "restore" it, sending every JSON-RPC frame through
    // the wrapper into stderr.
    const originalConsole = { error: console.error, log: console.log };
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const realStdout = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = realStdout;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const guard = redirectConsoleToStderr();
      const redirect = process.stdout.write;
      const wrapped: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
        wrapped.push(String(chunk));
        return (redirect as (chunk: string | Uint8Array, ...rest: never[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      process.stdout.write('module scope through the wrapper');
      expect(wrapped).toEqual(['module scope through the wrapper']);
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks).toEqual(['module scope through the wrapper']);

      expect(redirectConsoleToStderr()).toBe(guard);
      guard.restoreProtocolStdout();
      process.stdout.write('{"jsonrpc":"2.0"}');
      expect(stdoutChunks).toEqual(['{"jsonrpc":"2.0"}']);
      expect(wrapped).toEqual(['module scope through the wrapper']);
      expect(stderrChunks.join('')).toContain('process.stdout.write');
      // Restored means uninstalled: the next call installs a fresh guard.
      const next = redirectConsoleToStderr();
      expect(next).not.toBe(guard);
      process.stdout.write('swallowed');
      next.restoreProtocolStdout();
      process.stdout.write('{"id":1}');
      expect(stdoutChunks).toEqual(['{"jsonrpc":"2.0"}', '{"id":1}']);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  });

  const withCapturedStreams = (run: (captured: { readonly stdout: string[]; readonly stderr: string[] }) => void): void => {
    const originalConsole = { error: console.error, log: console.log };
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const captured = { stderr: [] as string[], stdout: [] as string[] };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      run(captured);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  };

  it('restores once: a second restoreProtocolStdout is a no-op and warns at most once', () => {
    withCapturedStreams(({ stderr, stdout }) => {
      const guard = redirectConsoleToStderr();
      const redirect = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => redirect.call(process.stdout, chunk)) as typeof process.stdout.write;
      guard.restoreProtocolStdout();
      const afterFirst = process.stdout.write;
      expect(stderr.filter((line) => line.includes('replaced process.stdout.write'))).toHaveLength(1);
      guard.restoreProtocolStdout();
      expect(process.stdout.write).toBe(afterFirst);
      expect(stderr.filter((line) => line.includes('replaced process.stdout.write'))).toHaveLength(1);
      process.stdout.write('{"jsonrpc":"2.0"}');
      expect(stdout).toEqual(['{"jsonrpc":"2.0"}']);
    });
  });

  it('ignores a stale restore after a fresh guard was installed: the fresh redirect stays, and adoption still returns the fresh guard', () => {
    withCapturedStreams(({ stderr, stdout }) => {
      const stale = redirectConsoleToStderr();
      stale.restoreProtocolStdout();
      const fresh = redirectConsoleToStderr();
      const freshRedirect = process.stdout.write;
      // A second holder of the first guard restores late: nothing changes.
      stale.restoreProtocolStdout();
      expect(process.stdout.write).toBe(freshRedirect);
      expect(redirectConsoleToStderr()).toBe(fresh);
      process.stdout.write('still guarded');
      expect(stdout).toEqual([]);
      expect(stderr).toContain('still guarded');
      fresh.restoreProtocolStdout();
      process.stdout.write('{"jsonrpc":"2.0"}');
      expect(stdout).toEqual(['{"jsonrpc":"2.0"}']);
      expect(stderr.some((line) => line.includes('replaced process.stdout.write'))).toBe(false);
    });
  });
});

describe('runGeneratedStdioMcpEntry', () => {
  const withGuardedStreams = async (run: () => Promise<void>): Promise<void> => {
    const originalConsole = {
      debug: console.debug, dir: console.dir, error: console.error, info: console.info,
      log: console.log, trace: console.trace, warn: console.warn,
    };
    const originalStdoutWrite = process.stdout.write;
    try {
      await run();
    } finally {
      // A run that threw before serving left its guard installed; release it
      // through the guard so the process-wide state is clean for the next test.
      redirectConsoleToStderr().restoreProtocolStdout();
      process.stdout.write = originalStdoutWrite;
      Object.assign(console, originalConsole);
    }
  };

  it('rejects entries whose default export is not a factory', async () => {
    await withGuardedStreams(async () => {
      await expect(runGeneratedStdioMcpEntry({
        loadEntry: async () => ({ default: 42 }),
        serverName: 'broken',
      })).rejects.toThrow('must default-export a server factory');
    });
  });

  it('builds the server from the factory and serves it under the lifecycle', async () => {
    await withGuardedStreams(async () => {
      const server = fakeServer();
      const exitCodes: number[] = [];
      const signals = new FakeSignals();
      const handle = await runGeneratedStdioMcpEntry({
        lifecycle: {
          exit: (code) => exitCodes.push(code),
          heartbeat: false,
          shutdownTimeoutMs: 50,
          signals,
          stdin: fakeStdin(),
        },
        loadEntry: async () => ({ default: () => server }),
        serverName: 'curator',
      });
      expect(server.connected()).toHaveLength(1);
      await handle.shutdown(0);
      expect(exitCodes).toEqual([0]);
    });
  });
});
