import { type ChildProcess, spawn } from 'node:child_process';

export type ProcessTreeTaskkill = (arguments_: readonly string[]) => ChildProcess;
export type ProcessGroupProbe = (processGroupId: number) => boolean;

const taskkillTimeoutMs = 250;

export const taskkill: ProcessTreeTaskkill = (arguments_) => spawn('taskkill', [...arguments_], {
  stdio: 'ignore',
  windowsHide: true,
});

/** Terminates the child and its directly inherited process tree; this is cleanup, not containment. */
export const terminateProcessTree = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: {
    readonly onTreeTerminationFailure: () => void;
    readonly platform: NodeJS.Platform;
    readonly taskkill: ProcessTreeTaskkill;
  },
): Promise<boolean> => {
  if (child.pid === undefined) {
    try { return Promise.resolve(child.kill(signal)); }
    catch { return Promise.resolve(false); } // kill() throws when the process is already gone.
  }
  if (options.platform === 'win32') {
    return new Promise((resolvePromise) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const settle = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        resolvePromise(completed);
      };
      const fallback = (): void => {
        if (settled) return;
        options.onTreeTerminationFailure();
        try { child.kill(signal); }
        catch { /* The taskkill result is already the observable cleanup failure. */ }
        settle(false);
      };
      try {
        const taskkillProcess = options.taskkill([
          '/pid',
          String(child.pid),
          '/t',
          ...(signal === 'SIGKILL' ? ['/f'] : []),
        ]);
        taskkillProcess.once('error', fallback);
        taskkillProcess.once('close', (code) => {
          if (code === 0) settle(true);
          else fallback();
        });
        timeout = setTimeout(() => {
          try { taskkillProcess.kill('SIGKILL'); }
          catch { /* A stalled taskkill command is a failed cleanup attempt. */ }
          fallback();
        }, taskkillTimeoutMs);
      } catch {
        fallback(); // taskkill could not be spawned; try a direct kill.
      }
    });
  }
  try {
    process.kill(-child.pid, signal);
    return Promise.resolve(true);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return Promise.resolve(true);
    options.onTreeTerminationFailure();
    try { return Promise.resolve(child.kill(signal)); }
    catch { return Promise.resolve(false); } // kill() throws when the process is already gone.
  }
};

const processGroupExists: ProcessGroupProbe = (processGroupId) => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false;
    return true;
  }
};

/** Waits for the POSIX process group to disappear after a final cleanup signal. */
export const waitForProcessTreeExit = async (
  child: ChildProcess,
  options: {
    readonly platform: NodeJS.Platform;
    readonly pollMilliseconds: number;
    readonly probe?: ProcessGroupProbe;
    readonly timeoutMilliseconds: number;
  },
): Promise<boolean> => {
  if (child.pid === undefined || options.platform === 'win32') return true;
  const probe = options.probe ?? processGroupExists;
  const deadline = Date.now() + options.timeoutMilliseconds;
  while (probe(child.pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, options.pollMilliseconds); });
  }
  return true;
};
