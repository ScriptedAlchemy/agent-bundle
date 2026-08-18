import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { validateArtifactWithSnapshot } from '../build/validate-artifact.ts';
import { digest } from '../core/digest.ts';
import { EpochStore } from './epoch-store.ts';

const defaultOutputLimit = 64 * 1024;
const defaultTimeoutMs = 5_000;
const terminationGraceMs = 250;

export interface PlaygroundScriptInterpreter {
  readonly args: readonly string[];
  readonly command: string;
}

/** A script is resolved from a validated artifact, never from a browser request. */
export interface ResolvedPlaygroundScript {
  readonly interpreter: PlaygroundScriptInterpreter;
  readonly name: string;
  readonly path: string;
  readonly targetDigest: string;
}

export interface ScriptPlaygroundRunRequest {
  readonly epochId: string;
  readonly script: string;
  readonly signal?: AbortSignal;
  readonly target: string;
}

export interface ScriptPlaygroundResult {
  readonly exitCode: number;
  readonly script: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly targetDigest: string;
}

export interface PlaygroundWorkspaceLease {
  close(): Promise<void>;
  readonly path: string;
}

export interface ServerOwnedScriptExecution {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly outputLimit: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface ScriptExecutionOutput {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ScriptPlaygroundServiceOptions {
  /** Test seam; production always creates an isolated temporary workspace. */
  readonly createWorkspace?: () => Promise<PlaygroundWorkspaceLease>;
  /** Test seam; production executes with a fixed interpreter and no shell. */
  readonly execute?: (options: ServerOwnedScriptExecution) => Promise<ScriptExecutionOutput>;
  readonly epochStore?: EpochStore;
  readonly outputLimit?: number;
  readonly registry?: TargetRegistry;
  /** Test seam for a script already proven to be manifested and artifact-owned. */
  readonly resolveScript?: (request: Omit<ScriptPlaygroundRunRequest, 'signal'>) => Promise<ResolvedPlaygroundScript>;
  readonly timeoutMs?: number;
}

const safeSegment = (value: string): boolean =>
  /^[a-z0-9][a-z0-9._-]*$/iu.test(value) && value !== '.' && value !== '..';

const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith('..') && !path.startsWith('/') && !path.startsWith('\\');
};

const interpreterFor = (suffix: string): PlaygroundScriptInterpreter | undefined => {
  if (suffix === '.mjs') return Object.freeze({ args: Object.freeze([]), command: process.execPath });
  if (suffix === '.py') return Object.freeze({ args: Object.freeze([]), command: 'python3' });
  if (suffix === '.sh') return Object.freeze({ args: Object.freeze([]), command: '/bin/sh' });
  if (suffix === '.bash') return Object.freeze({ args: Object.freeze([]), command: '/bin/bash' });
  return undefined;
};

const workspace = async (): Promise<PlaygroundWorkspaceLease> => {
  const path = await mkdtemp(join(tmpdir(), 'agent-bundle-playground-script-'));
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    close: () => {
      closePromise ??= rm(path, { force: true, recursive: true });
      return closePromise;
    },
    path,
  });
};

const environment = (cwd: string): Readonly<Record<string, string>> => Object.freeze({
  HOME: cwd,
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  PATH: process.env.PATH ?? '/usr/bin:/bin',
});

const terminate = (child: ChildProcess): void => {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // The child may already be gone or unavailable as a process group.
    }
  }
  child.kill('SIGTERM');
};

/** Runs a fixed interpreter without a shell, bounded by server-selected time and output caps. */
const execute = async (options: ServerOwnedScriptExecution): Promise<ScriptExecutionOutput> => new Promise((resolvePromise, rejectPromise) => {
  if (options.signal?.aborted) {
    rejectPromise(options.signal.reason);
    return;
  }
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let settled = false;
  let stdout = '';
  let stderr = '';
  let termination: unknown;
  let killTimer: NodeJS.Timeout | undefined;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
    action();
  };
  const stop = (reason: unknown): void => {
    if (termination !== undefined || settled) return;
    termination = reason;
    terminate(child);
    killTimer = setTimeout(() => {
      if (settled) return;
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall through to the direct child kill below.
        }
      }
      child.kill('SIGKILL');
    }, terminationGraceMs);
  };
  const abort = (): void => stop(options.signal?.reason ?? new Error('Script playground run was cancelled.'));
  const timeout = setTimeout(() => stop(new Error('Script playground run timed out.')), options.timeoutMs);
  const append = (current: string, chunk: Buffer): string => {
    const next = `${current}${chunk.toString('utf8')}`;
    if (Buffer.byteLength(next) > options.outputLimit) stop(new RangeError('Script playground output exceeds its server limit.'));
    return next;
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  child.once('error', (error) => settle(() => rejectPromise(error)));
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once('close', (code) => settle(() => {
    if (termination !== undefined) rejectPromise(termination);
    else resolvePromise(Object.freeze({ exitCode: code ?? -1, stderr, stdout }));
  }));
});

