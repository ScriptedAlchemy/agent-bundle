import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { AgentStateError, type AgentStateChange, type AgentStateStore } from '@agent-bundle/runtime/state';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import type {
  EditEvent,
  RuntimeKernel,
  RuntimeMutationOptions,
  RuntimeSnapshot,
  RuntimeSnapshotReadOptions,
} from './contracts.js';
import {
  editTimelineDefinition,
  type EditTimelineEvents,
  type EditTimelineState,
} from './state-definition.js';

/**
 * The example's durable state now lives on the framework state kernel's
 * workspace-durable `node:sqlite` driver (#98, G3): the state file is one
 * SQLite database per workspace instead of the retired append-only JSONL
 * log. Loading this module emits Node's one-time ExperimentalWarning for
 * `node:sqlite` (see the README's production notes).
 *
 * This adapter keeps the example's provider-facing `RuntimeKernel` contract
 * — `stateVersion`, bounded `limit` views, exact-version reads, and the
 * six-field `EditEvent` wire shape — while the kernel owns locking,
 * transactions, idempotency, and corruption behavior. The two presentation
 * fields the retired kernel generated are now derived deterministically at
 * read time: `eventId` is `edit-<revision>` and `recordedAt` is the
 * journal's commit timestamp from the change cursor.
 */

export { AgentStateError };

const MUTATION_WAIT_LIMIT_MS = 30_000;

export interface FileRuntimeKernelOptions {
  stateFile: string;
  now?: () => Date;
}

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

const validateMutationWait = (waitMs: number | undefined): void => {
  if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > MUTATION_WAIT_LIMIT_MS)) {
    throw new RangeError(`lockAcquireTimeoutMs must be an integer from 1 through ${MUTATION_WAIT_LIMIT_MS}`);
  }
};

type TimelineStore = AgentStateStore<EditTimelineState, EditTimelineEvents>;

/**
 * Joins the reduced state with the journal's change cursor to rebuild the
 * provider-facing `EditEvent` decoration. Edits in the state correspond
 * one-to-one, in order, to the `event` changes committed after the latest
 * reset, so the join is deterministic for any exact revision.
 */
const decoratedSnapshot = (
  state: EditTimelineState,
  revision: number,
  changes: readonly AgentStateChange[],
  limit: number | undefined,
): RuntimeSnapshot => {
  const upTo = changes.filter((change) => change.revision <= revision);
  const lastBaseline = [...upTo].reverse().find((change) => change.kind !== 'event');
  const eventChanges = upTo.filter(
    (change): change is Extract<AgentStateChange, { kind: 'event' }> =>
      change.kind === 'event' && (lastBaseline === undefined || change.revision > lastBaseline.revision),
  );
  if (eventChanges.length !== state.edits.length) {
    throw new AgentStateError(
      'corrupt',
      `Runtime state at version ${String(revision)} has ${String(state.edits.length)} edits but ${String(eventChanges.length)} committed edit events`,
    );
  }
  const edits: EditEvent[] = state.edits.map((edit, index) => {
    const change = eventChanges[index]!;
    return {
      eventId: `edit-${String(change.revision)}`,
      host: edit.host,
      path: edit.path,
      recordedAt: change.committedAt,
      sessionId: edit.sessionId,
      toolName: edit.toolName,
    };
  });
  const visibleEdits = limit === undefined ? edits : edits.slice(-limit);
  return state.seed === undefined
    ? { edits: visibleEdits, stateVersion: revision }
    : { edits: visibleEdits, seed: state.seed, stateVersion: revision };
};

export const createFileRuntimeKernel = (options: FileRuntimeKernelOptions): RuntimeKernel => {
  const now = options.now ?? ((): Date => new Date());

  /**
   * Every operation opens the store, runs, and closes: hook and MCP
   * processes are short-lived, and deterministic close keeps file handles
   * and WAL checkpoints tidy without a daemon.
   */
  const withStore = async <T>(
    waitMs: number | undefined,
    operation: (store: TimelineStore) => Promise<T>,
  ): Promise<T> => {
    const driver = createSqliteStateDriver({
      busyTimeoutMs: waitMs ?? MUTATION_WAIT_LIMIT_MS,
      file: options.stateFile,
      now,
    });
    try {
      return await operation(await driver.open(editTimelineDefinition));
    } finally {
      await driver.close();
    }
  };

  const snapshotAt = async (
    store: TimelineStore,
    revision: number | undefined,
    limit: number | undefined,
    signal?: AbortSignal,
  ): Promise<RuntimeSnapshot> => {
    let exact: { readonly revision: number; readonly state: EditTimelineState };
    try {
      exact = revision === undefined ? await store.read({ signal }) : await store.read({ revision, signal });
    } catch (error) {
      if (error instanceof AgentStateError && error.code === 'revision-unavailable') {
        throw new RangeError(`state version ${String(revision)} is unavailable`, { cause: error });
      }
      throw error;
    }
    const batch = await store.changes({ afterRevision: 0, signal });
    return decoratedSnapshot(exact.state, exact.revision, batch.changes, limit);
  };

  return {
    async recordEdit(input, mutationOptions?: RuntimeMutationOptions): Promise<RuntimeSnapshot> {
      validateMutationWait(mutationOptions?.lockAcquireTimeoutMs);
      return withStore(mutationOptions?.lockAcquireTimeoutMs, async (store) => {
        const committed = await store.dispatch(
          'editRecorded',
          { host: input.host, path: input.path, sessionId: input.sessionId, toolName: input.toolName },
          { idempotencyKey: input.idempotencyKey, signal: mutationOptions?.signal },
        );
        // Idempotent replays return the current head, exactly like the retired
        // JSONL kernel: a rerun after a later reset must surface the reset
        // state, not the durable prefix at the original commit.
        return snapshotAt(store, committed.replayed ? undefined : committed.revision, undefined, mutationOptions?.signal);
      });
    },

    async resetState(input, mutationOptions?: RuntimeMutationOptions): Promise<RuntimeSnapshot> {
      validateMutationWait(mutationOptions?.lockAcquireTimeoutMs);
      return withStore(mutationOptions?.lockAcquireTimeoutMs, async (store) => {
        const committed = await store.reset({
          idempotencyKey: input.idempotencyKey,
          ...(input.seed === undefined ? {} : { seed: { edits: [], seed: input.seed } }),
          signal: mutationOptions?.signal,
        });
        return snapshotAt(store, committed.replayed ? undefined : committed.revision, undefined, mutationOptions?.signal);
      });
    },

    async readSnapshot(readOptions: RuntimeSnapshotReadOptions = {}): Promise<RuntimeSnapshot> {
      validateLimit(readOptions.limit);
      validateStateVersion(readOptions.stateVersion);
      return withStore(undefined, async (store) => snapshotAt(store, readOptions.stateVersion, readOptions.limit));
    },
  };
};

const stateHome = (): string => {
  const configured = process.env.XDG_STATE_HOME;
  return configured !== undefined && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.local', 'state');
};

/** Resolves implicit host state outside the repository from one canonical workspace identity. */
export const resolveImplicitRuntimeStateFile = async (workspaceRoot: string): Promise<string> => {
  const canonicalWorkspace = await realpath(resolve(workspaceRoot));
  const workspaceId = createHash('sha256').update(canonicalWorkspace).digest('hex');
  return join(stateHome(), 'agent-bundle', 'rsc-agent-runtime', workspaceId, 'state.sqlite');
};
