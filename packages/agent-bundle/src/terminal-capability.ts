import { fstatSync } from 'node:fs';

/**
 * The terminal capability generated executables report to routes and
 * scripts (#511): TTY-ness, color support, and size per output stream,
 * detected once per process by the framework shell with the same rules that
 * pick the CLI output mode. Plain Node with no dependencies — it is aliased
 * into every generated bin, rendered script, and `main`-envelope script, and
 * it must not load the Effect runtime or `@agent-bundle/runtime`. The types
 * are structural mirrors of the runtime's `AgentTerminal` family so a
 * consumer's `main(argv, { terminal })` and `(await agent()).terminal.value`
 * read one shape.
 */

/**
 * `tty` is an interactive terminal; `pipe` any other open descriptor (a pipe,
 * a file, a socket, `/dev/null`); `none` means no human-facing stream exists
 * for the route on this surface — an MCP server's stdout is the protocol wire
 * and a hook's is its host envelope.
 */
export type AgentTerminalStreamKind = 'tty' | 'pipe' | 'none';

/** `basic` is 16 colors, `256` the xterm palette, `truecolor` 24-bit. */
export type AgentTerminalColor = 'none' | 'basic' | '256' | 'truecolor';

/**
 * The projection a request runs under. `cli`, `script`, and `workbench` own
 * a probed process; `mcp` and `hook` never have a terminal and always report
 * `none`.
 */
export type AgentTerminalSurface = 'cli' | 'mcp' | 'hook' | 'script' | 'workbench';

export interface AgentTerminalStream {
  /** Present when the stream is a terminal or `COLUMNS` overrides it. */
  readonly columns?: number;
  readonly color: AgentTerminalColor;
  readonly kind: AgentTerminalStreamKind;
  /** Present when the stream is a terminal or `LINES` overrides it. */
  readonly rows?: number;
}

/**
 * What a route or script may assume about the process's output streams.
 * Information only, never a writer: under the routed CLI and rendered
 * scripts machine output owns stdout, so `stdout` describes where the
 * rendered document lands and `stderr` the channel a route may write to
 * itself; a plain `main` script owns both.
 */
export interface AgentTerminal {
  readonly hostSurface: AgentTerminalSurface;
  /** Whether stdout and stderr name the same open file (`2>&1`, one shared terminal). */
  readonly sharesTarget: boolean;
  readonly stderr: AgentTerminalStream;
  readonly stdout: AgentTerminalStream;
}

/** The surfaces whose process streams the shell probes. */
export type ProbedTerminalSurface = Extract<AgentTerminalSurface, 'cli' | 'script'>;

/** The surfaces that never have a terminal, whatever their descriptors are. */
export type TerminalFreeSurface = Exclude<AgentTerminalSurface, ProbedTerminalSurface>;

/** One output stream as the shell sees it: the descriptor plus what Node's `tty.WriteStream` reports. */
export interface TerminalStreamProbe {
  readonly columns?: number | undefined;
  readonly fd: number;
  readonly isTTY?: boolean | undefined;
  readonly rows?: number | undefined;
}

