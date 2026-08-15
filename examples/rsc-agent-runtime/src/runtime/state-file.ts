import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  /** Only permits the documented short timing used by deterministic lock tests. */
  testOnlyLockTiming?: Readonly<{ staleMs: 2_000; updateMs: 1_000 }>;
  /** Test seam for proving that a compromised owner cannot append after losing its lease. */
  testOnlyBeforeAppend?: () => Promise<void>;
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

const waitForRetry = async (signal: AbortSignal | undefined): Promise<void> => {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, LOCK_RETRY_DELAY_MS);
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

const ensureStateFile = async (stateFile: string): Promise<string> => {
  await mkdir(dirname(stateFile), { recursive: true });
  let created = false;
  try {
    await stat(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    try {
      const handle = await open(stateFile, 'wx');
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
    const parent = await open(dirname(stateFile), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  return realpath(stateFile);
};

const readStateBytes = async (stateFile: string): Promise<Buffer> => {
  try {
    return await readFile(stateFile);
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

export const createFileRuntimeKernel = (options: FileRuntimeKernelOptions): RuntimeKernel => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const lockTiming = options.testOnlyLockTiming === undefined ? PRODUCTION_LOCK_TIMING : TEST_LOCK_TIMING;
  let poisoned: RuntimeStateLockError | undefined;

  const assertHealthy = ({ deadline, signal }: { deadline?: number; signal?: AbortSignal }): void => {
    throwIfAborted(signal);
    if (poisoned !== undefined) {
      throw poisoned;
    }
    if (deadline !== undefined && Date.now() > deadline) {
      throw new RuntimeStateLockError(`Runtime state mutation exceeded ${MAX_MUTATION_MS} ms critical-section limit`);
    }
  };

  const acquire = async ({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }) => {
    const canonicalStateFile = await ensureStateFile(options.stateFile);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      assertHealthy({ signal });
      try {
        return { release: await lockfile.lock(canonicalStateFile, {
          onCompromised: (error) => {
            poisoned = new RuntimeStateLockError('Runtime state lease was compromised; this kernel is permanently poisoned', {
              cause: error,
            });
          },
          realpath: false,
          retries: 0,
          stale: lockTiming.stale,
          update: lockTiming.update,
        }), stateFile: canonicalStateFile };
      } catch (error) {
        if (!isAlreadyLocked(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`, { cause: error });
        }
        await waitForRetry(signal);
      }
    }
  };

  const readSnapshot = async ({ limit }: { limit?: number } = {}): Promise<RuntimeSnapshot> => {
    validateLimit(limit);
    const parsed = parseSnapshot(await readStateBytes(options.stateFile));
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
    if (record.kind === 'reset' && record.seed !== undefined && !isJsonValue(record.seed)) {
      throw new TypeError('Runtime state reset seed must be JSON-safe');
    }
    const timeoutMs = mutationOptions?.lockAcquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_ACQUIRE_TIMEOUT_MS) {
      throw new RangeError(`lockAcquireTimeoutMs must be an integer from 1 through ${DEFAULT_ACQUIRE_TIMEOUT_MS}`);
    }
    assertHealthy({ signal: mutationOptions?.signal });
    const lease = await acquire({ signal: mutationOptions?.signal, timeoutMs });
    const deadline = Date.now() + MAX_MUTATION_MS;
    let result: RuntimeSnapshot | undefined;
    let failure: unknown;
    try {
      result = await (async (): Promise<RuntimeSnapshot> => {
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        const bytes = await readStateBytes(lease.stateFile);
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
          await repairIncompleteTail(lease.stateFile, parsed.completeBytes);
        }
        assertHealthy({ deadline, signal: mutationOptions?.signal });
        await options.testOnlyBeforeAppend?.();
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
        await appendDurably(lease.stateFile, serialized);
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
      if (failure === undefined && poisoned === undefined) {
        failure = releaseError;
      }
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
