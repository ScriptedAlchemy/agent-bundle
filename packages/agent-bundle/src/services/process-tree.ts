import { type ChildProcess, spawn } from 'node:child_process';

export type ProcessTreeTaskkill = (arguments_: readonly string[]) => ChildProcess;

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
): void => {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (options.platform === 'win32') {
    let fallbackUsed = false;
    const fallback = () => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      options.onTreeTerminationFailure();
      child.kill(signal);
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
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return;
    child.kill(signal);
  }
};
