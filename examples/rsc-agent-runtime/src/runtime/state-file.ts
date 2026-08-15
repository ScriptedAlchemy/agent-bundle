import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import lockfile from 'proper-lockfile';

import type {
  EditEvent,
  JsonValue,
  RuntimeKernel,
  RuntimeMutationOptions,
  RuntimeSnapshot,
  RuntimeStateRecord,
} from './contracts.js';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_MUTATION_MS = 10_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const PRODUCTION_LOCK_TIMING = Object.freeze({ stale: 30_000, update: 5_000 });
const TEST_LOCK_TIMING = Object.freeze({ stale: 2_000, update: 1_000 });

export class RuntimeStateCorruptionError extends Error {
  readonly line: number;
  readonly offset: number;

  constructor({ line, message, offset }: { line: number; message: string; offset: number }) {
    super(`Runtime state corruption at line ${line}, byte ${offset}: ${message}`);
    this.name = 'RuntimeStateCorruptionError';
    this.line = line;
    this.offset = offset;
  }
}

export class RuntimeStateLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeStateLockError';
  }
}

export interface FileRuntimeKernelOptions {
  stateFile: string;
  now?: () => Date;
  createId?: () => string;
  /** Enables the contained, symlink-resistant workspace fallback path mode. */
  workspaceFallbackRoot?: string;
}

type StateLeaseRelease = () => Promise<void>;

export interface RuntimeStateTestAdapter {
  readonly beforeAppend?: () => Promise<void>;
  readonly beforeRead?: () => Promise<void>;
  readonly criticalSectionMs?: number;
  readonly lockTiming?: Readonly<{ staleMs: 2_000; updateMs: 1_000 }>;
  readonly platform?: NodeJS.Platform;
  readonly prepareStateFile?: (input: Readonly<{ stateFile: string; workspaceFallbackRoot: string | undefined }>) => Promise<string>;
  readonly syncParent?: (directory: string) => Promise<void>;
  readonly acquireLock?: (input: Readonly<{
    onCompromised: (error: Error) => void;
    stale: number;
    stateFile: string;
    update: number;
  }>) => Promise<StateLeaseRelease>;
}

interface ParsedState {
  readonly completeBytes: number;
  readonly records: readonly RuntimeStateRecord[];
  readonly snapshot: RuntimeSnapshot;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  const record = asRecord(value);
  return record !== undefined && Object.values(record).every(isJsonValue);
};

const isEditEvent = (value: unknown): value is EditEvent => {
  const event = asRecord(value);
  return (
    event !== undefined &&
    hasOnlyKeys(event, ['eventId', 'host', 'path', 'recordedAt', 'sessionId', 'toolName']) &&
    isNonEmptyString(event.eventId) &&
    (event.host === 'claude' || event.host === 'codex') &&
    isNonEmptyString(event.sessionId) &&
    isNonEmptyString(event.toolName) &&
    isNonEmptyString(event.path) &&
    isNonEmptyString(event.recordedAt)
  );
};

const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
};

const canonicalRecordInput = (record: RuntimeStateRecord): string =>
  record.kind === 'edit'
    ? canonicalize({
        event: {
          host: record.event.host,
          path: record.event.path,
          sessionId: record.event.sessionId,
          toolName: record.event.toolName,
        },
        kind: 'edit',
      })
    : canonicalize(
        record.seed === undefined
          ? { kind: 'reset' }
          : {
              kind: 'reset',
              seed: record.seed,
            },
      );

