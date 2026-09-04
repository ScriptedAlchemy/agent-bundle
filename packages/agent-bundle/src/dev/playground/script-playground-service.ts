import { spawn, type ChildProcess } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Effect, FileSystem } from 'effect';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import { validateArtifactWithSnapshot } from '../../build/validate-artifact.ts';
import { isErrno } from '../../core/errors.ts';
import { isInside } from '../../core/paths.ts';
import { type PlatformRun } from '../../effect/platform.ts';
import { platformRunOf } from '../platform-run.ts';
import type { DevPlatformRuntime } from '../platform-runtime.ts';
import {
  taskkill,
  terminateProcessTree,
  waitForProcessTreeExit,
  type ProcessTreeTaskkill,
} from '../../services/process-tree.ts';
import { artifactScriptCatalog } from '../artifacts/artifact-script-catalog.ts';
import { EpochStore, type EpochReference } from '../epoch-store.ts';
import { YieldableCodedError, YieldableFrameworkError } from '../../effect/errors.ts';

const defaultOutputLimit = 64 * 1024;
const defaultTimeoutMs = 5_000;
const terminationGraceMs = 250;
const terminationSettlementMs = 250;
const terminationPollMs = 10;

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
  readonly cleanupFailures?: readonly ScriptPlaygroundCleanupFailure[];
  readonly exitCode: number;
  readonly script: string;
  readonly stderr: string;
  readonly stdout: string;
}

export type ScriptPlaygroundCleanupFailureCode =
  | 'epoch-release-failed'
  | 'workspace-release-failed';

export interface ScriptPlaygroundCleanupFailure {
  readonly code: ScriptPlaygroundCleanupFailureCode;
}

export type ScriptPlaygroundFailureCode =
  | 'cleanup-failed'
  | 'interpreter-unavailable'
  | 'output-limit'
  | 'spawn-failed'
  | 'timeout';

/** Stable script infrastructure failure with bounded captured output safe for durable evidence. */
export class ScriptPlaygroundFailure extends YieldableCodedError<ScriptPlaygroundFailureCode> {
  readonly cleanupFailures: readonly ScriptPlaygroundCleanupFailure[];
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    code: ScriptPlaygroundFailureCode,
    message: string,
    output: Pick<ScriptPlaygroundResult, 'stderr' | 'stdout'>,
    cleanupFailures: readonly ScriptPlaygroundCleanupFailure[] = [],
  ) {
    super('ScriptPlaygroundFailure', code, message);
    this.cleanupFailures = Object.freeze([...cleanupFailures]);
    this.stderr = output.stderr;
    this.stdout = output.stdout;
  }
}

export class ScriptPlaygroundAbortError extends YieldableFrameworkError {
  readonly cleanupFailures: readonly ScriptPlaygroundCleanupFailure[];

  constructor(cleanupFailures: readonly ScriptPlaygroundCleanupFailure[] = []) {
    super('Script execution was cancelled.');
    this.name = 'AbortError';
    this.cleanupFailures = Object.freeze([...cleanupFailures]);
  }
}

export interface ScriptPlaygroundProcessTree {
  terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<boolean>;
  waitForExit(child: ChildProcess): Promise<boolean>;
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
  /** Internal test seam; production uses the platform process-tree cleanup implementation. */
  readonly platform?: NodeJS.Platform;
  /** Internal test seam for observable process-tree cleanup completion. */
  readonly processTree?: ScriptPlaygroundProcessTree;
  readonly registry?: TargetRegistry;
  /** Test seam for a script already proven to be manifested and artifact-owned. */
  readonly resolveScript?: (request: Omit<ScriptPlaygroundRunRequest, 'signal'>) => Promise<ResolvedPlaygroundScript>;
  /** Internal test seam for the epoch lease paired with resolveScript. */
  readonly releaseEpochReference?: () => Promise<void>;
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
  /** Internal test seam; production invokes Windows taskkill directly. */
  readonly taskkill?: ProcessTreeTaskkill;
  readonly timeoutMs?: number;
}

