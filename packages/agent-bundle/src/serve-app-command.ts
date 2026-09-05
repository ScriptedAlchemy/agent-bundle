/**
 * `agent-bundle/serve-app-command` (#558): serve a built MCP App from a routed
 * CLI command — or any other generated executable — without importing the
 * compiler.
 *
 * A plugin's generated executables are self-contained ESM (#387): the bundler
 * inlines everything a route imports, so `import('agent-bundle/api')` for
 * `serveApp` would inline the whole framework and fail on its runtime-relative
 * module references (the route graph reports that as `AB4837` before the
 * bundler does). The sanctioned shape keeps the framework in its own process:
 * this module lowers the `serveApp` options to `agent-bundle serve-app` argv,
 * resolves the framework CLI the project installed, spawns it, relays its
 * stdout to stderr so the route keeps stdout for its own JSON result, and
 * settles once the CLI prints its ready line. Plain Node with no dependencies,
 * so it bundles into every host pack's executable exactly like
 * `agent-bundle/launch-env`.
 */
import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { dependencyManifestPath } from './core/dependency-manifest.ts';
import { CodedError } from './core/errors.ts';
import { exists } from './core/paths.ts';
import { isRecord } from './core/strict-json.ts';
import type { McpAppProfileId } from './dev/mcp-app-profile-descriptors.ts';
import {
  parseServeAppReadyLine,
  serveAppAllowCapabilities,
  type ServeAppAllowCapability,
  type ServeAppReadyLine,
} from './serve-app/command-contract.ts';

export type { McpAppProfileId, ServeAppAllowCapability, ServeAppReadyLine };
export { parseServeAppReadyLine, serveAppAllowCapabilities };

/**
 * The `serveApp` options with an `agent-bundle serve-app` argv form: every
 * key of `ServeAppOptions` (`agent-bundle/api`) except the in-process
 * injections — `logger`, `registry`, `openBrowser` — and the two keys the
 * CLI does not expose, `targets` and `timeoutMs`, which stay with host
 * processes that call `serveApp` directly. Unset keys take the CLI's
 * defaults (`--target portable`, `--profile portable`, `--mode production`,
 * no browser). Relative paths resolve exactly as they would in-process:
 * `configPath` against `root`, `artifact` and `envFiles` against the
 * working directory.
 */
export interface ServeAppArgvOptions {
  /** The MCP App to serve: `<server>/<app>` (for example `status/status`), or `<server>/ui://...` for an exact resource URI. */
  readonly app: string;
  /** Use exactly this built artifact instead of building a throwaway one (`--artifact`). */
  readonly artifact?: string;
  /**
   * Consent capabilities approved on the operator's behalf as the App requests
   * them (`--allow`, repeatable): the App-initiated actions the CLI lets a
   * flag approve. Browser hardware and clipboard permissions always wait for
   * a decision in the host page.
   */
  readonly autoApprove?: readonly ServeAppAllowCapability[];
  /** Configuration file relative to `root` (`--config`). */
  readonly configPath?: string;
  /** Explicit `.env` files replacing the conventional project-root set (`--env-file`, repeatable). */
  readonly envFiles?: readonly string[];
  /** Arguments for the opening tool call, serialized as JSON (`--input`). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Set false to launch the server without any `.env` layer (`--no-env`). */
  readonly loadEnvFiles?: boolean;
  /** Configuration mode (`--mode`). */
  readonly mode?: string;
  /** Open the default browser on the served URL once the host is listening (`--open` / `--no-open`). */
  readonly open?: boolean;
  /** Root the env-declared plugin-root anchors expand to (`--plugin-root`). */
  readonly pluginRoot?: string;
  /** Loopback TCP port for the host document; `0` picks an ephemeral one (`--port`). */
  readonly port?: number;
  /** The simulated MCP Apps host profile (`--profile`). */
  readonly profile?: McpAppProfileId;
  /** The plugin project root: where `agent-bundle` is installed and the configuration lives (`--root`). */
  readonly root: string;
  /** The artifact target whose generated server to bind (`--target`). */
  readonly target?: string;
  /** The tool whose result the App opens with (`--tool`). */
  readonly tool?: string;
}

