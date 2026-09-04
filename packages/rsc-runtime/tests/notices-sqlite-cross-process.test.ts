import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
} from '../src/notices/index.js';
import { createSqliteStateDriver } from '../src/state/sqlite.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(packageRoot, 'tests', 'fixtures', 'notices-sqlite-process.mjs');

const runProcess = async (
  file: string,
  mode: 'deliver' | 'publish' | 'retain',
): Promise<unknown> => {
  const child = spawn(process.execPath, [fixture, file, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = await once(child, 'close') as [number | null];
  expect(code, Buffer.concat(stderr).toString('utf8')).toBe(0);
  return JSON.parse(Buffer.concat(stdout).toString('utf8'));
};

describe.sequential('notice ledger cross-process proof', () => {
  it('publishes in one process and attempts delivery on the next admitted event in another', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-notices-cross-process-'));
    const file = join(root, 'notices.sqlite');
    try {
      const published = await runProcess(file, 'publish') as { readonly id: string; readonly state: string };
      expect(published.state).toBe('pending');

      // A third process compacts the journal between publish and delivery:
      // the head is materialized as the baseline and the publish record is
      // gone, yet the delivering process must see exactly the same ledger.
      const retained = await runProcess(file, 'retain') as {
        readonly compacted: boolean;
        readonly journal: { readonly baselineRevision: number; readonly records: number };
        readonly prunedIds: readonly string[];
        readonly revision: number;
      };
      expect(retained).toMatchObject({
        compacted: true,
        journal: { baselineRevision: 2, records: 1 },
        prunedIds: [],
        revision: 2,
      });

      const observed = await runProcess(file, 'deliver') as readonly [{
        readonly notice: { readonly id: string; readonly state: string };
        readonly receipt: { readonly channel: string; readonly invocationId: string };
      }];
      expect(observed).toEqual([expect.objectContaining({
        notice: expect.objectContaining({
          id: published.id,
          state: 'attempted',
        }),
        receipt: expect.objectContaining({
          channel: 'next-event',
          invocationId: 'delivery-process',
        }),
      })]);

      const driver = createSqliteStateDriver({ file });
      const store = await driver.open(agentNoticeStateDefinition());
      const ledger = createAgentNoticeLedger(store, {
        authorize: () => ({ state: 'authorized' }),
      });
      const durable = await ledger.read();
      expect(durable.notices).toEqual([expect.objectContaining({
        id: published.id,
        state: 'attempted',
        attempts: [expect.objectContaining({
          invocationId: 'delivery-process',
        })],
      })]);
      // Opening in this process re-ran the head-vs-replay check over the
      // compacted journal; the baseline is the retained first record and the
      // admission landed on top of it.
      expect(await store.inspect()).toMatchObject({
        baselineRevision: 2,
        headRevision: 3,
        lastCompaction: { revision: 2 },
        records: 2,
      });
      await expect(store.read({ revision: 1 })).rejects.toMatchObject({ code: 'revision-unavailable' });
      await driver.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