const parseStateRecord = ({ line, offset, value }: { line: number; offset: number; value: unknown }): RuntimeStateRecord => {
  const record = asRecord(value);
  const stateVersion = record?.stateVersion;
  if (
    record === undefined ||
    !isNonEmptyString(record.idempotencyKey) ||
    typeof stateVersion !== 'number' ||
    !Number.isInteger(stateVersion) ||
    stateVersion < 1
  ) {
    throw new RuntimeStateCorruptionError({ line, message: 'record shape is invalid', offset });
  }

  if (record.kind === 'edit') {
    if (!hasOnlyKeys(record, ['event', 'idempotencyKey', 'kind', 'stateVersion']) || !isEditEvent(record.event)) {
      throw new RuntimeStateCorruptionError({ line, message: 'edit record shape is invalid', offset });
    }
    return {
      event: record.event,
      idempotencyKey: record.idempotencyKey,
      kind: 'edit',
      stateVersion,
    };
  }

  if (record.kind === 'reset') {
    if (
      !hasOnlyKeys(record, record.seed === undefined ? ['idempotencyKey', 'kind', 'stateVersion'] : ['idempotencyKey', 'kind', 'seed', 'stateVersion']) ||
      (record.seed !== undefined && !isJsonValue(record.seed))
    ) {
      throw new RuntimeStateCorruptionError({ line, message: 'reset record shape is invalid', offset });
    }
    return record.seed === undefined
      ? { idempotencyKey: record.idempotencyKey, kind: 'reset', stateVersion }
      : { idempotencyKey: record.idempotencyKey, kind: 'reset', seed: record.seed, stateVersion };
  }

  throw new RuntimeStateCorruptionError({ line, message: 'record kind is invalid', offset });
};

const parseSnapshot = (contents: Buffer): ParsedState => {
  if (contents.byteLength > MAX_STATE_BYTES) {
    throw new RuntimeStateCorruptionError({ line: 1, message: `state file exceeds ${MAX_STATE_BYTES} byte limit`, offset: 0 });
  }

  let completeBytes = contents.byteLength;
  if (contents.byteLength > 0 && contents[contents.byteLength - 1] !== 0x0a) {
    const lastNewline = contents.lastIndexOf(0x0a);
    completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  }

  const records: RuntimeStateRecord[] = [];
  const idempotencyKeys = new Set<string>();
  let edits: EditEvent[] = [];
  let offset = 0;
  let line = 1;
  while (offset < completeBytes) {
    const newline = contents.indexOf(0x0a, offset);
    const end = newline < 0 ? completeBytes : newline;
    const source = contents.subarray(offset, end).toString('utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      throw new RuntimeStateCorruptionError({ line, message: 'record is not valid JSON', offset });
    }

    const record = parseStateRecord({ line, offset, value: raw });
    const expectedVersion = records.length + 1;
    if (record.stateVersion !== expectedVersion) {
      throw new RuntimeStateCorruptionError({
        line,
        message: `expected monotonic state version ${expectedVersion}, received ${record.stateVersion}`,
        offset,
      });
    }
    if (idempotencyKeys.has(record.idempotencyKey)) {
      throw new RuntimeStateCorruptionError({ line, message: `duplicate idempotency key ${record.idempotencyKey}`, offset });
    }
    idempotencyKeys.add(record.idempotencyKey);
    records.push(record);
    edits = record.kind === 'edit' ? [...edits, record.event] : [];
    offset = end + 1;
    line += 1;
  }

  return {
    completeBytes,
    records,
    snapshot: { edits, stateVersion: records.length },
  };
};

const validateLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new RangeError('limit must be an integer from 1 through 50');
  }
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Runtime state mutation was aborted');

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw abortError(signal);
  }
};

const waitForRetry = async ({ delayMs, signal }: { delayMs: number; signal: AbortSignal | undefined }): Promise<void> => {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError(signal!));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
};

const isAlreadyLocked = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED';

const lockMetadataFile = (stateFile: string): string => `${stateFile}.agent-runtime-lock.json`;