/**
 * Resolves and runs compiled manifest scripts under a sealed execution surface.
 * The public request has no command, path, cwd, args, or environment field.
 */
export class ScriptPlaygroundService {
  readonly #createWorkspace: () => Promise<PlaygroundWorkspaceLease>;
  readonly #epochStore: EpochStore | undefined;
  readonly #execute: (options: ServerOwnedScriptExecution) => Promise<ScriptExecutionOutput>;
  readonly #outputLimit: number;
  readonly #registry: TargetRegistry;
  readonly #resolveScriptOverride: ScriptPlaygroundServiceOptions['resolveScript'];
  readonly #timeoutMs: number;

  constructor(options: ScriptPlaygroundServiceOptions = {}) {
    const outputLimit = options.outputLimit ?? defaultOutputLimit;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new Error('Script playground output limit must be a positive safe integer.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Script playground timeout must be a positive safe integer.');
    this.#createWorkspace = options.createWorkspace ?? workspace;
    this.#epochStore = options.epochStore;
    this.#execute = options.execute ?? execute;
    this.#outputLimit = outputLimit;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#resolveScriptOverride = options.resolveScript;
    this.#timeoutMs = timeoutMs;
  }

  async run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult> {
    const resolved = await this.#resolve({ epochId: request.epochId, script: request.script, target: request.target });
    const lease = await this.#createWorkspace();
    try {
      const result = await this.#execute(Object.freeze({
        args: Object.freeze([...resolved.interpreter.args, resolved.path]),
        command: resolved.interpreter.command,
        cwd: lease.path,
        env: environment(lease.path),
        outputLimit: this.#outputLimit,
        signal: request.signal,
        timeoutMs: this.#timeoutMs,
      }));
      return Object.freeze({
        exitCode: result.exitCode,
        script: resolved.name,
        stderr: result.stderr,
        stdout: result.stdout,
        targetDigest: resolved.targetDigest,
      });
    } finally {
      await lease.close();
    }
  }

  async #resolve(request: Omit<ScriptPlaygroundRunRequest, 'signal'>): Promise<ResolvedPlaygroundScript> {
    if (!safeSegment(request.epochId) || !safeSegment(request.target) || !safeSegment(request.script) || basename(request.script) !== request.script) {
      throw new Error('Script playground request must name safe compiled artifact identifiers.');
    }
    if (this.#resolveScriptOverride !== undefined) return this.#resolveScriptOverride(request);
    const store = this.#epochStore;
    if (store === undefined) throw new Error('Script playground requires an epoch store.');
    const layout = this.#registry.artifactLayout(request.target).scripts;
    if (layout === undefined) throw new Error(`Target ${JSON.stringify(request.target)} does not declare a script artifact layout.`);
    const suffix = extname(request.script);
    if (!layout.allowedSuffixes.includes(suffix)) throw new Error('Requested script is not an allowlisted compiled script.');
    const interpreter = interpreterFor(suffix);
    if (interpreter === undefined) throw new Error('Requested script suffix has no server allowlisted interpreter.');
    const reference = await store.acquireEpochReference(request.epochId);
    try {
      const validated = await validateArtifactWithSnapshot({
        allowEpochStagingMarker: true,
        artifactRoot: reference.root,
        registry: this.#registry,
      });
      if (validated.snapshot === undefined || validated.diagnostics.some((entry) => entry.severity === 'error')) {
        throw new Error('Script playground requires a strictly validated artifact.');
      }
      const path = resolve(reference.root, request.target, layout.directory, request.script);
      if (!contained(reference.root, path)) throw new Error('Resolved script escapes the published artifact.');
      const relativePath = `${request.target}/${layout.directory}/${request.script}`;
      const manifestFile = validated.snapshot.manifest.files.find((file) => file.path === relativePath);
      if (manifestFile === undefined) throw new Error('Requested script is absent from the validated artifact manifest.');
      const targetFiles = validated.snapshot.manifest.files
        .filter((file) => file.path.startsWith(`${request.target}/`))
        .map((file) => Object.freeze({ path: file.path, sha256: file.sha256 }));
      return Object.freeze({
        interpreter,
        name: request.script,
        path,
        targetDigest: digest(targetFiles),
      });
    } finally {
      await reference.close();
    }
  }
}
