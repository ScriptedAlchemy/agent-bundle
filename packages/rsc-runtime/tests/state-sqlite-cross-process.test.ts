import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import { defineState, type AgentStateDefinition } from '../src/state/index.js';
import { createSqliteStateDriver } from '../src/state/sqlite.js';

/**
 * The two cross-process acceptance proofs for the workspace-durable driver
 * (#98): independent processes safely update one state instance, and a
 * SIGKILLed writer can never leave a successful-but-corrupt state. The
 * children run the BUILT package from dist/ (prebuilt by the integration
 * pool's root build), so the proof covers the published module graph.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const writerFixture = join(packageRoot, 'tests', 'fixtures', 'state-sqlite-writer.mjs');
const timeScale = Math.max(1, Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '1') || 1);

const crossProcessEvents = {
  taskAdded: z.object({ id: z.string().min(1), title: z.string().min(1) }).strict(),
} as const;

interface CrossProcessState {
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
}

/** Mirrors the definition inside tests/fixtures/state-sqlite-writer.mjs; the two must stay identical. */
const crossProcessDefinition = (): AgentStateDefinition<CrossProcessState, typeof crossProcessEvents> =>
  defineState({
    events: crossProcessEvents,
    id: 'state-cross-process/tasks',
    initial: { tasks: [] },
    lifetime: 'workspace-durable',
    reduce: (state, event) => ({ tasks: [...state.tasks, event.payload] }),
    schema: z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string() }).strict()) }).strict(),
  });

const spawnWriter = (file: string, writerId: string, mode: 'count' | 'loop', count?: number): ChildProcess =>
  spawn(process.execPath, [writerFixture, file, writerId, mode, ...(count === undefined ? [] : [String(count)])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const collect = (child: ChildProcess): { stderr: () => string; stdout: () => string } => {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  return {
    stderr: () => Buffer.concat(err).toString('utf8'),
    stdout: () => Buffer.concat(out).toString('utf8'),
  };
};

const withStateFile = async (run: (file: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-state-cross-process-'));
  try {
    await run(join(root, 'state.sqlite'));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe.sequential('sqlite driver cross-process proofs', () => {
  it('two independent processes safely update one workspace-durable state instance', { timeout: 60_000 }, () =>
    withStateFile(async (file) => {
      const perWriter = 25;
      const first = spawnWriter(file, 'alpha', 'count', perWriter);
      const second = spawnWriter(file, 'beta', 'count', perWriter);
      const firstOutput = collect(first);
      const secondOutput = collect(second);
      const [[firstExit], [secondExit]] = (await Promise.all([once(first, 'close'), once(second, 'close')])) as [
        [number | null],
        [number | null],
      ];
      expect(firstExit, firstOutput.stderr()).toBe(0);
      expect(secondExit, secondOutput.stderr()).toBe(0);
      expect(JSON.parse(firstOutput.stdout())).toEqual({ committed: perWriter, writerId: 'alpha' });

      const store = await createSqliteStateDriver({ file }).open(crossProcessDefinition());
      const head = await store.read();
      expect(head.revision).toBe(perWriter * 2);
      expect(head.state.tasks).toHaveLength(perWriter * 2);
      const ids = head.state.tasks.map((task) => task.id);
      expect(new Set(ids).size).toBe(perWriter * 2);
      for (const writerId of ['alpha', 'beta']) {
        expect(ids.filter((id) => id.startsWith(`${writerId}-`))).toHaveLength(perWriter);
      }

      // The interleaved journal replays exactly at every revision boundary.
      const cursor = await store.changes({ afterRevision: 0 });
      expect(cursor.headRevision).toBe(perWriter * 2);
      expect(cursor.changes.map((change) => change.revision)).toEqual(
        Array.from({ length: perWriter * 2 }, (_, index) => index + 1),
      );
      expect((await store.read({ revision: perWriter })).state.tasks).toHaveLength(perWriter);

      // Replaying a key committed by another process returns its committed result.
      const replayed = await store.dispatch(
        'taskAdded',
        { id: 'alpha-0', title: 'Task alpha 0' },
        { idempotencyKey: 'alpha:0' },
      );
      expect(replayed.replayed).toBe(true);
      await store.close();
    }));

  it('a SIGKILLed writer cannot leave a successful-but-corrupt state', { timeout: 60_000 }, () =>
    withStateFile(async (file) => {
      const writer = spawnWriter(file, 'victim', 'loop');
      const output = collect(writer);
      const closed = once(writer, 'close');
      try {
        const reader = await createSqliteStateDriver({ file, busyTimeoutMs: 10_000 }).open(crossProcessDefinition());
        const deadline = Date.now() + 20_000 * timeScale;
        let observed = 0;
        while (observed < 5) {
          observed = (await reader.read()).revision;
          if (observed >= 5) break;
          if (Date.now() > deadline) {
            throw new Error(`writer only reached revision ${String(observed)}: ${output.stderr()}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await reader.close();
      } finally {
        writer.kill('SIGKILL');
      }
      await closed;

      // A fresh instance over the same file opens cleanly: the head matches
      // the journal, SQLite's own integrity check passes, every retained
      // revision replays, and the store accepts new commits.
      const store = await createSqliteStateDriver({ file }).open(crossProcessDefinition());
      const head = await store.read();
      expect(head.revision).toBeGreaterThanOrEqual(5);
      expect(head.state.tasks).toHaveLength(head.revision);

      const db = new DatabaseSync(file);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      db.close();

      for (let revision = 0; revision <= head.revision; revision += 1) {
        expect((await store.read({ revision })).state.tasks).toHaveLength(revision);
      }
      const next = await store.dispatch(
        'taskAdded',
        { id: 'post-kill', title: 'Task post kill' },
        { idempotencyKey: 'post-kill:0' },
      );
      expect(next.revision).toBe(head.revision + 1);
      await store.close();
    }));
});
