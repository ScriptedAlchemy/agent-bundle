import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface PtySpawnOptions {
  readonly name: 'xterm-256color';
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyAdapter {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

interface NativePtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

export const loadPtyAdapter = (projectRoot: string): PtyAdapter => {
  let native: NativePtyModule;
  try {
    native = createRequire(join(projectRoot, 'package.json'))('@lydell/node-pty') as NativePtyModule;
  } catch {
    native = createRequire(import.meta.url)('@lydell/node-pty') as NativePtyModule;
  }
  if (typeof native.spawn !== 'function') throw new TypeError('@lydell/node-pty does not export spawn.');
  return { spawn: (file, args, options) => native.spawn(file, [...args], options) };
};
