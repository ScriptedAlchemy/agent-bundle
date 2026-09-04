/**
 * The framework-owned stdio MCP entry shell: console-to-stderr protection,
 * signal handling (SIGINT exits 130, SIGTERM exits 143), stdin-EOF detection
 * (exit 0 so the client can respawn), a bounded shutdown race against wedged
 * transports, and heartbeat/activity logging. `agent-bundle build` wraps
 * every factory-exporting MCP server entry in this lifecycle, and consumers
 * can import it directly for hand-rolled entries.
 *
 * Every value in this module is injectable through structural option types so
 * the lifecycle is testable with plain-object harnesses; the real
 * `StdioServerTransport` and MCP server instances satisfy these shapes.
 */

const defaultHeartbeatIntervalMs = 5 * 60_000;
const defaultActivityThrottleMs = 60_000;
const defaultShutdownTimeoutMs = 5_000;
const defaultHeartbeatName = 'agent-bundle';

type StdoutWrite = typeof process.stdout.write;

export interface StdoutProtocolGuard {
  /** Hands stdout back to the protocol transport; console.* keeps writing to stderr. Once only: later calls are no-ops. */
  readonly restoreProtocolStdout: () => void;
}

/**
 * The guard this process currently has installed: set by an install, cleared
 * by its `restoreProtocolStdout`. It owns the real stdout write. The
 * generated stdio prelude installs the guard as the entry's first import and
 * the lifecycle adopts that same guard instead of stacking a second one — a
 * second install would record whatever `process.stdout.write` had become as
 * the "original" and restore that, not the protocol stream.
 */
let installedGuard: { readonly guard: StdoutProtocolGuard; readonly redirectedWrite: StdoutWrite } | undefined;

/**
 * stdout carries JSON-RPC framing on a stdio server: a stray `console.log`
 * (or direct `process.stdout.write`) from any imported module would corrupt
 * the protocol stream. Install this guard before evaluating server modules,
 * then call `restoreProtocolStdout()` right before serving. Console methods
 * stay on stderr forever; only the raw `process.stdout.write` is restored
 * for protocol frames.
 *
 * While a guard is installed, calling this returns it — whatever
 * `process.stdout.write` has become since. A consumer module that wraps
 * `process.stdout.write` at module scope wraps the redirect, not the
 * protocol stream; stdout is the protocol channel, so such a wrapper is
 * unsupported, and `restoreProtocolStdout()` discards it in favour of the
 * real stdout, saying so once on stderr.
 */
export const redirectConsoleToStderr = (): StdoutProtocolGuard => {
  if (installedGuard !== undefined) return installedGuard.guard;
  const originalStdoutWrite: StdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
  const stderrConsole = new console.Console({ stderr: process.stderr, stdout: process.stderr });
  const methods = ['debug', 'dir', 'error', 'info', 'log', 'trace', 'warn'] as const;
  for (const method of methods) {
    console[method] = stderrConsole[method].bind(stderrConsole) as never;
  }
  const redirectedWrite = ((chunk: never, encoding?: never, callback?: never) =>
    process.stderr.write(chunk, encoding, callback)) as StdoutWrite;
  process.stdout.write = redirectedWrite;
  // Restoring is once-only: a second call, or a stale holder's call after a
  // fresh guard replaced this one, would otherwise overwrite that guard's
  // redirect with this original while `installedGuard` still names it.
  let restored = false;
  const guard: StdoutProtocolGuard = Object.freeze({
    restoreProtocolStdout: (): void => {
      if (restored) return;
      restored = true;
      if (process.stdout.write !== redirectedWrite) {
        process.stderr.write(
          '[agent-bundle] a module replaced process.stdout.write while console output was redirected to stderr; '
          + 'the replacement is discarded because stdout carries the MCP protocol stream.\n',
        );
      }
      process.stdout.write = originalStdoutWrite;
      if (installedGuard?.guard === guard) installedGuard = undefined;
    },
  });
  installedGuard = { guard, redirectedWrite };
  return guard;
};

