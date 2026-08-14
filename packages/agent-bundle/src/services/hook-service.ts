import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, posix, resolve } from 'node:path';

import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';
import {
  artifactHookIndexName,
  type ArtifactHook,
  type ArtifactHookIndex,
} from '../build/emit.ts';
import { validateArtifact } from '../build/validate-artifact.ts';

const defaultTimeoutMs = 5_000;
const maxStreamBytes = 1_000_000;
const terminationGraceMs = 250;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeArtifactPath = (path: string): boolean =>
  path.length > 0 &&
  !isAbsolute(path) &&
  path === posix.normalize(path) &&
  path !== '..' &&
  !path.startsWith('../');

const parseHookIndex = (value: string): ArtifactHookIndex | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<ArtifactHookIndex>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.hooks) ||
      !parsed.hooks.every((hook) =>
        isRecord(hook) &&
        typeof hook.event === 'string' &&
        typeof hook.id === 'string' &&
        typeof hook.name === 'string' &&
        typeof hook.path === 'string' &&
        typeof hook.target === 'string' &&
        (hook.timeout === undefined || (typeof hook.timeout === 'number' && Number.isInteger(hook.timeout) && hook.timeout > 0)),
      )
    ) {
      return undefined;
    }
    return parsed as ArtifactHookIndex;
  } catch {
    return undefined;
  }
};

const runWrapper = async (options: {
  readonly cwd: string;
  readonly input: Record<string, unknown>;
  readonly signal?: AbortSignal;
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
    env: { ...process.env, AGENT_BUNDLE_HOOK_SIMULATION: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let streamLimitExceeded = false;
  let closed = false;
  let settled = false;
  let terminationError: Error | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
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
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
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
    if (terminationError !== undefined) {
      settle(() => reject(terminationError!));
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
  async list(options: HookListOptions): Promise<readonly ArtifactHook[]> {
    const artifact = resolve(options.artifact);
    const diagnostics = await validateArtifact({
      ...(options.allowEpochStagingMarker === true ? { allowEpochStagingMarker: true } : {}),
      artifactRoot: artifact,
    });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) throw new DiagnosticError(errors);

    const index = parseHookIndex(await readFile(joinArtifact(artifact, artifactHookIndexName), 'utf8'));
    if (index === undefined) {
      throw new Error('Artifact hook metadata is missing or invalid.');
    }
    const hooks = index.hooks.filter((hook) => {
      if (!isSafeArtifactPath(hook.path)) {
        throw new Error(`Artifact hook metadata contains unsafe path ${JSON.stringify(hook.path)}.`);
      }
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: hook.timeout === undefined ? defaultTimeoutMs : hook.timeout * 1_000,
      wrapper,
    });
  }
}

const joinArtifact = (root: string, relativePath: string): string =>
  assertInside(root, resolve(root, relativePath));