export interface DetectTerminalOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.stderr` on descriptor 2. */
  readonly stderr?: TerminalStreamProbe;
  /** Defaults to `process.stdout` on descriptor 1. */
  readonly stdout?: TerminalStreamProbe;
}

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

const isOn = (value: string): boolean => value !== '0' && value.toLowerCase() !== 'false';

/** The depth an attached terminal renders, from `COLORTERM` and `TERM`; `basic` when neither says more. */
const terminalDepth = (env: Readonly<Record<string, string | undefined>>): AgentTerminalColor => {
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (/-256(?:color)?$/u.test(env.TERM ?? '')) return '256';
  return 'basic';
};

/**
 * Color for one stream, following the informal standards in their usual
 * precedence: `FORCE_COLOR` decides outright when set (`0`/`false` off,
 * `1`/`true`/empty basic, `2` 256, `3` truecolor — Node's own reading);
 * `CLICOLOR_FORCE` forces color on even for a pipe; `NO_COLOR` (any non-empty
 * value) and `CLICOLOR=0` force it off; `TERM=dumb` cannot render it;
 * otherwise color iff the stream is a terminal, at the depth `COLORTERM` and
 * `TERM` advertise.
 */
export const terminalColor = (
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): AgentTerminalColor => {
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined) {
    switch (forceColor) {
      case '':
      case '1':
      case 'true':
        return 'basic';
      case '2':
        return '256';
      case '3':
        return 'truecolor';
      default:
        return 'none';
    }
  }
  const clicolorForce = env.CLICOLOR_FORCE;
  if (isSet(clicolorForce) && isOn(clicolorForce)) return terminalDepth(env);
  if (isSet(env.NO_COLOR)) return 'none';
  if (env.CLICOLOR === '0') return 'none';
  if (env.TERM === 'dumb') return 'none';
  return isTty ? terminalDepth(env) : 'none';
};

/** A positive integer from an environment override such as `COLUMNS`; anything else is no override. */
const dimensionOverride = (value: string | undefined): number | undefined => {
  if (!isSet(value) || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
};

const dimension = (
  override: string | undefined,
  reported: number | undefined,
  isTty: boolean,
): number | undefined => {
  const overridden = dimensionOverride(override);
  if (overridden !== undefined) return overridden;
  return isTty && typeof reported === 'number' && reported > 0 ? reported : undefined;
};

/** `tty` when Node says so, `pipe` for any other open descriptor, `none` when the descriptor is closed. */
const streamKind = (probe: TerminalStreamProbe): AgentTerminalStreamKind => {
  if (probe.isTTY === true) return 'tty';
  try {
    fstatSync(probe.fd);
    return 'pipe';
  } catch {
    return 'none';
  }
};

const probeStream = (
  probe: TerminalStreamProbe,
  env: Readonly<Record<string, string | undefined>>,
): AgentTerminalStream => {
  const kind = streamKind(probe);
  const isTty = kind === 'tty';
  const columns = dimension(env.COLUMNS, probe.columns, isTty);
  const rows = dimension(env.LINES, probe.rows, isTty);
  return Object.freeze({
    color: kind === 'none' ? 'none' : terminalColor(env, isTty),
    kind,
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
  });
};

/**
 * Whether two descriptors name the same open file (device + inode): what
 * `2>&1`, `| tee`, and one shared terminal look like from inside the process.
 * A descriptor that cannot be inspected, or a platform that reports no inode,
 * keeps the channels separate.
 */
export const sharesOutputTarget = (stdoutFd: number, stderrFd: number): boolean => {
  try {
    const out = fstatSync(stdoutFd);
    const err = fstatSync(stderrFd);
    return out.ino !== 0 && out.dev === err.dev && out.ino === err.ino;
  } catch {
    return false;
  }
};

const processProbe = (stream: NodeJS.WriteStream, fd: number): TerminalStreamProbe => ({
  columns: stream.columns,
  fd,
  isTTY: stream.isTTY,
  rows: stream.rows,
});

/**
 * Probes this process's stdout and stderr once. The routed CLI shell calls it
 * to pick its output mode and hands the same value to routes, so a route's
 * decision to color its own stderr agrees with the framework's rendering.
 */
export const detectProcessTerminal = (
  hostSurface: ProbedTerminalSurface,
  options: DetectTerminalOptions = {},
): AgentTerminal => {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? processProbe(process.stdout, 1);
  const stderr = options.stderr ?? processProbe(process.stderr, 2);
  return Object.freeze({
    hostSurface,
    sharesTarget: sharesOutputTarget(stdout.fd, stderr.fd),
    stderr: probeStream(stderr, env),
    stdout: probeStream(stdout, env),
  });
};

const closedStream: AgentTerminalStream = Object.freeze({ color: 'none', kind: 'none' });

/**
 * The honest report for a surface that has no terminal: a generated MCP
 * server's stdout is the protocol wire, a hook's is its host envelope, and a
 * Workbench replay renders into a panel. Nothing is probed, so nothing can be
 * guessed.
 */
export const noTerminal = (hostSurface: TerminalFreeSurface): AgentTerminal => Object.freeze({
  hostSurface,
  sharesTarget: false,
  stderr: closedStream,
  stdout: closedStream,
});