export interface HeartbeatOptions {
  readonly activityThrottleMs?: number;
  readonly intervalMs?: number;
  /** Log prefix — pass the MCP server name so multi-server logs stay attributable. */
  readonly name?: string;
  readonly writeLine: (line: string) => void;
}

export interface Heartbeat {
  readonly log: (reason: string) => void;
  readonly noteActivity: () => void;
  readonly stop: () => void;
}

/**
 * Lightweight liveness logging, stderr only — stdout is the protocol channel.
 * Logs on a slow interval plus on request activity (throttled), so a silently
 * stalled server is visible in the client's logs without spamming them.
 */
export const createHeartbeat = ({
  activityThrottleMs = defaultActivityThrottleMs,
  intervalMs = defaultHeartbeatIntervalMs,
  name = defaultHeartbeatName,
  writeLine,
}: HeartbeatOptions): Heartbeat => {
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastActivityLogAt = 0;

  const log = (reason: string): void => {
    const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000);
    const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
    writeLine(`[${name}] stdio heartbeat (${reason}) pid=${process.pid} uptime=${uptimeSeconds}s idle=${idleSeconds}s`);
  };

  const timer = setInterval(() => log('interval'), intervalMs);
  timer.unref?.();

  return Object.freeze({
    log,
    noteActivity: (): void => {
      lastActivityAt = Date.now();
      if (lastActivityAt - lastActivityLogAt >= activityThrottleMs) {
        lastActivityLogAt = lastActivityAt;
        log('activity');
      }
    },
    stop: (): void => clearInterval(timer),
  });
};

export interface LifecycleTransport {
  close(): Promise<void> | void;
  onclose?: (() => void) | undefined;
  onmessage?: ((message: never, extra?: never) => void) | undefined;
}

export interface LifecycleServer {
  close(): Promise<void> | void;
  connect(transport: never): Promise<void>;
}

export interface LifecycleStdin {
  off?(event: 'end', listener: () => void): unknown;
  once?(event: 'end', listener: () => void): unknown;
}

export interface LifecycleSignalSource {
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface RunStdioServerOptions {
  readonly activityThrottleMs?: number;
  readonly exit?: (code: number) => void;
  /** Disables interval/activity heartbeat logging; shutdown behavior is unaffected. */
  readonly heartbeat?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly server: LifecycleServer;
  /** Heartbeat log prefix — pass the MCP server name. */
  readonly serverName?: string;
  readonly shutdownTimeoutMs?: number;
  readonly signals?: LifecycleSignalSource;
  readonly stdin?: LifecycleStdin;
  readonly transport: LifecycleTransport;
  readonly writeLine?: (line: string) => void;
}

export interface StdioServerHandle {
  readonly heartbeat: Heartbeat;
  readonly shutdown: (exitCode?: number) => Promise<void>;
}

/**
 * Owns the stdio server lifecycle: SIGINT exits 130, SIGTERM exits 143,
 * stdin EOF and transport close exit 0 promptly (so the client can respawn),
 * and a wedged transport/server close never hangs shutdown — the closes race
 * a bounded timer and the process exits unconditionally once it fires.
 */
export const runStdioServer = async ({
  activityThrottleMs,
  exit = (code) => process.exit(code),
  heartbeat: heartbeatEnabled = true,
  heartbeatIntervalMs,
  server,
  serverName,
  shutdownTimeoutMs = defaultShutdownTimeoutMs,
  signals = process,
  stdin = process.stdin,
  transport,
  writeLine = (line) => void process.stderr.write(`${line}\n`),
}: RunStdioServerOptions): Promise<StdioServerHandle> => {
  const heartbeat = createHeartbeat({
    ...(activityThrottleMs === undefined ? {} : { activityThrottleMs }),
    ...(heartbeatIntervalMs === undefined ? {} : { intervalMs: heartbeatIntervalMs }),
    ...(serverName === undefined ? {} : { name: serverName }),
    writeLine: heartbeatEnabled ? writeLine : () => undefined,
  });

  // Safety net to keep the event loop alive if the transport stalls without
  // closing. Unref'd so a dead pipe never keeps the process alive — once
  // stdin/transport close we exit promptly and let the client respawn.
  const keepalive = setInterval(() => undefined, 60_000);
  keepalive.unref?.();

  let shuttingDown = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    signals.off('SIGINT', handleSigint);
    signals.off('SIGTERM', handleSigterm);
    stdin.off?.('end', handleStdinEnd);
    clearInterval(keepalive);
    heartbeat.stop();
    await Promise.race([
      Promise.allSettled([
        Promise.resolve().then(() => transport.close()),
        Promise.resolve().then(() => server.close()),
      ]),
      new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
    ]);
    exit(exitCode);
  };

