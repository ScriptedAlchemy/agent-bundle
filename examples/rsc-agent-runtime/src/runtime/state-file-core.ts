import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import type {
  EditEvent,
  JsonValue,
  RuntimeKernel,
  RuntimeMutationOptions,
  RuntimeSnapshot,
  RuntimeSnapshotReadOptions,
  RuntimeStateRecord,
} from './contracts.js';

export const MAX_STATE_BYTES = 16 * 1024 * 1024;

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

export interface StateKernelPolicy {
  readonly acquireLimitMs: number;
  readonly mutationMs: number;
  readonly ownerSettlementMs: number;
  readonly releaseMs: number;
  readonly retryDelayMs: number;
  readonly staleMs: number;
  readonly updateMs: number;
  readonly terminateOwner: (error: RuntimeStateLockError) => void;
}

export type StateLeaseRelease = () => Promise<void>;

export interface StateStorage {
  readonly acquire: (input: Readonly<{
    onCompromised: (error: Error) => void;
    stale: number;
    stateFile: string;
    update: number;
  }>) => Promise<StateLeaseRelease>;
  readonly append: (stateFile: string, contents: Buffer, signal: AbortSignal) => Promise<void>;
  readonly prepare: (stateFile: string, signal: AbortSignal) => Promise<string>;
  readonly read: (stateFile: string, signal: AbortSignal) => Promise<Buffer>;
  readonly readOwnerStaleMs: (stateFile: string, signal: AbortSignal) => Promise<number>;
  readonly removeOwner: (stateFile: string, signal: AbortSignal) => Promise<void>;
  readonly repair: (stateFile: string, completeBytes: number, signal: AbortSignal) => Promise<void>;
  readonly writeOwner: (stateFile: string, staleMs: number, signal: AbortSignal) => Promise<void>;
}

export interface StateKernelInput {
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly policy: StateKernelPolicy;
  readonly stateFile: string;
  readonly storage: StateStorage;
}

interface ParsedState {
  readonly completeBytes: number;
  readonly records: readonly RuntimeStateRecord[];
  readonly snapshot: RuntimeSnapshot;
}

interface OperationOwner {
  readonly controller: AbortController;
  unsafeToRelease: boolean;
}

type Settled<T> =
  | Readonly<{ type: 'error'; error: Error }>
  | Readonly<{ type: 'value'; value: T }>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
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
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
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
    : canonicalize(record.seed === undefined ? { kind: 'reset' } : { kind: 'reset', seed: record.seed });

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
    return { event: record.event, idempotencyKey: record.idempotencyKey, kind: 'edit', stateVersion };
  }
  if (record.kind === 'reset') {
    if (
      !hasOnlyKeys(record, record.seed === undefined
        ? ['idempotencyKey', 'kind', 'stateVersion']
        : ['idempotencyKey', 'kind', 'seed', 'stateVersion']) ||
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

const snapshotForRecords = (records: readonly RuntimeStateRecord[], limit?: number): RuntimeSnapshot => {
  let edits: EditEvent[] = [];
  let seed: JsonValue | undefined;
  for (const record of records) {
    if (record.kind === 'edit') {
      edits = [...edits, record.event];
    } else {
      edits = [];
      seed = record.seed;
    }
  }
  const visibleEdits = limit === undefined ? edits : edits.slice(-limit);
  return seed === undefined
    ? { edits: visibleEdits, stateVersion: records.length }
    : { edits: visibleEdits, seed, stateVersion: records.length };
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
  let offset = 0;
  let line = 1;
  while (offset < completeBytes) {
    const newline = contents.indexOf(0x0a, offset);
    const end = newline < 0 ? completeBytes : newline;
    let raw: unknown;
    try {
      raw = JSON.parse(contents.subarray(offset, end).toString('utf8'));
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
    offset = end + 1;
    line += 1;
  }
  return { completeBytes, records, snapshot: snapshotForRecords(records) };
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Runtime state mutation was aborted');

const settled = <T>(operation: Promise<T>): Promise<Settled<T>> =>
  operation.then(
    (value) => ({ type: 'value', value }),
    (error: unknown) => ({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
  );

const cancellation = (signal: AbortSignal): Promise<Readonly<{ type: 'cancelled'; error: Error }>> =>
  signal.aborted
    ? Promise.resolve({ type: 'cancelled', error: abortError(signal) })
    : new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ type: 'cancelled', error: abortError(signal) }), { once: true });
      });

const isAlreadyLocked = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED';

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const validateLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new RangeError('limit must be an integer from 1 through 50');
  }
};