/**
 * The `agent-bundle` argv equivalent to `serveApp(options)`: `serve-app
 * <app>` followed by one flag per set option, in the order the CLI documents
 * them. The record is keyed by every option, so a new `ServeAppArgvOptions`
 * key fails to compile until it is lowered.
 */
export const serveAppArgv = (options: ServeAppArgvOptions): readonly string[] => {
  const lowered: { readonly [K in keyof ServeAppArgvOptions]-?: readonly string[] } = {
    app: [options.app],
    root: ['--root', options.root],
    configPath: options.configPath === undefined ? [] : ['--config', options.configPath],
    mode: options.mode === undefined ? [] : ['--mode', options.mode],
    artifact: options.artifact === undefined ? [] : ['--artifact', options.artifact],
    target: options.target === undefined ? [] : ['--target', options.target],
    tool: options.tool === undefined ? [] : ['--tool', options.tool],
    input: options.input === undefined ? [] : ['--input', JSON.stringify(options.input)],
    port: options.port === undefined ? [] : ['--port', String(options.port)],
    profile: options.profile === undefined ? [] : ['--profile', options.profile],
    autoApprove: (options.autoApprove ?? []).flatMap((capability) => ['--allow', capability]),
    open: options.open === undefined ? [] : [options.open ? '--open' : '--no-open'],
    envFiles: (options.envFiles ?? []).flatMap((file) => ['--env-file', file]),
    loadEnvFiles: options.loadEnvFiles === false ? ['--no-env'] : [],
    pluginRoot: options.pluginRoot === undefined ? [] : ['--plugin-root', options.pluginRoot],
  };
  return ['serve-app', ...Object.values(lowered).flat()];
};

/**
 * Why `spawnServeApp` (or a served App's `close()`) failed, as the error's `code`:
 * - `framework-not-installed`: no `agent-bundle` package resolves from `root`;
 * - `artifact-missing`: the given `artifact` path does not exist;
 * - `spawn-failed`: the framework CLI process could not be started;
 * - `exited-before-ready`: `agent-bundle serve-app` exited without printing
 *   its ready line (its diagnostics went to stderr);
 * - `aborted`: the `signal` aborted before the App was served;
 * - `stop-failed`: the running `agent-bundle serve-app` process could not be
 *   signalled when the `signal` aborted or `close()` was called (Node's
 *   `kill` error is the `cause`), so it is still running.
 */
export type ServeAppCommandErrorCode =
  | 'framework-not-installed'
  | 'artifact-missing'
  | 'spawn-failed'
  | 'exited-before-ready'
  | 'aborted'
  | 'stop-failed';

/** The exit of the `agent-bundle serve-app` process, as Node reports it. */
export interface ServeAppExit {
  /** The exit code, or `null` when a signal ended the process. */
  readonly code: number | null;
  /** The terminating signal, or `null` when the process exited on its own. */
  readonly signal: NodeJS.Signals | null;
}

export class ServeAppCommandError extends CodedError<ServeAppCommandErrorCode> {
  /** Present for `exited-before-ready`: how the CLI process ended. */
  readonly exit: ServeAppExit | undefined;

  constructor(code: ServeAppCommandErrorCode, message: string, options?: ErrorOptions & { readonly exit?: ServeAppExit }) {
    super('ServeAppCommandError', code, message, options);
    this.exit = options?.exit;
  }
}

/**
 * The `agent-bundle` CLI entry (`bin/agent-bundle.js`) of the framework
 * installed for the project at `root`, resolved the way the framework itself
 * finds a dependency: through Node's resolution from the project's
 * `package.json` (which honours hoisting and pnpm's layout), then by the
 * ancestor `node_modules` walk when the package's `exports` hide its
 * manifest. `undefined` when the framework is not installed: the published
 * plugin package and an installed host pack ship no runtime dependencies, so
 * only a checkout (or a consumer that installed `agent-bundle`) can serve.
 */
