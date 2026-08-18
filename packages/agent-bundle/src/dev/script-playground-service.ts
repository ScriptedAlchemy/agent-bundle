import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { validateArtifactWithSnapshot } from '../build/validate-artifact.ts';
import { taskkill, terminateProcessTree } from '../services/process-tree.ts';
import { artifactScriptCatalog } from './artifact-script-catalog.ts';
import { EpochStore, type EpochReference } from './epoch-store.ts';

const defaultOutputLimit = 64 * 1024;
const defaultTimeoutMs = 5_000;
const terminationGraceMs = 250;
const terminationSettlementMs = 250;

export interface PlaygroundScriptInterpreter {
  readonly args: readonly string[];
  readonly command: string;
}

/** A script is resolved from a validated artifact, never from a browser request. */
export interface ResolvedPlaygroundScript {
  readonly interpreter: PlaygroundScriptInterpreter;
  readonly name: string;
  readonly path: string;
}

export interface ScriptPlaygroundRunRequest {
  readonly epochId: string;
  readonly scriptId: string;
  readonly signal?: AbortSignal;
  readonly target: string;
}

export interface ScriptPlaygroundResult {
  readonly exitCode: number;
  readonly script: string;
  readonly stderr: string;
  readonly stdout: string;
}

export interface PlaygroundWorkspaceLease {
  close(): Promise<void>;
  readonly path: string;
}

export interface ScriptPlaygroundServiceOptions {
  /** Test seam; production always creates an isolated temporary workspace. */
  readonly createWorkspace?: () => Promise<PlaygroundWorkspaceLease>;
  readonly epochStore?: EpochStore;
  readonly outputLimit?: number;
  readonly registry?: TargetRegistry;
  /** Test seam for a script already proven to be manifested and artifact-owned. */
  readonly resolveScript?: (request: Omit<ScriptPlaygroundRunRequest, 'signal'>) => Promise<ResolvedPlaygroundScript>;
  readonly timeoutMs?: number;
}

class ScriptPlaygroundAbortError extends Error {
  constructor() {
    super('Script execution was cancelled.');
    this.name = 'AbortError';
  }
}

const safeSegment = (value: string): boolean =>
  /^[a-z0-9][a-z0-9._-]*$/iu.test(value) && value !== '.' && value !== '..';

const safeScriptId = (value: string): boolean =>
  /^script:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(value);

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

const spawnFailure = (error: unknown): Error => {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return new Error('Script interpreter is not available.');
  }
  return new Error('Script execution could not be spawned.');
};

