import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { sleep as delay } from '../core/async.ts';
import { CodedError } from '../core/errors.ts';
import { taskkill, terminateProcessTree } from '../services/process-tree.ts';

const inspectorPackage = '@modelcontextprotocol/inspector';
const startupBudgetMs = 30_000;
const terminateGraceMs = 2_000;
const startupTimeoutKey = Symbol.for('agent-bundle.inspector-launcher.startup-timeout-ms');
const terminateGraceKey = Symbol.for('agent-bundle.inspector-launcher.terminate-grace-ms');
const httpUrl = /https?:\/\/[^\s"'<>\\]+/gi;
const trailingPunctuation = /[),.;:\]}>]+$/u;
const urlDelimiter = /[\s"'<>\\]/u;

export type InspectorLauncherErrorCode =
  | 'INSPECTOR_EXITED'
  | 'INSPECTOR_LAUNCH_FAILED'
  | 'INSPECTOR_STARTUP_TIMEOUT';

export type InspectorLauncherState = 'exited' | 'idle' | 'running' | 'starting';

export interface InspectorLauncherStatus {
  readonly state: InspectorLauncherState;
  readonly url?: string;
}

export interface InspectorSpawnOptions {
  readonly cwd: string;
  readonly detached?: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly windowsHide?: boolean;
}

export type InspectorSpawn = (
  command: string,
  args: readonly string[],
  options: InspectorSpawnOptions,
) => ChildProcess;

export interface InspectorLauncherOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly projectRoot: string;
  readonly spawn?: InspectorSpawn;
}

export interface InspectorLauncher {
  close(): Promise<void>;
  launch(): Promise<{ readonly url: string }>;
  status(): InspectorLauncherStatus;
}

/** Coded refusals a caller can act on without reading inspector internals. */
export class InspectorLauncherError extends CodedError<InspectorLauncherErrorCode> {
  constructor(code: InspectorLauncherErrorCode, message: string) {
    super('InspectorLauncherError', code, message);
  }
}

const inspectorLauncherError = (code: InspectorLauncherErrorCode, message: string): InspectorLauncherError =>
  new InspectorLauncherError(code, message);

const positiveMs = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const startupTimeout = (options: InspectorLauncherOptions): number =>
  positiveMs(
    (options as InspectorLauncherOptions & Record<symbol, unknown>)[startupTimeoutKey],
    startupBudgetMs * (process.env.CI ? 4 : 1),
  );

const terminateGrace = (options: InspectorLauncherOptions): number =>
  positiveMs(
    (options as InspectorLauncherOptions & Record<symbol, unknown>)[terminateGraceKey],
    terminateGraceMs,
  );

const defaultSpawn: InspectorSpawn = (command, args, options) => spawn(command, [...args], {
  cwd: options.cwd,
  ...(options.detached === undefined ? {} : { detached: options.detached }),
  env: options.env,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
  ...(options.windowsHide === undefined ? {} : { windowsHide: options.windowsHide }),
});

const stripAnsi = (value: string): string => {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== '[') {
      result += value[index];
      continue;
    }
    index += 2;
    while (index < value.length && !/[A-Za-z]/u.test(value[index]!)) index += 1;
  }
  return result;
};

const inspectableUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw.replace(trailingPunctuation, ''));
  } catch {
    return undefined;
  }
};

const hasTokenQuery = (url: URL): boolean =>
  [...url.searchParams.keys()].some((key) => key.toLowerCase().includes('token'));

const isLocalhost = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

/**
 * First delimited stdout http(s) URL with a token query param, else the first delimited
 * localhost URL. A URL that ends the buffer is never chosen: stdout arrives in chunks, and a
 * boundary inside the token value would otherwise publish a truncated token.
 *
 * Inspector 2.x prints `http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=…` (no slash before
 * `?`; `new URL()` adds it) followed by a token-less
 * `Sandbox (MCP Apps): http://127.0.0.1:6275/sandbox` line, which must not be selected.
 */
export const parseInspectorStdoutUrl = (stdout: string): string | undefined => {
  const text = stripAnsi(stdout);
  const found: URL[] = [];
  for (const match of text.matchAll(httpUrl)) {
    const url = inspectableUrl(match[0]!);
    if (url === undefined || match.index === undefined) continue;
    const next = text[match.index + match[0].length];
    if (next !== undefined && urlDelimiter.test(next)) found.push(url);
  }
  return (found.find(hasTokenQuery) ?? found.find(isLocalhost))?.href;
};

const alreadyClosed = (child: ChildProcess): boolean =>
  typeof child.exitCode === 'number' || typeof child.signalCode === 'string';

const waitForClose = (child: ChildProcess): Promise<void> => new Promise((resolvePromise) => {
  if (alreadyClosed(child)) {
    resolvePromise();
    return;
  }
  child.once('close', () => resolvePromise());
});

const terminateTree = (child: ChildProcess, signal: NodeJS.Signals): Promise<boolean> =>
  terminateProcessTree(child, signal, {
    onTreeTerminationFailure: () => undefined,
    platform: process.platform,
    taskkill,
  });