export const locateFrameworkCli = async (root: string): Promise<string | undefined> => {
  const manifestPath = await dependencyManifestPath(resolve(root), 'agent-bundle');
  if (manifestPath === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // An unreadable or malformed manifest names no CLI: "not installed" is
    // the actionable reading, not a raw parse error escaping the typed errors.
    return undefined;
  }
  if (!isRecord(manifest)) return undefined;
  const bin = manifest['bin'];
  const relative = typeof bin === 'string' ? bin : isRecord(bin) ? bin['agent-bundle'] : undefined;
  return typeof relative === 'string' ? resolve(dirname(manifestPath), relative) : undefined;
};

export interface SpawnServeAppOptions extends ServeAppArgvOptions {
  /**
   * The framework CLI to run instead of the one resolved from `root`.
   * Injectable for tests and for hosts that carry their own copy.
   */
  readonly cli?: string;
  /**
   * Receives every line the CLI prints on stdout — the ready line and
   * anything after it. Defaults to writing them to this process's stderr,
   * the operator's channel, so the routed command keeps stdout for its
   * result document. The CLI's stderr (diagnostics) is inherited as is.
   */
  readonly relay?: (line: string) => void;
  /**
   * Tears the server down when aborted — the request `signal` a routed
   * command receives, so Ctrl-C reaching the command reaches the server.
   */
  readonly signal?: AbortSignal;
  /** Injectable only to make the child process deterministic in tests. */
  readonly spawn?: typeof spawnChildProcess;
}

/** A served MCP App, as `agent-bundle serve-app` reported it. */
export interface SpawnedServeApp extends ServeAppReadyLine {
  /** The generated MCP server the App is bound to: the part of `app` before the first `/`. */
  readonly server: string;
  /** The loopback port the host document listens on. */
  readonly port: number;
  /** The `agent-bundle serve-app` process id. */
  readonly pid: number;
  /** Settles once the CLI process has exited — by `close()`, the `signal`, Ctrl-C, or on its own when the bound server ended. */
  readonly closed: Promise<ServeAppExit>;
  /**
   * Stops the server (SIGTERM to the CLI, which closes the host and its MCP
   * server) and waits for the exit. Rejects with `stop-failed` when the
   * running process cannot be signalled; it is then still running.
   */
  close(): Promise<ServeAppExit>;
}

const portOf = (url: string): number => {
  const parsed = new URL(url);
  if (parsed.port.length > 0) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
};

const serverOf = (app: string): string => app.slice(0, Math.max(0, app.indexOf('/')));

const describeExit = ({ code, signal }: ServeAppExit): string =>
  signal === null ? `exit code ${String(code ?? 'unknown')}` : `signal ${signal}`;

const writeToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Serves one built MCP App by running `agent-bundle serve-app` in a child
 * process. Resolves once the CLI prints its ready line; the App then stays
 * up until `close()`, the `signal`, or the bound MCP server ending. Rejects
 * with a `ServeAppCommandError` whose `code` says what went wrong.
 */