const execute = async (options: {
  readonly cwd: string;
  readonly outputLimit: number;
  readonly resolved: ResolvedPlaygroundScript;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<Readonly<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>> => new Promise((resolvePromise, rejectPromise) => {
  if (options.signal?.aborted) {
    rejectPromise(new ScriptPlaygroundAbortError());
    return;
  }
  let child: ChildProcess;
  try {
    child = spawn(options.resolved.interpreter.command, [...options.resolved.interpreter.args, options.resolved.path], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: environment(options.cwd),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    rejectPromise(spawnFailure(error));
    return;
  }

  let closed = false;
  let settled = false;
  let spawnError: Error | undefined;
  let termination: Error | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let terminationSettlementTimer: NodeJS.Timeout | undefined;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  const cleanup = () => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (terminationSettlementTimer !== undefined) clearTimeout(terminationSettlementTimer);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const terminate = (error: Error): void => {
    if (closed || termination !== undefined) return;
    termination = error;
    const terminateTree = (signal: NodeJS.Signals): void => terminateProcessTree(child, signal, {
      onTreeTerminationFailure: () => undefined,
      platform: process.platform,
      taskkill,
    });
    terminateTree('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (closed) return;
      terminateTree('SIGKILL');
      terminationSettlementTimer = setTimeout(() => {
        if (closed) return;
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() => rejectPromise(new Error('Script process tree did not settle after termination.')));
      }, terminationSettlementMs);
    }, terminationGraceMs);
  };
  const onAbort = (): void => terminate(new ScriptPlaygroundAbortError());
  const timeoutTimer = setTimeout(() => terminate(new Error('Script execution timed out.')), options.timeoutMs);
  const append = (destination: Buffer[], chunk: Buffer): void => {
    const remaining = options.outputLimit - outputBytes;
    if (remaining <= 0) return;
    if (chunk.length > remaining) {
      destination.push(chunk.subarray(0, remaining));
      outputBytes += remaining;
      terminate(new Error('Script execution output exceeded the configured limit.'));
      return;
    }
    destination.push(chunk);
    outputBytes += chunk.length;
  };

  options.signal?.addEventListener('abort', onAbort, { once: true });
  child.once('error', (error) => { spawnError = spawnFailure(error); });
  child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
  child.once('close', (exitCode) => {
    closed = true;
    if (termination !== undefined) {
      settle(() => rejectPromise(termination!));
      return;
    }
    if (spawnError !== undefined) {
      settle(() => rejectPromise(spawnError!));
      return;
    }
    if (exitCode === null) {
      settle(() => rejectPromise(new Error('Script process exited without an exit code.')));
      return;
    }
    settle(() => resolvePromise(Object.freeze({
      exitCode,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    })));
  });
});

interface ResolvedEpochScript {
  readonly reference: EpochReference;
  readonly script: ResolvedPlaygroundScript;
}

/** Runs a selected emitted script with a server-owned command, environment, workspace, and epoch lease. */
export class ScriptPlaygroundService {
  readonly #createWorkspace: () => Promise<PlaygroundWorkspaceLease>;
  readonly #epochStore: EpochStore | undefined;
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
    this.#outputLimit = outputLimit;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#resolveScriptOverride = options.resolveScript;
    this.#timeoutMs = timeoutMs;
  }

  async run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult> {
    this.#assertRequest(request);
    const override = this.#resolveScriptOverride;
    if (override !== undefined) return this.#runResolved(await override(request), request.signal);
    const resolved = await this.#resolve(request);
    try {
      return await this.#runResolved(resolved.script, request.signal);
    } finally {
      await resolved.reference.close();
    }
  }

  async #runResolved(resolved: ResolvedPlaygroundScript, signal?: AbortSignal): Promise<ScriptPlaygroundResult> {
    const lease = await this.#createWorkspace();
    try {
      const result = await execute({
        cwd: lease.path,
        outputLimit: this.#outputLimit,
        resolved,
        signal,
        timeoutMs: this.#timeoutMs,
      });
      return Object.freeze({ script: resolved.name, ...result });
    } finally {
      await lease.close();
    }
  }

  async #resolve(request: Omit<ScriptPlaygroundRunRequest, 'signal'>): Promise<ResolvedEpochScript> {
    const store = this.#epochStore;
    if (store === undefined) throw new Error('Script playground requires an epoch store.');
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
      const selected = artifactScriptCatalog(validated.snapshot.manifest, this.#registry)
        .find((entry) => entry.target === request.target && entry.id === request.scriptId);
      if (selected === undefined) throw new Error('Requested script is not in the validated artifact script catalog.');
      const path = resolve(reference.root, selected.file);
      if (!contained(reference.root, path)) throw new Error('Resolved script escapes the published artifact.');
      const interpreter = interpreterFor(extname(path));
      if (interpreter === undefined) throw new Error('Requested script suffix has no server allowlisted interpreter.');
      return Object.freeze({
        reference,
        script: Object.freeze({ interpreter, name: selected.name, path }),
      });
    } catch (error) {
      await reference.close();
      throw error;
    }
  }

  #assertRequest(request: ScriptPlaygroundRunRequest): void {
    if (!safeSegment(request.epochId) || !safeSegment(request.target) || !safeScriptId(request.scriptId)) {
      throw new Error('Script playground request must name safe compiled artifact identifiers.');
    }
  }
}