const validateStateVersion = (stateVersion: number | undefined): void => {
  if (stateVersion !== undefined && (!Number.isSafeInteger(stateVersion) || stateVersion < 0)) {
    throw new RangeError('stateVersion must be a nonnegative safe integer');
  }
};

export const createRuntimeStateKernel = ({
  createId = randomUUID,
  now = () => new Date(),
  policy,
  stateFile,
  storage,
}: StateKernelInput): RuntimeKernel => {
  let poisoned: RuntimeStateLockError | undefined;
  const owners = new Set<OperationOwner>();

  const poison = (error: RuntimeStateLockError, fatal: boolean): RuntimeStateLockError => {
    poisoned ??= error;
    for (const owner of owners) owner.controller.abort(poisoned);
    if (fatal) {
      try {
        policy.terminateOwner(poisoned);
      } catch {
        // The permanent poisoned state remains authoritative if teardown itself throws.
      }
    }
    return poisoned;
  };

  const assertHealthy = (signal?: AbortSignal): void => {
    if (signal?.aborted === true) throw abortError(signal);
    if (poisoned !== undefined) throw poisoned;
  };

  const createOwner = (signal: AbortSignal | undefined): OperationOwner => {
    assertHealthy(signal);
    const owner: OperationOwner = { controller: new AbortController(), unsafeToRelease: false };
    if (signal !== undefined) {
      if (signal.aborted) owner.controller.abort(abortError(signal));
      else signal.addEventListener('abort', () => owner.controller.abort(abortError(signal)), { once: true });
    }
    owners.add(owner);
    return owner;
  };

  const armDeadline = (owner: OperationOwner, deadline: number, error: Error): ReturnType<typeof setTimeout> =>
    setTimeout(() => owner.controller.abort(error), Math.max(0, deadline - Date.now()));

  const releaseRaw = async (owner: OperationOwner, rawRelease: StateLeaseRelease, label: string): Promise<void> => {
    const operation = settled(rawRelease());
    const timeoutError = new RuntimeStateLockError(`${label} exceeded ${policy.releaseMs} ms`);
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Readonly<{ type: 'timeout'; error: RuntimeStateLockError }>>((resolve) => {
      releaseTimer = setTimeout(() => resolve({ type: 'timeout', error: timeoutError }), policy.releaseMs);
    });
    const outcome = await Promise.race([operation, timeout]);
    clearTimeout(releaseTimer);
    if (outcome.type === 'timeout') {
      owner.unsafeToRelease = true;
      throw poison(
        new RuntimeStateLockError(`${outcome.error.message}; this kernel is permanently poisoned`, { cause: outcome.error }),
        true,
      );
    }
    if (outcome.type === 'error') {
      owner.unsafeToRelease = true;
      throw poison(
        new RuntimeStateLockError(`${label} failed; this kernel is permanently poisoned`, { cause: outcome.error }),
        true,
      );
    }
  };

  const awaitUnowned = async <T>(
    owner: OperationOwner,
    deadline: number,
    operation: Promise<T>,
    timeoutError: RuntimeStateLockError,
  ): Promise<T> => {
    const timer = armDeadline(owner, deadline, timeoutError);
    const outcome = await Promise.race([settled(operation), cancellation(owner.controller.signal)]);
    clearTimeout(timer);
    if (outcome.type === 'cancelled') throw outcome.error;
    if (outcome.type === 'error') throw outcome.error;
    if (Date.now() >= deadline) {
      owner.controller.abort(timeoutError);
      throw timeoutError;
    }
    return outcome.value;
  };

  const awaitAcquisition = async (
    owner: OperationOwner,
    deadline: number,
    operation: Promise<StateLeaseRelease>,
    timeoutError: RuntimeStateLockError,
  ): Promise<StateLeaseRelease> => {
    const phase = settled(operation);
    const timer = armDeadline(owner, deadline, timeoutError);
    const outcome = await Promise.race([phase, cancellation(owner.controller.signal)]);
    clearTimeout(timer);
    if (outcome.type === 'cancelled') {
      void phase.then(async (late) => {
        if (late.type === 'value') await releaseRaw(owner, late.value, 'Late runtime state lease release');
      }).catch(() => undefined);
      throw outcome.error;
    }
    if (outcome.type === 'error') throw outcome.error;
    if (Date.now() >= deadline || owner.controller.signal.aborted || poisoned !== undefined) {
      const reason = poisoned ?? (owner.controller.signal.aborted ? abortError(owner.controller.signal) : timeoutError);
      await releaseRaw(owner, outcome.value, 'Late runtime state lease release');
      throw reason;
    }
    return outcome.value;
  };

  const awaitOwned = async <T>(
    owner: OperationOwner,
    deadline: number,
    operation: Promise<T>,
    timeoutError: RuntimeStateLockError,
  ): Promise<T> => {
    const phase = settled(operation);
    const timer = armDeadline(owner, deadline, timeoutError);
    const outcome = await Promise.race([phase, cancellation(owner.controller.signal)]);
    clearTimeout(timer);
    if (outcome.type === 'error') throw outcome.error;
    if (outcome.type === 'value') {
      if (poisoned !== undefined) {
        owner.unsafeToRelease = true;
        throw poisoned;
      }
      if (owner.controller.signal.aborted) {
        throw abortError(owner.controller.signal);
      }
      if (Date.now() >= deadline) {
        owner.controller.abort(timeoutError);
        throw timeoutError;
      }
      return outcome.value;
    }

    if (poisoned !== undefined) {
      owner.unsafeToRelease = true;
      throw poisoned;
    }
    const settlementTimeout = new RuntimeStateLockError(
      `Runtime state phase did not settle within ${policy.ownerSettlementMs} ms after cancellation`,
    );
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const settlement = await Promise.race([
      phase,
      new Promise<Readonly<{ type: 'settlement-timeout'; error: RuntimeStateLockError }>>((resolve) => {
        settlementTimer = setTimeout(
          () => resolve({ type: 'settlement-timeout', error: settlementTimeout }),
          policy.ownerSettlementMs,
        );
      }),
    ]);
    clearTimeout(settlementTimer);
    if (settlement.type === 'settlement-timeout') {
      owner.unsafeToRelease = true;
      throw poison(
        new RuntimeStateLockError(`${settlement.error.message}; this kernel is permanently poisoned`, { cause: outcome.error }),
        true,
      );
    }
    throw outcome.error;
  };

  const releaseLease = async (owner: OperationOwner, canonicalStateFile: string, rawRelease: StateLeaseRelease): Promise<void> => {
    let metadataFailure: Error | undefined;
    try {
      const removal = settled(storage.removeOwner(canonicalStateFile, owner.controller.signal));
      let removalTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Readonly<{ type: 'timeout' }>>((resolve) => {
        removalTimer = setTimeout(() => resolve({ type: 'timeout' }), policy.releaseMs);
      });
      const outcome = await Promise.race([removal, timeout]);
      clearTimeout(removalTimer);
      if (outcome.type === 'timeout') {
        owner.unsafeToRelease = true;
        throw poison(
          new RuntimeStateLockError(`Runtime state lease release exceeded ${policy.releaseMs} ms; this kernel is permanently poisoned`),
          true,
        );
      }
      if (outcome.type === 'error') metadataFailure = outcome.error;
    } catch (error) {
      if (owner.unsafeToRelease) throw error;
      metadataFailure = error instanceof Error ? error : new Error(String(error));
    }

    try {
      await releaseRaw(owner, rawRelease, 'Runtime state lease release');
    } catch (releaseError) {
      if (metadataFailure === undefined) throw releaseError;
      throw new AggregateError(
        [metadataFailure, releaseError],
        'Runtime state lease release failed',
        { cause: releaseError },
      );
    }
    if (metadataFailure !== undefined) throw metadataFailure;
  };

  const acquireLease = async (signal: AbortSignal | undefined, timeoutMs: number) => {
    const owner = createOwner(signal);
    const deadline = Date.now() + timeoutMs;
    const timeoutError = new RuntimeStateLockError(`Timed out acquiring runtime state lease after ${timeoutMs} ms`);
    let rawRelease: StateLeaseRelease | undefined;
    try {
      const canonicalStateFile = await awaitUnowned(owner, deadline, storage.prepare(stateFile, owner.controller.signal), timeoutError);
      while (true) {
        assertHealthy(owner.controller.signal);
        const ownerStale = await awaitUnowned(
          owner,
          deadline,
          storage.readOwnerStaleMs(canonicalStateFile, owner.controller.signal),
          timeoutError,
        );
        try {
          rawRelease = await awaitAcquisition(
            owner,
            deadline,
            storage.acquire({
              onCompromised: (error) => {
                owner.unsafeToRelease = true;
                const compromise = new RuntimeStateLockError(
                  'Runtime state lease was compromised; this kernel is permanently poisoned',
                  { cause: error },
                );
                owner.controller.abort(compromise);
                poison(compromise, true);
              },
              stale: Math.max(policy.staleMs, ownerStale),
              stateFile: canonicalStateFile,
              update: policy.updateMs,
            }),
            timeoutError,
          );
          await awaitOwned(
            owner,
            deadline,
            storage.writeOwner(canonicalStateFile, policy.staleMs, owner.controller.signal),
            timeoutError,
          );
          return { canonicalStateFile, owner, rawRelease };
        } catch (error) {
          if (rawRelease !== undefined && !owner.unsafeToRelease) {
            await releaseRaw(owner, rawRelease, 'Runtime state lease release');
            rawRelease = undefined;
          }
          if (!isAlreadyLocked(error)) throw error;
          rawRelease = undefined;
          await awaitUnowned(
            owner,
            deadline,
            delay(Math.min(policy.retryDelayMs, Math.max(0, deadline - Date.now())), owner.controller.signal),
            timeoutError,
          );
        }
      }
    } catch (error) {
      owners.delete(owner);
      throw error;
    }
  };

  const readSnapshot = async ({ limit, stateVersion }: RuntimeSnapshotReadOptions = {}): Promise<RuntimeSnapshot> => {
    validateLimit(limit);
    validateStateVersion(stateVersion);
    assertHealthy();
    const controller = new AbortController();
    const parsed = parseSnapshot(await storage.read(stateFile, controller.signal));
    if (stateVersion !== undefined) {
      if (stateVersion > parsed.records.length) throw new RangeError(`state version ${stateVersion} is unavailable`);
      return snapshotForRecords(parsed.records.slice(0, stateVersion), limit);
    }
    return snapshotForRecords(parsed.records, limit);
  };

  const mutate = async (record: RuntimeStateRecord, options: RuntimeMutationOptions | undefined): Promise<RuntimeSnapshot> => {
    if (!isNonEmptyString(record.idempotencyKey)) {
      throw new TypeError('Runtime state mutations require a nonempty idempotency key');
    }
    if (record.kind === 'edit' && !isEditEvent(record.event)) {
      throw new TypeError('Runtime state edits require every event field to be nonempty and valid');
    }
    if (record.kind === 'reset' && record.seed !== undefined && !isJsonValue(record.seed)) {
      throw new TypeError('Runtime state reset seed must be JSON-safe');
    }
    const timeoutMs = options?.lockAcquireTimeoutMs ?? policy.acquireLimitMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > policy.acquireLimitMs) {
      throw new RangeError(`lockAcquireTimeoutMs must be an integer from 1 through ${policy.acquireLimitMs}`);
    }
    assertHealthy(options?.signal);
    const lease = await acquireLease(options?.signal, timeoutMs);
    const deadline = Date.now() + policy.mutationMs;
    const timeoutError = new RuntimeStateLockError(
      `Runtime state mutation exceeded ${policy.mutationMs} ms critical-section limit`,
    );
    let result: RuntimeSnapshot | undefined;
    let failure: unknown;
    try {
      const bytes = await awaitOwned(
        lease.owner,
        deadline,
        storage.read(lease.canonicalStateFile, lease.owner.controller.signal),
        timeoutError,
      );
      const parsed = parseSnapshot(bytes);
      const sameKey = parsed.records.find((current) => current.idempotencyKey === record.idempotencyKey);
      if (sameKey !== undefined) {
        if (canonicalRecordInput(sameKey) !== canonicalRecordInput(record)) {
          throw new RuntimeStateLockError(`Runtime state idempotency key ${record.idempotencyKey} was reused with conflicting input`);
        }
        result = parsed.snapshot;
      } else {
        if (parsed.completeBytes !== bytes.byteLength) {
          await awaitOwned(
            lease.owner,
            deadline,
            storage.repair(lease.canonicalStateFile, parsed.completeBytes, lease.owner.controller.signal),
            timeoutError,
          );
        }
        const nextRecord: RuntimeStateRecord = record.kind === 'edit'
          ? { ...record, event: record.event, stateVersion: parsed.snapshot.stateVersion + 1 }
          : record.seed === undefined
            ? { ...record, stateVersion: parsed.snapshot.stateVersion + 1 }
            : { ...record, seed: record.seed, stateVersion: parsed.snapshot.stateVersion + 1 };
        const serialized = Buffer.from(`${JSON.stringify(nextRecord)}\n`, 'utf8');
        if (parsed.completeBytes + serialized.byteLength > MAX_STATE_BYTES) {
          throw new RuntimeStateLockError(`Runtime state file cannot exceed ${MAX_STATE_BYTES} bytes`);
        }
        await awaitOwned(
          lease.owner,
          deadline,
          storage.append(lease.canonicalStateFile, serialized, lease.owner.controller.signal),
          timeoutError,
        );
        result = snapshotForRecords([...parsed.records, nextRecord]);
      }
    } catch (error) {
      failure = error;
    }

    if (!lease.owner.unsafeToRelease) {
      try {
        await releaseLease(lease.owner, lease.canonicalStateFile, lease.rawRelease);
      } catch (error) {
        failure = failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              'Runtime state mutation and lease release failed',
              { cause: error },
            );
      }
    }
    owners.delete(lease.owner);
    if (failure !== undefined) throw failure;
    return result!;
  };

  return {
    recordEdit(input, options) {
      return mutate({
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
      }, options);
    },
    resetState(input, options) {
      return mutate(
        input.seed === undefined
          ? { idempotencyKey: input.idempotencyKey, kind: 'reset', stateVersion: 0 }
          : { idempotencyKey: input.idempotencyKey, kind: 'reset', seed: input.seed, stateVersion: 0 },
        options,
      );
    },
    readSnapshot,
  };
};

