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
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyAdapter {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

interface NativeDisposable {
  dispose(): void;
}

interface NativePty {
  readonly pid: number;
  onData(listener: (data: string) => void): NativeDisposable;
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): NativeDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

interface NativePtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): NativePty;
}

const wrap = (process: NativePty): PtyProcess => ({
  pid: process.pid,
  kill: (signal) => process.kill(signal),
  onData: (listener) => {
    const subscription = process.onData(listener);
    return () => subscription.dispose();
  },
  onExit: (listener) => {
    const subscription = process.onExit(listener);
    return () => subscription.dispose();
  },
  resize: (cols, rows) => process.resize(cols, rows),
  write: (data) => process.write(data),
});

export const loadPtyAdapter = (projectRoot: string): PtyAdapter => {
  let native: NativePtyModule;
  try {
    native = createRequire(join(projectRoot, 'package.json'))('@lydell/node-pty') as NativePtyModule;
  } catch {
    native = createRequire(import.meta.url)('@lydell/node-pty') as NativePtyModule;
  }
  if (typeof native.spawn !== 'function') throw new TypeError('@lydell/node-pty does not export spawn.');
  return { spawn: (file, args, options) => wrap(native.spawn(file, [...args], options)) };
};
