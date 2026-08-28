import { spawn } from 'node:child_process';

export interface RunNodeScriptOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export interface RunNodeScriptResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export const runNodeScript = async (options: RunNodeScriptOptions): Promise<RunNodeScriptResult> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...options.args], {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stderr, stdout }));
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