const metadataFile = (stateFile: string): string => `${stateFile}.agent-runtime-lock.json`;

export const createNodeStateStorage = ({
  platform = process.platform,
  syncParent,
}: Readonly<{
  platform?: NodeJS.Platform;
  syncParent?: (directory: string) => Promise<void>;
}> = {}): StateStorage => ({
  acquire: (input) => lockfile.lock(input.stateFile, {
    onCompromised: input.onCompromised,
    realpath: false,
    retries: 0,
    stale: input.stale,
    update: input.update,
  }),
  async append(stateFile, contents, signal) {
    if (signal.aborted) throw abortError(signal);
    const handle = await open(stateFile, 'a');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async prepare(stateFile) {
    await mkdir(dirname(stateFile), { recursive: true });
    let created = false;
    try {
      await stat(stateFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const handle = await open(stateFile, 'wx');
        await handle.sync();
        await handle.close();
        created = true;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      }
    }
    if (created) {
      try {
        if (syncParent !== undefined) await syncParent(dirname(stateFile));
        else {
          const parent = await open(dirname(stateFile), 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!(platform === 'win32' && (code === 'EPERM' || code === 'EINVAL'))) throw error;
      }
    }
    const canonical = await realpath(stateFile);
    const details = await lstat(canonical);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new RuntimeStateLockError(`Runtime state path is not a regular file: ${stateFile}`);
    }
    return canonical;
  },
  async read(stateFile) {
    try {
      const handle = await open(stateFile, 'r');
      try {
        const contents = Buffer.allocUnsafe(MAX_STATE_BYTES + 1);
        let offset = 0;
        while (offset < contents.byteLength) {
          const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
          if (bytesRead === 0) break;
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
  },
  async readOwnerStaleMs(stateFile) {
    try {
      const metadata: unknown = JSON.parse(await readFile(metadataFile(stateFile), 'utf8'));
      const stale = asRecord(metadata)?.stale;
      return typeof stale === 'number' && Number.isInteger(stale) && stale > 0 ? stale : 0;
    } catch {
      return 0;
    }
  },
  removeOwner: (stateFile) => rm(metadataFile(stateFile), { force: true }),
  async repair(stateFile, completeBytes) {
    const handle = await open(stateFile, 'r+');
    try {
      await handle.truncate(completeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  writeOwner: (stateFile, staleMs, signal) =>
    writeFile(metadataFile(stateFile), JSON.stringify({ stale: staleMs }), { encoding: 'utf8', signal }),
});