const safeSegment = (value: string): boolean =>
  /^[a-z0-9][a-z0-9._-]*$/iu.test(value) && value !== '.' && value !== '..';

const safeScriptId = (value: string): boolean =>
  /^script:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(value);

const interpreterFor = (suffix: string): PlaygroundScriptInterpreter | undefined => {
  if (suffix === '.mjs') return Object.freeze({ args: Object.freeze([]), command: process.execPath });
  if (suffix === '.py') return Object.freeze({ args: Object.freeze([]), command: 'python3' });
  if (suffix === '.sh') return Object.freeze({ args: Object.freeze([]), command: '/bin/sh' });
  if (suffix === '.bash') return Object.freeze({ args: Object.freeze([]), command: '/bin/bash' });
  return undefined;
};

/**
 * Not a `withTempDirectory` bracket: the lease's `close` is a separate step
 * of the run so that a workspace removal failure is reported in the result
 * (`cleanupFailures`) instead of replacing the script's outcome.
 */
const workspace = async (run: PlatformRun): Promise<PlaygroundWorkspaceLease> => {
  const path = await run(Effect.flatMap(
    FileSystem.FileSystem,
    (fs) => fs.makeTempDirectory({ directory: tmpdir(), prefix: 'agent-bundle-playground-script-' }),
  ));
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    close: () => {
      closePromise ??= run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path, { force: true, recursive: true })));
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

const spawnFailure = (error: unknown, output: Pick<ScriptPlaygroundResult, 'stderr' | 'stdout'>): ScriptPlaygroundFailure => {
  if (isErrno(error, 'ENOENT')) {
    return new ScriptPlaygroundFailure('interpreter-unavailable', 'Script interpreter is not available.', output);
  }
  return new ScriptPlaygroundFailure('spawn-failed', 'Script execution could not be spawned.', output);
};

const cleanupFailure = (code: ScriptPlaygroundCleanupFailureCode): ScriptPlaygroundCleanupFailure => Object.freeze({ code });

export const scriptPlaygroundCleanupFailures = (value: unknown): readonly ScriptPlaygroundCleanupFailure[] =>
  value instanceof ScriptPlaygroundAbortError || value instanceof ScriptPlaygroundFailure
    ? value.cleanupFailures
    : [];

const appendCleanupFailures = (error: unknown, failures: readonly ScriptPlaygroundCleanupFailure[]): Error => {
  const cleanupFailures = Object.freeze([...scriptPlaygroundCleanupFailures(error), ...failures]);
  if (error instanceof ScriptPlaygroundFailure) {
    return new ScriptPlaygroundFailure(error.code, error.message, error, cleanupFailures);
  }
  if (error instanceof ScriptPlaygroundAbortError) return new ScriptPlaygroundAbortError(cleanupFailures);
  return new AggregateError([error, ...cleanupFailures], 'Script execution and lifecycle cleanup both failed.', { cause: error });
};

const resultWithCleanupFailures = (
  result: ScriptPlaygroundResult,
  failures: readonly ScriptPlaygroundCleanupFailure[],
): ScriptPlaygroundResult => failures.length === 0
  ? result
  : Object.freeze({
    ...result,
    cleanupFailures: Object.freeze([
      ...(result.cleanupFailures ?? []),
      ...failures,
    ]),
  });

const preserveOutcomeThroughCleanup = async (
  work: () => Promise<ScriptPlaygroundResult>,
  close: () => Promise<void>,
  failureCode: ScriptPlaygroundCleanupFailureCode,
): Promise<ScriptPlaygroundResult> => {
  let result: ScriptPlaygroundResult | undefined;
  let primary: unknown;
  try { result = await work(); }
  catch (error) { primary = error; }
  let failure: ScriptPlaygroundCleanupFailure | undefined;
  try { await close(); }
  catch { failure = cleanupFailure(failureCode); }
  if (primary !== undefined) throw failure === undefined ? primary : appendCleanupFailures(primary, [failure]);
  return resultWithCleanupFailures(result!, failure === undefined ? [] : [failure]);
};

