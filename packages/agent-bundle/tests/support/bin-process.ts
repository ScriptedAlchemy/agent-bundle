import { spawn, type ChildProcess } from 'node:child_process';

import { within } from './eventually.ts';

/**
 * Spawning a generated `bin/<plugin>.mjs` as a real operating-system process
 * and reading what it prints: the process half of the `<plugin> web`
 * acceptance proofs (packed-web-command.test.ts, web-command.e2e.test.ts).
 * Both output streams are piped — neither is a terminal — so the routed CLI
 * shell emits machine output, and every byte is retained for diagnostics.
 */

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BinRun {
  readonly child: ChildProcess;
  /** Settles with the exit once the process closed; rejects on a spawn failure. */
  readonly exit: Promise<ProcessExit>;
  stderr(): string;
  stdout(): string;
}

export interface RunBinOptions {
  readonly cwd: string;
  /** Defaults to the current environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Every spawned child is added here so a failing test can still kill it on teardown. */
  readonly track?: Set<ChildProcess>;
}

/** Runs `node <bin> <args>` with stdin closed and stdout/stderr collected as UTF-8. */
export const runBin = (bin: string, args: readonly string[], options: RunBinOptions): BinRun => {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.track?.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const exit = new Promise<ProcessExit>((settle, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      options.track?.delete(child);
      settle({ code, signal });
    });
  });
  return { child, exit, stderr: () => stderr, stdout: () => stdout };
};

/** The complete (newline-terminated) lines of `text`, in order. */
const completeLines = (text: string): readonly string[] => text.split('\n').slice(0, -1);

/**
 * Resolves with the first complete stdout line `accept` admits; rejects with
 * both streams' contents if the process exits first or `timeoutMs` elapses.
 */
export const awaitStdoutLine = (run: BinRun, accept: (line: string) => boolean, timeoutMs: number): Promise<string> =>
  within(new Promise<string>((settle, reject) => {
    const check = (): void => {
      const line = completeLines(run.stdout()).find(accept);
      if (line !== undefined) settle(line);
    };
    run.child.stdout?.on('data', check);
    void run.exit.then(
      (exit) => reject(new Error(
        `The bin exited (${JSON.stringify(exit)}) before printing the awaited line.\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
      )),
      reject,
    );
    check();
  }), timeoutMs);

/** Signal 0 probes for existence: `ESRCH` is the one outcome that means the process is gone. */
export const isProcessGone = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

/** `true` once nothing accepts connections at `url` any more. */
export const connectionRefused = async (url: string): Promise<boolean> => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

/** Best-effort SIGKILL of every process id, ignoring the ones already gone. */
export const killAll = (processIds: Iterable<number>): void => {
  for (const processId of processIds) {
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // Already gone, which is what the tests asserted.
    }
  }
};
