import { spawn, type ChildProcess } from 'node:child_process';

import { within } from './eventually.ts';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BinRun {
  readonly child: ChildProcess;
  readonly exit: Promise<ProcessExit>;
  stderr(): string;
  stdout(): string;
}

export interface RunBinOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** So a failing test can still kill the child on teardown. */
  readonly track?: Set<ChildProcess>;
}

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

// Incomplete trailing line is omitted: `split` always yields a final empty piece after a terminator.
const completeLines = (text: string): readonly string[] => text.split('\n').slice(0, -1);

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

// Signal 0 probes for existence; `ESRCH` is the only outcome that means gone.
export const isProcessGone = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

export const connectionRefused = async (url: string): Promise<boolean> => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

export const killAll = (processIds: Iterable<number>): void => {
  for (const processId of processIds) {
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // Already gone, which is what the tests asserted.
    }
  }
};
