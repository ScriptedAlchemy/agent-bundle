import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';
import {
  artifactHookIndexName,
  type ArtifactHook,
} from '../build/emit.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { parseArtifactHookIndex } from './hook-index.ts';

const defaultTimeoutMs = 5_000;
const maxStreamBytes = 1_000_000;
const terminationGraceMs = 250;
const terminationSettlementMs = 250;

type Taskkill = (arguments_: readonly string[]) => ChildProcess;

export interface HookListOptions {
  /** Internal epoch callers may allow the store-owned staging marker. */
  readonly allowEpochStagingMarker?: true;
  readonly artifact: string;
  readonly target?: string;
}

export interface HookSimulationOptions {
  /** Internal epoch callers may allow the store-owned staging marker. */
  readonly allowEpochStagingMarker?: true;
  readonly artifact: string;
  readonly hook: string;
  readonly input: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly target: string;
}

export interface HookServiceOptions {
  /** Internal test seam; production uses the current host platform. */
  readonly platform?: NodeJS.Platform;
  /** Target contracts that own and validate the artifact. */
  readonly registry?: TargetRegistry;
  /** Internal test seam; production runs Windows taskkill directly. */
  readonly taskkill?: Taskkill;
}

class HookSimulationTerminationError extends Error {
  readonly code = 'hook.simulation.termination.unsettled';

  constructor(reason: Error) {
    super(`${reason.message} Wrapper process tree did not settle after termination.`);
    this.name = 'HookSimulationTerminationError';
  }
}

const taskkill: Taskkill = (arguments_) => spawn('taskkill', [...arguments_], {
  stdio: 'ignore',
  windowsHide: true,
});

const terminateProcessTree = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: { readonly onTreeTerminationFailure: () => void; readonly platform: NodeJS.Platform; readonly taskkill: Taskkill },
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

const runWrapper = async (options: {
  readonly cwd: string;
  readonly input: Record<string, unknown>;
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly taskkill: Taskkill;
  readonly timeoutMs: number;
  readonly wrapper: string;
}): Promise<unknown> => new Promise((resolvePromise, reject) => {
  let encoded: string;
  try {
    encoded = JSON.stringify(options.input);
  } catch {
    reject(new TypeError('Hook simulation input must be JSON-serializable.'));
    return;
  }
  if (Buffer.byteLength(encoded) > maxStreamBytes) {
    reject(new RangeError('Hook simulation input exceeds the 1 MB limit.'));
    return;
  }
  if (options.signal?.aborted) {
    reject(new Error('Hook simulation aborted.'));
    return;
  }

  const child = spawn(process.execPath, [options.wrapper], {
    cwd: options.cwd,
    detached: options.platform !== 'win32',
    env: { ...process.env, AGENT_BUNDLE_HOOK_SIMULATION: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let streamLimitExceeded = false;
  let closed = false;
  let settled = false;
  let terminationError: Error | undefined;
  let treeTerminationFailed = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let terminationSettlementTimer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (terminationSettlementTimer !== undefined) clearTimeout(terminationSettlementTimer);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const settle = (action: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const terminate = (error: Error) => {
    if (terminationError !== undefined || closed) return;
    terminationError = error;
    const terminateTree = (signal: NodeJS.Signals) => terminateProcessTree(child, signal, {
      onTreeTerminationFailure: () => { treeTerminationFailed = true; },
      platform: options.platform,
      taskkill: options.taskkill,
    });
    terminateTree('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (closed) return;
      terminateTree('SIGKILL');
      terminationSettlementTimer = setTimeout(() => {
        const errorToReport = terminationError;
        if (closed || errorToReport === undefined) return;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() => reject(new HookSimulationTerminationError(errorToReport)));
      }, terminationSettlementMs);
    }, terminationGraceMs);
  };
  const onAbort = () => terminate(new Error('Hook simulation aborted.'));
  const timeoutTimer = setTimeout(() => terminate(new Error('Hook simulation timed out.')), options.timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const append = (current: string, chunk: Buffer): string => {
    const next = `${current}${chunk.toString()}`;
    if (Buffer.byteLength(next) > maxStreamBytes) {
      streamLimitExceeded = true;
      terminate(new RangeError('Hook simulation output exceeds the 1 MB limit.'));
    }
    return next;
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  child.once('error', (error) => {
    settle(() => reject(error));
  });
  child.once('close', (code) => {
    closed = true;
    const errorToReport = terminationError;
    if (errorToReport !== undefined) {
      settle(() => reject(treeTerminationFailed
        ? new HookSimulationTerminationError(errorToReport)
        : errorToReport));
      return;
    }
    if (streamLimitExceeded) {
      settle(() => reject(new RangeError('Hook simulation output exceeds the 1 MB limit.')));
      return;
    }
    if (code !== 0) {
      settle(() => reject(new Error(stderr.trim() || 'Generated hook wrapper failed.')));
      return;
    }
    if (stdout.trim().length === 0) {
      settle(() => resolvePromise(undefined));
      return;
    }
    try {
      settle(() => resolvePromise(JSON.parse(stdout)));
    } catch {
      settle(() => reject(new Error('Generated hook wrapper produced invalid JSON.')));
    }
  });
  child.stdin.end(encoded);
});

export class HookService {
  readonly #platform: NodeJS.Platform;
  readonly #registry: TargetRegistry;
  readonly #taskkill: Taskkill;

  constructor(options: HookServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#taskkill = options.taskkill ?? taskkill;
  }

  async list(options: HookListOptions): Promise<readonly ArtifactHook[]> {
    const artifact = resolve(options.artifact);
    const diagnostics = await validateArtifact({
      ...(options.allowEpochStagingMarker === true ? { allowEpochStagingMarker: true } : {}),
      artifactRoot: artifact,
      registry: this.#registry,
    });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) throw new DiagnosticError(errors);

    const index = parseArtifactHookIndex(await readFile(joinArtifact(artifact, artifactHookIndexName), 'utf8'));
    if (index === undefined) {
      throw new Error('Artifact hook metadata is missing or invalid.');
    }
    const hooks = index.hooks.filter((hook) => {
      return options.target === undefined || hook.target === options.target;
    });
    return Object.freeze(hooks.map((hook) => Object.freeze({ ...hook })));
  }

  async simulate(options: HookSimulationOptions): Promise<unknown> {
    const artifact = resolve(options.artifact);
    const hooks = await this.list({
      ...(options.allowEpochStagingMarker === true ? { allowEpochStagingMarker: true } : {}),
      artifact,
      target: options.target,
    });
    const matches = hooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${options.target} hook matching ${JSON.stringify(options.hook)}.`);
    }
    const hook = matches[0]!;
    const wrapper = joinArtifact(artifact, hook.path);
    return runWrapper({
      cwd: artifact,
      input: options.input,
      platform: this.#platform,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      taskkill: this.#taskkill,
      timeoutMs: hook.timeout === undefined ? defaultTimeoutMs : hook.timeout * 1_000,
      wrapper,
    });
  }
}

const joinArtifact = (root: string, relativePath: string): string =>
  assertInside(root, resolve(root, relativePath));
