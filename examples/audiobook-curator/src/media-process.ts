import { spawn } from 'node:child_process';

export interface MediaProcessResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface MediaProcessOptions {
  readonly signal?: AbortSignal;
}

export type MediaProcess = (
  executable: string,
  args: readonly string[],
  options?: MediaProcessOptions,
) => Promise<MediaProcessResult>;

const maximumOutputBytes = 256 * 1024;

const processEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
};

export const runMediaProcess: MediaProcess = async (executable, args, options = {}) => {
  if (options.signal?.aborted === true) throw options.signal.reason;

  return new Promise<MediaProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      env: processEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;

    const terminate = (error: Error): void => {
      failure ??= error;
      child.kill('SIGTERM');
    };
    const collect = (chunks: Buffer[], stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      if (failure !== undefined) return;
      if (stream === 'stdout') stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (stdoutBytes > maximumOutputBytes || stderrBytes > maximumOutputBytes) {
        terminate(new Error(`Media process ${stream} exceeded 256 KiB.`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));

    const abort = (): void => terminate(
      options.signal?.reason instanceof Error ? options.signal.reason : new Error('Media process aborted.'),
    );
    options.signal?.addEventListener('abort', abort, { once: true });

    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      const decodedStderr = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        rejectPromise(new Error(
          `Media process failed (${code === null ? signal ?? 'unknown signal' : `exit ${code}`}): ${decodedStderr.trim()}`,
        ));
        return;
      }
      resolvePromise({ stderr: decodedStderr, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
};