export const spawnServeApp = async (options: SpawnServeAppOptions): Promise<SpawnedServeApp> => {
  const root = resolve(options.root);
  const relay = options.relay ?? writeToStderr;
  if (options.signal?.aborted === true) {
    throw new ServeAppCommandError('aborted', `Serving ${options.app} was aborted before agent-bundle serve-app started.`);
  }
  const cli = options.cli ?? await locateFrameworkCli(root);
  if (cli === undefined) {
    throw new ServeAppCommandError(
      'framework-not-installed',
      `agent-bundle is not installed for the project at ${root}: no node_modules/agent-bundle/package.json resolves `
        + 'from it. Serving an App needs the framework CLI, which the plugin checkout has as a dev dependency and the '
        + 'published package and installed host packs do not; run the command from the checkout after installing.',
    );
  }
  if (options.artifact !== undefined && !(await exists(resolve(options.artifact)))) {
    throw new ServeAppCommandError(
      'artifact-missing',
      `No built artifact at ${resolve(options.artifact)}. Run \`agent-bundle build\` first, or leave artifact unset so `
        + 'serve-app builds a throwaway one.',
    );
  }
  const argv = [cli, ...serveAppArgv(options)];
  return new Promise<SpawnedServeApp>((settle, reject) => {
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawnChildProcess)(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (error) {
      reject(new ServeAppCommandError('spawn-failed', `agent-bundle serve-app could not be started from ${cli}.`, { cause: error }));
      return;
    }
    let ready: ServeAppReadyLine | undefined;
    let buffered = '';
    let spawned = false;
    let lateError: Error | undefined;
    let stopping = false;
    let stopFailure: Error | undefined;
    let settledExit: ServeAppExit | undefined;
    let resolveExit: (exit: ServeAppExit) => void = () => undefined;
    const closed = new Promise<ServeAppExit>((resolveClosed) => {
      resolveExit = resolveClosed;
    });
    /**
     * Sends SIGTERM. Node reports a signal the running process refuses (EPERM)
     * as a synchronous `error` event rather than a throw; that is the returned
     * failure. A process that already exited but has not closed yet is not a
     * failure: its `close` is on the way.
     */
    const stop = (): ServeAppCommandError | undefined => {
      if (settledExit !== undefined) return undefined;
      stopFailure = undefined;
      stopping = true;
      child.kill('SIGTERM');
      stopping = false;
      if (stopFailure === undefined) return undefined;
      return new ServeAppCommandError(
        'stop-failed',
        `agent-bundle serve-app (pid ${String(child.pid ?? 'unknown')}) could not be signalled to stop and is still running.`,
        { cause: stopFailure },
      );
    };
    const served = (line: ServeAppReadyLine): SpawnedServeApp => ({
      ...line,
      close: async () => {
        const failure = stop();
        if (failure !== undefined) throw failure;
        return closed;
      },
      closed,
      pid: child.pid ?? -1,
      port: portOf(line.url),
      server: serverOf(line.app),
    });
    const onLine = (line: string): void => {
      relay(line);
      if (ready !== undefined) return;
      ready = parseServeAppReadyLine(line);
      if (ready !== undefined) settle(served(ready));
    };
    const onAbort = (): void => {
      const failure = stop();
      // Before the ready line the caller is still awaiting this promise, so
      // an abort that could not stop the child is its answer; after it, the
      // App is the caller's and `close()` reports the same failure.
      if (failure !== undefined && ready === undefined) reject(failure);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // An abort that landed while the CLI was being resolved has already
    // dispatched its event; the listener above would wait forever.
    if (options.signal?.aborted === true) onAbort();
    const finish = (exit: ServeAppExit, failure?: ServeAppCommandError): void => {
      if (settledExit !== undefined) return;
      settledExit = exit;
      options.signal?.removeEventListener('abort', onAbort);
      if (buffered.length > 0) onLine(buffered);
      buffered = '';
      resolveExit(exit);
      if (ready !== undefined) return;
      if (failure !== undefined) {
        reject(failure);
      } else if (options.signal?.aborted === true) {
        reject(new ServeAppCommandError('aborted', `Serving ${options.app} was aborted before agent-bundle serve-app was ready.`));
      } else {
        reject(new ServeAppCommandError(
          'exited-before-ready',
          `agent-bundle serve-app exited with ${describeExit(exit)} before serving ${options.app}; its diagnostics are on stderr.`,
          { exit, ...(lateError === undefined ? {} : { cause: lateError }) },
        ));
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.once('spawn', () => {
      spawned = true;
    });
    child.on('error', (error) => {
      // Before the process exists, `error` is the one notice Node gives and
      // `close` may never follow: the spawn failed. Once the process runs,
      // `error` reports a failed `kill()` and the process is still alive, so
      // only its real `close` may settle `closed`: `stop()` surfaces the
      // failure to whoever asked, and it is kept as the cause should the
      // child then exit before its ready line.
      if (spawned) {
        lateError = error;
        if (stopping) stopFailure = error;
        return;
      }
      finish(
        { code: null, signal: null },
        new ServeAppCommandError('spawn-failed', `agent-bundle serve-app could not be started from ${cli}.`, { cause: error }),
      );
    });
    child.once('close', (code, signal) => {
      finish({ code, signal });
    });
  });
};
