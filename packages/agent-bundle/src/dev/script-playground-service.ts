import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { validateArtifactWithSnapshot } from '../build/validate-artifact.ts';
import { EpochStore } from './epoch-store.ts';

const defaultOutputLimit = 64 * 1024;
const defaultTimeoutMs = 5_000;

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
  readonly script: string;
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

/**
 * Production executors must provide an OS-level containment boundary that can
 * prove all descendants are gone before resolving. Node process groups cannot
 * make that claim because scripts can escape through setsid or double-fork.
 */
export type ContainedScriptExecutor = (options: ServerOwnedScriptExecution) => Promise<ScriptExecutionOutput>;

export interface ScriptPlaygroundServiceOptions {
  /** Test seam; production always creates an isolated temporary workspace. */
  readonly createWorkspace?: () => Promise<PlaygroundWorkspaceLease>;
  /** Explicit platform capability; without it script.run is safely unavailable. */
  readonly executor?: ContainedScriptExecutor;
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

/**
 * Resolves and runs compiled manifest scripts under a sealed execution surface.
 * The public request has no command, path, cwd, args, or environment field.
 */
export class ScriptPlaygroundService {
  readonly #createWorkspace: () => Promise<PlaygroundWorkspaceLease>;
  readonly #epochStore: EpochStore | undefined;
  readonly #executor: ContainedScriptExecutor | undefined;
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
    this.#executor = options.executor;
    this.#outputLimit = outputLimit;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#resolveScriptOverride = options.resolveScript;
    this.#timeoutMs = timeoutMs;
  }

  async run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult> {
    const executor = this.#executor;
    if (executor === undefined) throw new Error('Script playground execution is unavailable without a contained executor.');
    const resolved = await this.#resolve({ epochId: request.epochId, script: request.script, target: request.target });
    const lease = await this.#createWorkspace();
    try {
      const result = await executor(Object.freeze({
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
      return Object.freeze({
        interpreter,
        name: request.script,
        path,
      });
    } finally {
      await reference.close();
    }
  }
}
