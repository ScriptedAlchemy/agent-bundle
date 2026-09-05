import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, rs } from '@rstest/core';

import { setup as tagInvocation } from '../../../rstest.global-setup.ts';
import {
  removeRunRstestWorkerRoots,
  rstestRunIdVariable,
  rstestWorkerRootOwnerFile,
  rstestWorkerRootPrefix,
} from '../../../scripts/rstest-worker-roots.mjs';
import { rstestWorkerRoot, rstestWorkerRootOwner } from '../../../rstest.worker-isolation.ts';

/**
 * The pool teardown (rstest.global-setup.ts) removes the worker roots of one
 * Rstest invocation by the run id their owner markers carry. These tests
 * cover the run-id key end to end: the marker records the id the worker
 * inherited, `setup` decides that id, and the sweep removes exactly the
 * finished roots that carry it. rstest-worker-isolation.test.ts covers the
 * `temporaryRoot` key scripts/local-ci.mjs sweeps by.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

it('records the run id the worker inherited in its owner marker', async () => {
  const root = rstestWorkerRoot();
  const markerPath = join(root, rstestWorkerRootOwnerFile);
  const original = await readFile(markerPath, 'utf8');
  // rstest.setup.ts wrote the marker at worker start, after Rstest applied the
  // orchestrator's environment — including the id the pool's global setup
  // tagged this invocation with, when the pool runs one.
  expect(rstestWorkerRootOwner(root)?.runId).toBe(process.env[rstestRunIdVariable]);

  const runId = randomUUID();
  try {
    // The marker is written once per root, so re-create it under a stubbed id.
    rs.stubEnv(rstestRunIdVariable, runId);
    await rm(markerPath);
    expect(rstestWorkerRoot()).toBe(root);
    expect(rstestWorkerRootOwner(root)).toEqual({ ...(JSON.parse(original) as object), runId });

    // Without the variable the marker names no run, so no teardown can claim it.
    rs.stubEnv(rstestRunIdVariable, undefined);
    await rm(markerPath);
    rstestWorkerRoot();
    expect(rstestWorkerRootOwner(root)).not.toHaveProperty('runId');
  } finally {
    await writeFile(markerPath, original);
  }
});

it('tags the invocation with a fresh run id unless an outer runner already did', () => {
  expect(rstestRunIdVariable).toBe('AGENT_BUNDLE_RSTEST_RUN_ID');

  rs.stubEnv(rstestRunIdVariable, 'outer-runner-leg-1');
  tagInvocation();
  expect(process.env[rstestRunIdVariable]).toBe('outer-runner-leg-1');

  rs.stubEnv(rstestRunIdVariable, undefined);
  tagInvocation();
  const generated = process.env[rstestRunIdVariable];
  expect(generated).toMatch(uuidPattern);

  // An empty value is not an id an outer runner owns.
  rs.stubEnv(rstestRunIdVariable, '');
  tagInvocation();
  expect(process.env[rstestRunIdVariable]).toMatch(uuidPattern);
  expect(process.env[rstestRunIdVariable]).not.toBe(generated);
});

it('removes only the finished roots that carry one run id', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ab-rstest-roots-parent-'));
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const writeRoot = async (name: string, owner: Readonly<Record<string, unknown>> | undefined): Promise<string> => {
    const root = join(parent, name);
    await mkdir(join(root, 'cache', 'cmd-1-1'), { recursive: true });
    await writeFile(join(root, 'cache', 'cmd-1-1', 'leftover'), 'x');
    if (owner !== undefined) await writeFile(join(root, rstestWorkerRootOwnerFile), `${JSON.stringify(owner)}\n`);
    return root;
  };
  const marker = (workerId: string, pid: number, id?: string): Readonly<Record<string, unknown>> => ({
    cwd: '/w',
    pid,
    ...(id === undefined ? {} : { runId: id }),
    temporaryRoot: '/tmp',
    workerId,
  });
  try {
    const finished = await writeRoot(`${rstestWorkerRootPrefix}0000000000000001`, marker('1', 4_000_001, runId));
    const interrupted = await writeRoot(`${rstestWorkerRootPrefix}0000000000000002`, marker('2', 4_000_002, runId));
    const live = await writeRoot(`${rstestWorkerRootPrefix}0000000000000003`, marker('3', 4_000_003, runId));
    const otherRun = await writeRoot(`${rstestWorkerRootPrefix}0000000000000004`, marker('1', 4_000_004, otherRunId));
    // A pool that ran without rstest.global-setup.ts: marker, but no run id.
    const untagged = await writeRoot(`${rstestWorkerRootPrefix}0000000000000005`, marker('1', 4_000_005));
    const unmarked = await writeRoot(`${rstestWorkerRootPrefix}0000000000000006`, undefined);
    const corrupt = await writeRoot(`${rstestWorkerRootPrefix}0000000000000007`, undefined);
    await writeFile(join(corrupt, rstestWorkerRootOwnerFile), '{not json');
    const unrelated = await writeRoot('agent-bundle-artifact-000001', marker('1', 4_000_008, runId));
    const everything = [finished, interrupted, live, otherRun, untagged, unmarked, corrupt, unrelated]
      .map((root) => root.slice(parent.length + 1))
      .sort();

    // An empty id matches nothing, so an unset variable can never widen the sweep.
    await expect(removeRunRstestWorkerRoots({ isAlive: () => false, parent, runId: '' }))
      .resolves.toEqual({ removed: [], retained: [] });
    expect((await readdir(parent)).sort()).toEqual(everything);

    const result = await removeRunRstestWorkerRoots({
      isAlive: (pid) => pid === 4_000_003,
      parent,
      runId,
    });

    expect(result).toEqual({ removed: [finished, interrupted], retained: [live] });
    expect((await readdir(parent)).sort()).toEqual([
      live, otherRun, untagged, unmarked, corrupt, unrelated,
    ].map((root) => root.slice(parent.length + 1)).sort());
    await expect(readdir(join(live, 'cache', 'cmd-1-1'))).resolves.toEqual(['leftover']);

    // Once its owner has exited the retained root goes on the next pass; a pass
    // with nothing to do is not an error, and neither is a missing parent.
    await expect(removeRunRstestWorkerRoots({ isAlive: () => false, parent, runId }))
      .resolves.toEqual({ removed: [live], retained: [] });
    // Untagged roots are reclaimed only for the checkout that asks, and only
    // once their worker has exited; another run's tagged roots never are.
    await expect(removeRunRstestWorkerRoots({ isAlive: () => false, parent, reclaimUntaggedFrom: '/elsewhere', runId }))
      .resolves.toEqual({ removed: [], retained: [] });
    await expect(removeRunRstestWorkerRoots({ isAlive: () => true, parent, reclaimUntaggedFrom: '/w', runId }))
      .resolves.toEqual({ removed: [], retained: [untagged] });
    await expect(removeRunRstestWorkerRoots({ isAlive: () => false, parent, reclaimUntaggedFrom: '/w', runId }))
      .resolves.toEqual({ removed: [untagged], retained: [] });
    expect((await readdir(parent)).sort()).toEqual([otherRun, unmarked, corrupt, unrelated]
      .map((root) => root.slice(parent.length + 1)).sort());
    await expect(removeRunRstestWorkerRoots({ isAlive: () => false, parent, runId }))
      .resolves.toEqual({ removed: [], retained: [] });
    await expect(removeRunRstestWorkerRoots({ parent: join(parent, 'missing'), runId }))
      .resolves.toEqual({ removed: [], retained: [] });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
