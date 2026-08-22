import { spawn } from 'node:child_process';

export interface BoundedChildProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable: string;
}

export interface BoundedChildProcessLabels<TTermination extends string> {
  readonly aborted?: TTermination;
  readonly outputLimit: TTermination;
  readonly timedOut: TTermination;
}

export interface BoundedChildProcessOptions<TTermination extends string> {
  /** Honour an already-aborted signal immediately. Codex eval leaves this false. */
  readonly abortAlreadyAborted?: boolean;
  /** Stop retaining output once a termination reason is set. Native Codex smoke uses this. */
  readonly discardAfterTermination?: boolean;
  /** When set, resolve with exitCode 1 if the child has not closed after termination. */
  readonly forceFinishMs?: number;
  readonly gracePeriodMs?: number;
  readonly labels: BoundedChildProcessLabels<TTermination>;
  readonly maxOutputBytes: number;
  readonly overflow?: 'drop' | 'truncate';
  readonly outputBudget?: 'combined' | 'separate';
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly windowsHide?: boolean;
}

export interface BoundedChildProcessResult<TTermination extends string> {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination?: TTermination;
}

/**
 * Shared bounded child-process runner: buffered stdout/stderr, byte cap,
 * SIGTERM→SIGKILL escalation, and optional abort / forced-finish timers.
 */
export const runBoundedChildProcess = <TTermination extends string>(
  request: BoundedChildProcessRequest,
  options: BoundedChildProcessOptions<TTermination>,
): Promise<BoundedChildProcessResult<TTermination>> => new Promise((resolvePromise, reject) => {
  const overflow = options.overflow ?? 'truncate';
  const outputBudget = options.outputBudget ?? 'separate';
  const gracePeriodMs = options.gracePeriodMs ?? 1_000;
  const abortAlreadyAborted = options.abortAlreadyAborted ?? true;
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.windowsHide === true ? { windowsHide: true } : {}),
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutBytes = { value: 0 };
  const stderrBytes = { value: 0 };
  let combinedBytes = 0;
  let settled = false;
  let termination: TTermination | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let forcedFinish: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    clearTimeout(timeout);
    if (escalation !== undefined) clearTimeout(escalation);
    if (forcedFinish !== undefined) clearTimeout(forcedFinish);
    options.signal?.removeEventListener('abort', abort);
  };
  const settle = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const complete = (exitCode: number | null, closeSignal: NodeJS.Signals | null): void => {
    settle(() => {
      resolvePromise(Object.freeze({
        exitCode,
        signal: closeSignal,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        ...(termination === undefined ? {} : { termination }),
      }));
    });
  };
  const terminate = (reason: TTermination): void => {
    if (termination !== undefined || settled) return;
    termination = reason;
    child.kill('SIGTERM');
    escalation = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, gracePeriodMs);
    if (options.forceFinishMs !== undefined) {
      forcedFinish = setTimeout(() => complete(1, null), options.forceFinishMs);
    }
  };
  const abort = (): void => {
    if (options.labels.aborted !== undefined) terminate(options.labels.aborted);
  };
  const usedBytes = (streamBytes: number): number => (outputBudget === 'combined' ? combinedBytes : streamBytes);
  const retain = (chunks: Buffer[], streamBytes: { value: number }, chunk: Buffer): void => {
    chunks.push(chunk);
    streamBytes.value += chunk.byteLength;
    if (outputBudget === 'combined') combinedBytes += chunk.byteLength;
  };
  const append = (chunks: Buffer[], streamBytes: { value: number }, chunk: Buffer): void => {
    switch (overflow) {
      case 'drop': {
        if (termination !== undefined) return;
        if (usedBytes(streamBytes.value) + chunk.byteLength > options.maxOutputBytes) {
          terminate(options.labels.outputLimit);
          return;
        }
        retain(chunks, streamBytes, chunk);
        return;
      }
      case 'truncate': {
        if (options.discardAfterTermination === true && termination !== undefined) return;
        const remaining = options.maxOutputBytes - usedBytes(streamBytes.value);
        if (remaining <= 0) {
          if (chunk.byteLength > 0) terminate(options.labels.outputLimit);
          return;
        }
        const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        retain(chunks, streamBytes, retained);
        if (retained.byteLength < chunk.byteLength || usedBytes(streamBytes.value) >= options.maxOutputBytes) {
          terminate(options.labels.outputLimit);
        }
        return;
      }
      default: {
        const exhaustive: never = overflow;
        throw new Error(`Unexpected overflow mode: ${String(exhaustive)}`);
      }
    }
  };
  const timeout = setTimeout(() => { terminate(options.labels.timedOut); }, options.timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => { append(stdoutChunks, stdoutBytes, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { append(stderrChunks, stderrBytes, chunk); });
  child.once('error', (error) => {
    settle(() => { reject(error); });
  });
  child.once('close', (exitCode, closeSignal) => {
    complete(exitCode, closeSignal);
  });
  if (options.labels.aborted === undefined || options.signal === undefined) return;
  if (abortAlreadyAborted && options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
});