const terminateChild = async (child: ChildProcess, graceMs: number): Promise<void> => {
  await terminateTree(child, 'SIGTERM');
  const terminated = await Promise.race([
    waitForClose(child).then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (terminated) return;
  await terminateTree(child, 'SIGKILL');
  await Promise.race([waitForClose(child), delay(graceMs)]);
};

const statusSnapshot = (state: InspectorLauncherState, url: string | undefined): InspectorLauncherStatus => {
  switch (state) {
    case 'idle':
    case 'starting':
    case 'exited':
      return Object.freeze({ state });
    case 'running':
      return Object.freeze({ state, ...(url === undefined ? {} : { url }) });
    default: {
      const exhaustive: never = state;
      throw new Error(`Unexpected inspector state: ${String(exhaustive)}`);
    }
  }
};

/** Opt-in launcher for the standalone MCP Inspector app. Starts only on launch(). */
export const createInspectorLauncher = (options: InspectorLauncherOptions): InspectorLauncher => {
  const projectRoot = resolve(options.projectRoot);
  const spawnChild = options.spawn ?? defaultSpawn;
  const inheritedEnv = options.env ?? process.env;
  const graceMs = terminateGrace(options);
  const timeoutMs = startupTimeout(options);
  let child: ChildProcess | undefined;
  let closePromise: Promise<void> | undefined;
  let launchPromise: Promise<{ readonly url: string }> | undefined;
  let state: InspectorLauncherState = 'idle';
  let url: string | undefined;

  const clearChild = (): void => {
    child?.stdout?.removeAllListeners('data');
    child?.stderr?.removeAllListeners('data');
    child = undefined;
  };

  const launch = async (): Promise<{ readonly url: string }> => {
    if (closePromise !== undefined) await closePromise;
    if (launchPromise !== undefined && (state === 'starting' || state === 'running')) return launchPromise;
    if (state === 'running' && url !== undefined) return Object.freeze({ url });

    launchPromise = new Promise<{ readonly url: string }>((resolvePromise, rejectPromise) => {
      let settled = false;
      let stdout = '';
      const timer: { id?: NodeJS.Timeout } = {};
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer.id !== undefined) clearTimeout(timer.id);
        action();
      };
      const succeed = (resolved: string): void => {
        settle(() => {
          state = 'running';
          url = resolved;
          resolvePromise(Object.freeze({ url: resolved }));
        });
      };
      const fail = (error: InspectorLauncherError): void => {
        settle(() => {
          if (state === 'starting') state = child === undefined ? 'idle' : 'exited';
          url = undefined;
          launchPromise = undefined;
          rejectPromise(error);
        });
      };
      const consume = (chunk: Buffer | string): void => {
        if (state !== 'starting') return;
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
        const parsed = parseInspectorStdoutUrl(stdout);
        if (parsed !== undefined) succeed(parsed);
      };

      state = 'starting';
      url = undefined;
      let spawned: ChildProcess;
      try {
        spawned = spawnChild(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', inspectorPackage], {
          cwd: projectRoot,
          detached: process.platform !== 'win32',
          env: { ...inheritedEnv, MCP_AUTO_OPEN_ENABLED: 'false' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        });
      } catch (error) {
        fail(inspectorLauncherError(
          'INSPECTOR_LAUNCH_FAILED',
          error instanceof Error ? error.message : 'MCP Inspector could not be spawned.',
        ));
        return;
      }
      child = spawned;
      timer.id = setTimeout(() => {
        const running = child;
        if (running !== undefined) void terminateChild(running, graceMs).catch(() => undefined);
        fail(inspectorLauncherError('INSPECTOR_STARTUP_TIMEOUT', 'MCP Inspector did not publish a URL before the startup budget elapsed.'));
      }, timeoutMs);
      spawned.stdout?.on('data', (chunk: Buffer | string) => consume(chunk));
      spawned.stderr?.on('data', () => undefined);
      spawned.once('error', (error) => {
        fail(inspectorLauncherError('INSPECTOR_LAUNCH_FAILED', error.message));
      });
      spawned.once('close', () => {
        // A timed-out launch rejects before its child finishes closing, so a
        // retry may have replaced `child` by the time this exit arrives; the
        // stale cleanup must not touch the replacement process.
        if (child !== spawned) return;
        if (state === 'running' && closePromise === undefined) {
          state = 'exited';
          url = undefined;
          launchPromise = undefined;
          clearChild();
          return;
        }
        fail(inspectorLauncherError('INSPECTOR_EXITED', 'MCP Inspector exited before publishing a URL.'));
        if (closePromise === undefined) clearChild();
      });
    });
    return launchPromise;
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      const running = child;
      if (running !== undefined) await terminateChild(running, graceMs);
      clearChild();
      launchPromise = undefined;
      url = undefined;
      state = 'idle';
    })().finally(() => {
      closePromise = undefined;
    });
    return closePromise;
  };

  return Object.freeze({
    close,
    launch,
    status: () => statusSnapshot(state, url),
  });
};