const readOwnerStaleMs = async (stateFile: string): Promise<number> => {
  try {
    const metadata: unknown = JSON.parse(await readFile(lockMetadataFile(stateFile), 'utf8'));
    const stale = asRecord(metadata)?.stale;
    return typeof stale === 'number' && Number.isInteger(stale) && stale >= TEST_LOCK_TIMING.stale
      ? stale
      : PRODUCTION_LOCK_TIMING.stale;
  } catch {
    return PRODUCTION_LOCK_TIMING.stale;
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const segment = relative(root, candidate);
  return segment === '' || (!segment.startsWith('..') && !isAbsolute(segment));
};

const assertNotSymbolic = async (path: string, kind: 'directory' | 'file'): Promise<void> => {
  const details = await lstat(path);
  if (details.isSymbolicLink() || (kind === 'directory' ? !details.isDirectory() : !details.isFile())) {
    throw new RuntimeStateLockError(`Workspace fallback state path contains an untrusted ${kind}: ${path}`);
  }
};

const resolveWorkspaceFallbackStateFile = async ({
  createParents,
  root,
  stateFile,
}: {
  createParents: boolean;
  root: string;
  stateFile: string;
}): Promise<string> => {
  const requestedRoot = resolve(root);
  const requestedFile = resolve(stateFile);
  const requestedExpected = join(requestedRoot, '.agent-runtime-demo', 'events.jsonl');
  if (requestedFile !== requestedExpected || !isWithin(requestedRoot, requestedFile)) {
    throw new RuntimeStateLockError('Workspace fallback state file escapes its trusted workspace root');
  }
  const canonicalRoot = await realpath(requestedRoot);
  const canonicalFile = join(canonicalRoot, '.agent-runtime-demo', 'events.jsonl');
  let current = canonicalRoot;
  for (const segment of ['.agent-runtime-demo']) {
    current = join(current, segment);
    try {
      await assertNotSymbolic(current, 'directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      if (!createParents) {
        return canonicalFile;
      }
      await mkdir(current);
      await assertNotSymbolic(current, 'directory');
    }
  }
  try {
    await assertNotSymbolic(canonicalFile, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return canonicalFile;
};

const syncParentDirectory = async ({
  adapter,
  directory,
}: {
  adapter: RuntimeStateTestAdapter | undefined;
  directory: string;
}): Promise<void> => {
  try {
    if (adapter?.syncParent !== undefined) {
      await adapter.syncParent(directory);
      return;
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!((adapter?.platform ?? process.platform) === 'win32' && (code === 'EPERM' || code === 'EINVAL'))) {
      throw error;
    }
  }
};

const ensureStateFile = async ({
  adapter,
  stateFile,
  workspaceFallbackRoot,
}: {
  adapter: RuntimeStateTestAdapter | undefined;
  stateFile: string;
  workspaceFallbackRoot: string | undefined;
}): Promise<string> => {
  const requestedStateFile =
    workspaceFallbackRoot === undefined
      ? stateFile
      : await resolveWorkspaceFallbackStateFile({ createParents: true, root: workspaceFallbackRoot, stateFile });
  if (workspaceFallbackRoot === undefined) {
    await mkdir(dirname(requestedStateFile), { recursive: true });
  }
  let created = false;
  try {
    await stat(requestedStateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    try {
      const handle = await open(requestedStateFile, 'wx');
      await handle.sync();
      await handle.close();
      created = true;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw createError;
      }
    }
  }

  if (created) {
    await syncParentDirectory({ adapter, directory: dirname(requestedStateFile) });
  }

  if (workspaceFallbackRoot !== undefined) {
    await assertNotSymbolic(requestedStateFile, 'file');
  }
  return realpath(requestedStateFile);
};

const readStateBytes = async ({
  adapter,
  stateFile,
}: {
  adapter: RuntimeStateTestAdapter | undefined;
  stateFile: string;
}): Promise<Buffer> => {
  await adapter?.beforeRead?.();
  try {
    const handle = await open(stateFile, 'r');
    try {
      const contents = Buffer.allocUnsafe(MAX_STATE_BYTES + 1);
      let offset = 0;
      while (offset < contents.byteLength) {
        const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      if (offset > MAX_STATE_BYTES) {
        throw new RuntimeStateCorruptionError({ line: 1, message: `state file exceeds ${MAX_STATE_BYTES} byte limit`, offset: 0 });
      }
      return contents.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Buffer.alloc(0);
    }
    throw error;
  }
};

const appendDurably = async (stateFile: string, contents: Buffer): Promise<void> => {
  const handle = await open(stateFile, 'a');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const repairIncompleteTail = async (stateFile: string, completeBytes: number): Promise<void> => {
  const handle = await open(stateFile, 'r+');
  try {
    await handle.truncate(completeBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createFileRuntimeKernelInternal = (
  options: FileRuntimeKernelOptions,
  adapter: RuntimeStateTestAdapter | undefined,
): RuntimeKernel => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const lockTiming = adapter?.lockTiming === undefined ? PRODUCTION_LOCK_TIMING : TEST_LOCK_TIMING;
  const criticalSectionMs = adapter?.criticalSectionMs ?? MAX_MUTATION_MS;
  let poisoned: RuntimeStateLockError | undefined;
  let cancelActivePhase: ((error: Error) => void) | undefined;

  const assertHealthy = ({ deadline, signal }: { deadline?: number; signal?: AbortSignal }): void => {
    throwIfAborted(signal);
    if (poisoned !== undefined) {
      throw poisoned;
    }
    if (deadline !== undefined && Date.now() > deadline) {
      throw new RuntimeStateLockError(`Runtime state mutation exceeded ${criticalSectionMs} ms critical-section limit`);
    }
  };

  const awaitPhase = async <T>({
    deadline,
    onLateValue,
    operation,
    signal,
    timeoutError,
  }: {
    deadline: number;
    onLateValue?: (value: T) => void | Promise<void>;
    operation: Promise<T>;
    signal: AbortSignal | undefined;
    timeoutError?: () => Error;
  }): Promise<T> => {
    assertHealthy({ deadline, signal });
    let settleCancellation!: (result: { readonly error: Error; readonly type: 'error' }) => void;
    const cancellation = new Promise<{ readonly error: Error; readonly type: 'error' }>((resolve) => {
      settleCancellation = resolve;
    });
    const phase = operation.then(
      (value) => ({ type: 'value' as const, value }),
      (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)), type: 'error' as const }),
    );
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeout = setTimeout(
      () =>
        settleCancellation({
          error: timeoutError?.() ?? new RuntimeStateLockError(`Runtime state mutation exceeded ${criticalSectionMs} ms critical-section limit`),
          type: 'error',
        }),
      remainingMs,
    );
    const abort = () => settleCancellation({ error: abortError(signal!), type: 'error' });
    signal?.addEventListener('abort', abort, { once: true });
    cancelActivePhase = (error) => settleCancellation({ error, type: 'error' });
    const result = await Promise.race([phase, cancellation]);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    cancelActivePhase = undefined;
    if (result.type === 'error') {
      void phase
        .then(async (late) => {
          if (late.type === 'value') {
            await onLateValue?.(late.value);
          }
        })
        .catch(() => undefined);
      throw result.error;
    }
    assertHealthy({ deadline, signal });
    return result.value;
  };

  const acquire = async ({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }) => {
    const deadline = Date.now() + timeoutMs;
    const canonicalStateFile = await awaitPhase({
      deadline,
      operation:
        adapter?.prepareStateFile?.({ stateFile: options.stateFile, workspaceFallbackRoot: options.workspaceFallbackRoot }) ??
        ensureStateFile({
          adapter,
          stateFile: options.stateFile,
          workspaceFallbackRoot: options.workspaceFallbackRoot,
        }),
      signal,
      timeoutError: () => new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`),
    });
    const acquireLock = adapter?.acquireLock ?? ((input) =>
      lockfile.lock(input.stateFile, {
        onCompromised: input.onCompromised,
        realpath: false,
        retries: 0,
        stale: input.stale,
        update: input.update,
      }));
    while (true) {
      assertHealthy({ deadline, signal });
      const effectiveStale = Math.max(
        lockTiming.stale,
        await awaitPhase({
          deadline,
          operation: readOwnerStaleMs(canonicalStateFile),
          signal,
          timeoutError: () => new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`),
        }),
      );
      try {
        const rawRelease = await awaitPhase({
          deadline,
          onLateValue: async (lateRelease) => {
            await lateRelease();
          },
          operation: acquireLock({
            onCompromised: (error) => {
              poisoned = new RuntimeStateLockError('Runtime state lease was compromised; this kernel is permanently poisoned', {
                cause: error,
              });
              cancelActivePhase?.(poisoned);
            },
            stale: effectiveStale,
            stateFile: canonicalStateFile,
            update: lockTiming.update,
          }),
          signal,
          timeoutError: () => new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`),
        });
        if (Date.now() >= deadline) {
          await rawRelease();
          throw new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`);
        }
        try {
          await awaitPhase({
            deadline,
            operation: writeFile(lockMetadataFile(canonicalStateFile), JSON.stringify({ stale: lockTiming.stale }), 'utf8'),
            signal,
            timeoutError: () => new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`),
          });
        } catch (error) {
          await rawRelease();
          throw error;
        }
        return {
          release: async () => {
            const errors: Error[] = [];
            try {
              await rm(lockMetadataFile(canonicalStateFile), { force: true });
            } catch (error) {
              errors.push(error instanceof Error ? error : new Error(String(error)));
            }
            try {
              await rawRelease();
            } catch (error) {
              errors.push(error instanceof Error ? error : new Error(String(error)));
            }
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(errors, 'Runtime state lease release failed');
            }
          },
          stateFile: canonicalStateFile,
        };
      } catch (error) {
        if (!isAlreadyLocked(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`, { cause: error });
        }
        await awaitPhase({
          deadline,
          operation: waitForRetry({ delayMs: Math.min(LOCK_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())), signal }),
          signal,
          timeoutError: () => new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`),
        });
      }
    }
  };

  const readSnapshot = async ({ limit }: { limit?: number } = {}): Promise<RuntimeSnapshot> => {
    validateLimit(limit);
    const stateFile =
      options.workspaceFallbackRoot === undefined
        ? options.stateFile
        : await resolveWorkspaceFallbackStateFile({
            createParents: false,
            root: options.workspaceFallbackRoot,
            stateFile: options.stateFile,
          });
    const parsed = parseSnapshot(await readStateBytes({ adapter, stateFile }));
    return {
      edits: limit === undefined ? parsed.snapshot.edits : parsed.snapshot.edits.slice(-limit),
      stateVersion: parsed.snapshot.stateVersion,
    };
  };

  const mutate = async (
    record: RuntimeStateRecord,
    mutationOptions: RuntimeMutationOptions | undefined,
  ): Promise<RuntimeSnapshot> => {
    if (!isNonEmptyString(record.idempotencyKey)) {
      throw new TypeError('Runtime state mutations require a nonempty idempotency key');
    }
    if (record.kind === 'edit' && !isEditEvent(record.event)) {
      throw new TypeError('Runtime state edits require every event field to be nonempty and valid');
    }
    if (record.kind === 'reset' && record.seed !== undefined && !isJsonValue(record.seed)) {
      throw new TypeError('Runtime state reset seed must be JSON-safe');
    }
    const timeoutMs = mutationOptions?.lockAcquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_ACQUIRE_TIMEOUT_MS) {
      throw new RangeError(`lockAcquireTimeoutMs must be an integer from 1 through ${DEFAULT_ACQUIRE_TIMEOUT_MS}`);
    }
    assertHealthy({ signal: mutationOptions?.signal });
    const lease = await acquire({ signal: mutationOptions?.signal, timeoutMs });
    const deadline = Date.now() + criticalSectionMs;
    let result: RuntimeSnapshot | undefined;
    let failure: unknown;
    try {
      result = await (async (): Promise<RuntimeSnapshot> => {
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        const bytes = await awaitPhase({
          deadline,
          operation: readStateBytes({ adapter, stateFile: lease.stateFile }),
          signal: mutationOptions?.signal,
        });
        const parsed = parseSnapshot(bytes);
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        const sameKey = parsed.records.find((current) => current.idempotencyKey === record.idempotencyKey);
        if (sameKey !== undefined) {
          if (canonicalRecordInput(sameKey) !== canonicalRecordInput(record)) {
            throw new RuntimeStateLockError(`Runtime state idempotency key ${record.idempotencyKey} was reused with conflicting input`);
          }
          return parsed.snapshot;
        }

        if (parsed.completeBytes !== bytes.byteLength) {
          await awaitPhase({
            deadline,
            operation: repairIncompleteTail(lease.stateFile, parsed.completeBytes),
            signal: mutationOptions?.signal,
          });
        }
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        await awaitPhase({ deadline, operation: adapter?.beforeAppend?.() ?? Promise.resolve(), signal: mutationOptions?.signal });
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        const nextRecord: RuntimeStateRecord =
          record.kind === 'edit'
            ? {
                ...record,
                event: record.event,
                stateVersion: parsed.snapshot.stateVersion + 1,
              }
            : record.seed === undefined
              ? { ...record, stateVersion: parsed.snapshot.stateVersion + 1 }
              : { ...record, seed: record.seed, stateVersion: parsed.snapshot.stateVersion + 1 };
        const serialized = Buffer.from(`${JSON.stringify(nextRecord)}\n`, 'utf8');
        if (parsed.completeBytes + serialized.byteLength > MAX_STATE_BYTES) {
          throw new RuntimeStateLockError(`Runtime state file cannot exceed ${MAX_STATE_BYTES} bytes`);
        }
        await awaitPhase({ deadline, operation: appendDurably(lease.stateFile, serialized), signal: mutationOptions?.signal });
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        const edits = nextRecord.kind === 'edit' ? [...parsed.snapshot.edits, nextRecord.event] : [];
        return { edits, stateVersion: nextRecord.stateVersion };
      })();
    } catch (error) {
      failure = error;
    }
    try {
      await lease.release();
    } catch (releaseError) {
      const normalized = releaseError instanceof Error ? releaseError : new Error(String(releaseError));
      failure = failure === undefined ? normalized : new AggregateError([failure, normalized], 'Runtime state mutation and lease release failed');
    }
    if (failure !== undefined) {
      throw failure;
    }
    return result!;
  };

  return {
    async recordEdit(input, mutationOptions) {
      return mutate(
        {
          event: {
            eventId: createId(),
            host: input.host,
            path: input.path,
            recordedAt: now().toISOString(),
            sessionId: input.sessionId,
            toolName: input.toolName,
          },
          idempotencyKey: input.idempotencyKey,
          kind: 'edit',
          stateVersion: 0,
        },
        mutationOptions,
      );
    },
    async resetState(input, mutationOptions) {
      return mutate(
        input.seed === undefined
          ? { idempotencyKey: input.idempotencyKey, kind: 'reset', stateVersion: 0 }
          : { idempotencyKey: input.idempotencyKey, kind: 'reset', seed: input.seed, stateVersion: 0 },
        mutationOptions,
      );
    },
    readSnapshot,
  };
};

export const createFileRuntimeKernel = (options: FileRuntimeKernelOptions): RuntimeKernel =>
  createFileRuntimeKernelInternal(options, undefined);

/** Imported solely by state-file-test-support.ts; never from a runtime entry. */
export const createFileRuntimeKernelForTesting = (
  options: FileRuntimeKernelOptions,
  adapter: RuntimeStateTestAdapter | undefined,
): RuntimeKernel => createFileRuntimeKernelInternal(options, adapter);