const closeNothing = async (): Promise<void> => undefined;

const execute = async (options: {
  readonly cwd: string;
  readonly outputLimit: number;
  readonly platform: NodeJS.Platform;
  readonly processTree: ScriptPlaygroundProcessTree;
  readonly resolved: ResolvedPlaygroundScript;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<Readonly<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>> => new Promise((resolvePromise, rejectPromise) => {
  if (options.signal?.aborted) {
    rejectPromise(new ScriptPlaygroundAbortError());
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const capturedOutput = (): Pick<ScriptPlaygroundResult, 'stderr' | 'stdout'> => Object.freeze({
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  });
  let child: ChildProcess;
  try {
    child = spawn(options.resolved.interpreter.command, [...options.resolved.interpreter.args, options.resolved.path], {
      cwd: options.cwd,
      detached: options.platform !== 'win32',
      env: environment(options.cwd),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    rejectPromise(spawnFailure(error, capturedOutput()));
    return;
  }

  let childClosed = false;
  let finalCleanupFinished = false;
  let processTreeClean = true;
  let settled = false;
  let spawnError: ScriptPlaygroundFailure | undefined;
  let termination: ScriptPlaygroundAbortError | Readonly<{ readonly code: ScriptPlaygroundFailureCode; readonly message: string }> | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let terminationSettlementTimer: NodeJS.Timeout | undefined;
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
  const terminationError = (): Error => {
    if (termination instanceof ScriptPlaygroundAbortError) return termination;
    return new ScriptPlaygroundFailure(termination!.code, termination!.message, capturedOutput());
  };
  const cleanupFailureError = (): ScriptPlaygroundFailure => new ScriptPlaygroundFailure(
    'cleanup-failed',
    'Script process tree cleanup could not be confirmed.',
    capturedOutput(),
  );
  const settleTermination = (): void => {
    if (!childClosed || !finalCleanupFinished) return;
    settle(() => rejectPromise(processTreeClean ? terminationError() : cleanupFailureError()));
  };
  const forceCleanupFailure = (): void => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    settle(() => rejectPromise(cleanupFailureError()));
  };
  const finishFinalCleanup = (clean: boolean): void => {
    if (finalCleanupFinished) return;
    finalCleanupFinished = true;
    if (terminationSettlementTimer !== undefined) clearTimeout(terminationSettlementTimer);
    processTreeClean = clean;
    if (childClosed) {
      settleTermination();
      return;
    }
    if (!clean) {
      forceCleanupFailure();
      return;
    }
    terminationSettlementTimer = setTimeout(forceCleanupFailure, terminationSettlementMs);
  };
  const startFinalCleanup = (termCompleted: boolean): void => {
    void (async () => {
      const killCompleted = await options.processTree.terminate(child, 'SIGKILL');
      const drained = await options.processTree.waitForExit(child);
      finishFinalCleanup(drained && (termCompleted || killCompleted));
    })().catch(() => finishFinalCleanup(false));
  };
  const terminate = (failure: typeof termination): void => {
    if (childClosed || termination !== undefined || failure === undefined) return;
    termination = failure;
    void options.processTree.terminate(child, 'SIGTERM').then(
      (termCompleted) => {
        forceKillTimer = setTimeout(() => startFinalCleanup(termCompleted), terminationGraceMs);
      },
      () => {
        forceKillTimer = setTimeout(() => startFinalCleanup(false), terminationGraceMs);
      },
    );
  };
  const onAbort = (): void => terminate(new ScriptPlaygroundAbortError());
  const timeoutTimer = setTimeout(() => terminate(Object.freeze({
    code: 'timeout' as const,
    message: 'Script execution timed out.',
  })), options.timeoutMs);
  const append = (destination: Buffer[], chunk: Buffer): void => {
    const remaining = options.outputLimit - outputBytes;
    if (remaining <= 0) return;
    if (chunk.length > remaining) {
      destination.push(chunk.subarray(0, remaining));
      outputBytes += remaining;
      terminate(Object.freeze({
        code: 'output-limit' as const,
        message: 'Script execution output exceeded the configured limit.',
      }));
      return;
    }
    destination.push(chunk);
    outputBytes += chunk.length;
  };

  options.signal?.addEventListener('abort', onAbort, { once: true });
  child.once('error', (error) => { spawnError = spawnFailure(error, capturedOutput()); });
  child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
  child.once('close', (exitCode) => {
    childClosed = true;
    if (termination !== undefined) {
      settleTermination();
      return;
    }
    if (spawnError !== undefined) {
      settle(() => rejectPromise(spawnError!));
      return;
    }
    if (exitCode === null) {
      settle(() => rejectPromise(new ScriptPlaygroundFailure(
        'spawn-failed',
        'Script process exited without an exit code.',
        capturedOutput(),
      )));
      return;
    }
    settle(() => resolvePromise(Object.freeze({
      exitCode,
      ...capturedOutput(),
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
  readonly #platform: NodeJS.Platform;
  readonly #processTree: ScriptPlaygroundProcessTree;
  readonly #registry: TargetRegistry;
  readonly #releaseEpochReferenceOverride: ScriptPlaygroundServiceOptions['releaseEpochReference'];
  readonly #resolveScriptOverride: ScriptPlaygroundServiceOptions['resolveScript'];
  readonly #timeoutMs: number;

  constructor(options: ScriptPlaygroundServiceOptions = {}) {
    const outputLimit = options.outputLimit ?? defaultOutputLimit;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new Error('Script playground output limit must be a positive safe integer.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Script playground timeout must be a positive safe integer.');
    const run = platformRunOf(options.platformRuntime);
    this.#createWorkspace = options.createWorkspace ?? (() => workspace(run));
    this.#epochStore = options.epochStore;
    this.#outputLimit = outputLimit;
    this.#platform = options.platform ?? process.platform;
    const taskkillCommand = options.taskkill ?? taskkill;
    this.#processTree = options.processTree ?? Object.freeze({
      terminate: (child: ChildProcess, signal: NodeJS.Signals) => terminateProcessTree(child, signal, {
        onTreeTerminationFailure: () => undefined,
        platform: this.#platform,
        taskkill: taskkillCommand,
      }),
      waitForExit: (child: ChildProcess) => waitForProcessTreeExit(child, {
        platform: this.#platform,
        pollMilliseconds: terminationPollMs,
        timeoutMilliseconds: terminationSettlementMs,
      }),
    });
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#releaseEpochReferenceOverride = options.releaseEpochReference;
    this.#resolveScriptOverride = options.resolveScript;
    this.#timeoutMs = timeoutMs;
  }

  async run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult> {
    this.#assertRequest(request);
    const override = this.#resolveScriptOverride;
    if (override !== undefined) {
      return preserveOutcomeThroughCleanup(
        async () => this.#runResolved(await override(request), request.signal),
        this.#releaseEpochReferenceOverride ?? closeNothing,
        'epoch-release-failed',
      );
    }
    const resolved = await this.#resolve(request);
    return preserveOutcomeThroughCleanup(
      () => this.#runResolved(resolved.script, request.signal),
      () => resolved.reference.close(),
      'epoch-release-failed',
    );
  }

  async #runResolved(resolved: ResolvedPlaygroundScript, signal?: AbortSignal): Promise<ScriptPlaygroundResult> {
    const lease = await this.#createWorkspace();
    return preserveOutcomeThroughCleanup(async () => {
      const result = await execute({
        cwd: lease.path,
        outputLimit: this.#outputLimit,
        platform: this.#platform,
        processTree: this.#processTree,
        resolved,
        signal,
        timeoutMs: this.#timeoutMs,
      });
      return Object.freeze({ script: resolved.name, ...result });
    }, () => lease.close(), 'workspace-release-failed');
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
      if (!isInside(reference.root, path)) throw new Error('Resolved script escapes the published artifact.');
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