  const handleSigint = (): void => {
    void shutdown(130);
  };
  const handleSigterm = (): void => {
    void shutdown(143);
  };
  const handleStdinEnd = (): void => {
    void shutdown(0);
  };

  signals.on('SIGINT', handleSigint);
  signals.on('SIGTERM', handleSigterm);
  stdin.once?.('end', handleStdinEnd);

  transport.onclose = () => {
    void shutdown(0);
  };

  await server.connect(transport as never);

  // server.connect installs transport.onmessage; wrap it so request/tool-call
  // activity feeds the heartbeat.
  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    heartbeat.noteActivity();
    originalOnMessage?.(message, extra);
  };

  return Object.freeze({ heartbeat, shutdown });
};

/** The factory shape a generated stdio entry module default-exports. */
export type StdioMcpServerFactory = () => LifecycleServer | Promise<LifecycleServer>;

export interface GeneratedStdioMcpEntryModule {
  readonly default?: unknown;
}

export interface RunGeneratedStdioMcpEntryOptions {
  /**
   * Loads the consumer entry module. The generated shell imports the module
   * statically, after its stdio prelude — the console guard plus the operator
   * `.env` layer (#469) — and resolves it here: under bundling every module
   * of the single-chunk entry evaluates before the shell body whichever way
   * it is imported, so import order, not this call, is what puts the guard
   * and the layer ahead of the module's own top level.
   */
  readonly loadEntry: () => Promise<GeneratedStdioMcpEntryModule>;
  /** Test seam mirroring {@link RunStdioServerOptions}. */
  readonly lifecycle?: Omit<RunStdioServerOptions, 'server' | 'serverName' | 'transport'>;
  readonly serverName: string;
}

/**
 * The body of every generated stdio MCP entry: adopt the stdout guard the
 * shell's prelude installed as its first import (installing it here only for
 * a hand-rolled caller that has none), take the consumer module, build the
 * server from its default-exported factory, hand raw stdout back for
 * protocol frames, and serve under the managed lifecycle.
 */
export const runGeneratedStdioMcpEntry = async (
  options: RunGeneratedStdioMcpEntryOptions,
): Promise<StdioServerHandle> => {
  const guard = redirectConsoleToStderr();
  const entry = await options.loadEntry();
  const factory = entry.default;
  if (typeof factory !== 'function') {
    throw new TypeError(
      `Generated stdio entry for MCP server ${JSON.stringify(options.serverName)} must default-export a server factory.`,
    );
  }
  const server = await (factory as StdioMcpServerFactory)();
  // Deferred so the SDK evaluates under the guard, after the consumer module:
  // a static import would hoist SDK evaluation ahead of the guard install.
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  guard.restoreProtocolStdout();
  const transport = new StdioServerTransport();
  return runStdioServer({
    ...options.lifecycle,
    server,
    serverName: options.serverName,
    transport: transport as LifecycleTransport,
  });
};
