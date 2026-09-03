import { expect, it } from '@rstest/core';

import {
  EpochAdoptionPolicy,
  type EpochContractEvaluation,
} from '../src/dev/epoch-adoption-policy.ts';
import { ProjectEventHub } from '../src/dev/events.ts';
import type { ActiveArtifactStatus, ArtifactEpoch } from '../src/dev/types.ts';

const epoch = (id: string): ArtifactEpoch => Object.freeze({
  configDigest: `config-${id}`,
  createdAt: '2026-09-02T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: `/project/.agent-bundle/epochs/${id}/manifest.json`,
  modelDigest: `model-${id}`,
  projectRevision: `source-${id}`,
  targetDigests: { portable: `target-${id}` },
});

const available = (value: ArtifactEpoch): ActiveArtifactStatus => Object.freeze({
  activeEpoch: value,
  currentSourceRevision: value.projectRevision,
  state: 'active',
});

const publish = (hub: ProjectEventHub, id: string): void => {
  const value = epoch(id);
  hub.publish({ epochId: id, payload: available(value), type: 'artifact.available' });
};

const passed = (epochId: string): EpochContractEvaluation => Object.freeze({
  diagnostics: Object.freeze([]),
  epochId,
  failures: Object.freeze([]),
  state: 'passed',
  summary: 'Development contract matrix passed.',
});

it('adopts artifact epochs immediately when contracts are disabled', async () => {
  const eventHub = new ProjectEventHub();
  const adopted: string[] = [];
  const policy = new EpochAdoptionPolicy({
    contracts: () => undefined,
    eventHub,
    run: async () => { throw new Error('disabled contracts must not run'); },
  });
  policy.subscribe((epochId) => adopted.push(epochId));

  publish(eventHub, 'epoch-1');
  await policy.settled();

  expect(adopted).toEqual(['epoch-1']);
  expect(eventHub.latestSequence).toBe(1);
  await policy.close();
});

it('adopts only passing contract epochs and publishes exact route check failures', async () => {
  const eventHub = new ProjectEventHub();
  const adopted: string[] = [];
  const statuses: unknown[] = [];
  eventHub.subscribe((event) => {
    if (event.type === 'dev.contract.status') statuses.push(event.payload);
  });
  const policy = new EpochAdoptionPolicy({
    contracts: () => ({ diagnostics: [], fixtures: {}, modulePath: '/project/fixtures.ts' }),
    eventHub,
    run: async (epochId) => epochId === 'epoch-1'
      ? passed(epochId)
      : Object.freeze({
          diagnostics: Object.freeze([]),
          epochId,
          failures: Object.freeze([Object.freeze({
            checks: Object.freeze(['version-quadruple', 'sweep']),
            routeId: 'mcp:fixture/tool:version',
          })]),
          state: 'failed' as const,
          summary: 'Development contract matrix reported 2 violations.',
        }),
  });
  policy.subscribe((epochId) => adopted.push(epochId));

  publish(eventHub, 'epoch-1');
  await policy.settled();
  publish(eventHub, 'epoch-2');
  await policy.settled();

  expect(adopted).toEqual(['epoch-1']);
  expect(statuses).toEqual([
    expect.objectContaining({ epochId: 'epoch-1', state: 'passed' }),
    expect.objectContaining({
      epochId: 'epoch-2',
      failures: [{
        checks: ['version-quadruple', 'sweep'],
        routeId: 'mcp:fixture/tool:version',
      }],
      state: 'failed',
    }),
  ]);
  await policy.close();
});

it('seeds a restored last-good epoch only until the first published epoch is observed', async () => {
  const eventHub = new ProjectEventHub();
  const adopted: string[] = [];
  const policy = new EpochAdoptionPolicy({
    contracts: () => undefined,
    eventHub,
    run: async () => { throw new Error('disabled contracts must not run'); },
  });
  policy.subscribe((epochId) => adopted.push(epochId));

  expect(policy.status()).toEqual({ mode: 'direct' });
  policy.seed('epoch-restored');
  await policy.settled();
  expect(adopted).toEqual(['epoch-restored']);
  expect(policy.status()).toEqual({ adoptedEpochId: 'epoch-restored', mode: 'direct' });

  publish(eventHub, 'epoch-1');
  policy.seed('epoch-ignored');
  await policy.settled();

  expect(adopted).toEqual(['epoch-restored', 'epoch-1']);
  expect(policy.currentEpochId).toBe('epoch-1');
  await policy.close();
});

it('runs the contract matrix over a seeded epoch and reports it in the status snapshot', async () => {
  const eventHub = new ProjectEventHub();
  const runs: string[] = [];
  const statuses: string[] = [];
  eventHub.subscribe((event) => {
    if (event.type === 'dev.contract.status') statuses.push(event.epochId);
  });
  const policy = new EpochAdoptionPolicy({
    contracts: () => ({ diagnostics: [], fixtures: {}, modulePath: '/project/fixtures.ts' }),
    eventHub,
    run: async (epochId) => {
      runs.push(epochId);
      return epochId === 'epoch-restored'
        ? Object.freeze({
            diagnostics: Object.freeze([]),
            epochId,
            failures: Object.freeze([Object.freeze({ checks: Object.freeze(['sweep']), routeId: 'tool:fixture/version' })]),
            state: 'failed' as const,
            summary: 'Development contract matrix reported 1 violation(s).',
          })
        : passed(epochId);
    },
  });

  expect(policy.status()).toEqual({ mode: 'gated' });
  policy.seed('epoch-restored');
  await policy.settled();

  expect(runs).toEqual(['epoch-restored']);
  expect(statuses).toEqual(['epoch-restored']);
  expect(policy.currentEpochId).toBeUndefined();
  expect(policy.status()).toEqual({
    contracts: expect.objectContaining({ epochId: 'epoch-restored', state: 'failed' }),
    mode: 'gated',
  });

  publish(eventHub, 'epoch-1');
  await policy.settled();
  expect(policy.status()).toEqual({
    adoptedEpochId: 'epoch-1',
    contracts: passed('epoch-1'),
    mode: 'gated',
  });
  await policy.close();
});

it('leases the adopted epoch until another epoch replaces it or the policy closes', async () => {
  const eventHub = new ProjectEventHub();
  const events: string[] = [];
  const adopted: string[] = [];
  const policy = new EpochAdoptionPolicy({
    contracts: () => ({ diagnostics: [], fixtures: {}, modulePath: '/project/fixtures.ts' }),
    eventHub,
    lease: async (epochId) => {
      events.push(`lease:${epochId}`);
      return { close: async () => { events.push(`release:${epochId}`); } };
    },
    run: async (epochId) => epochId === 'epoch-2'
      ? Object.freeze({
          diagnostics: Object.freeze([]),
          epochId,
          failures: Object.freeze([]),
          state: 'failed' as const,
          summary: 'Development contract matrix reported 1 violation(s).',
        })
      : passed(epochId),
  });
  policy.subscribe((epochId) => {
    adopted.push(epochId);
    events.push(`adopt:${epochId}`);
  });

  publish(eventHub, 'epoch-1');
  await policy.settled();
  // A failing rebuild keeps the previous lease: retention cannot reclaim epoch-1.
  publish(eventHub, 'epoch-2');
  await policy.settled();
  expect(events).toEqual(['lease:epoch-1', 'adopt:epoch-1']);

  publish(eventHub, 'epoch-3');
  await policy.settled();
  // The replacement is pinned before it is announced and the old pin is released only afterwards.
  expect(events).toEqual(['lease:epoch-1', 'adopt:epoch-1', 'lease:epoch-3', 'adopt:epoch-3', 'release:epoch-1']);
  expect(adopted).toEqual(['epoch-1', 'epoch-3']);

  await policy.close();
  expect(events.at(-1)).toBe('release:epoch-3');
});

it('does not adopt an epoch it cannot lease and reports the failure as contract status', async () => {
  const eventHub = new ProjectEventHub();
  const adopted: string[] = [];
  const statuses: EpochContractEvaluation[] = [];
  eventHub.subscribe((event) => {
    if (event.type === 'dev.contract.status') statuses.push(event.payload);
  });
  const policy = new EpochAdoptionPolicy({
    contracts: () => undefined,
    eventHub,
    lease: async (epochId) => {
      if (epochId === 'epoch-gone') throw new Error('Epoch "epoch-gone" does not exist.');
      return { close: async () => undefined };
    },
    run: async () => { throw new Error('disabled contracts must not run'); },
  });
  policy.subscribe((epochId) => adopted.push(epochId));

  publish(eventHub, 'epoch-1');
  await policy.settled();
  publish(eventHub, 'epoch-gone');
  await policy.settled();

  expect(adopted).toEqual(['epoch-1']);
  expect(policy.currentEpochId).toBe('epoch-1');
  expect(statuses).toEqual([expect.objectContaining({
    diagnostics: [expect.objectContaining({ code: 'AB7211', message: expect.stringContaining('could not be leased') })],
    epochId: 'epoch-gone',
    state: 'failed',
    summary: 'Adopted epoch could not be leased.',
  })]);
  await policy.close();
});

it('drains an epoch that arrives while the previous drain is finishing, at every microtask depth of the handoff', async () => {
  // The drain's completion handler runs a few microtasks after its loop last
  // saw an empty queue. Publish the next epoch from each depth inside that
  // window (from the adoption listener) and require that it is still adopted.
  for (let depth = 0; depth <= 8; depth += 1) {
    const eventHub = new ProjectEventHub();
    const adopted: string[] = [];
    const policy = new EpochAdoptionPolicy({
      contracts: () => undefined,
      eventHub,
      lease: async () => ({ close: async () => undefined }),
      run: async () => { throw new Error('disabled contracts must not run'); },
    });
    policy.subscribe((epochId) => {
      adopted.push(epochId);
      if (epochId !== 'epoch-1') return;
      let publishLate = (): void => publish(eventHub, 'epoch-2');
      for (let hop = 0; hop < depth; hop += 1) {
        const next = publishLate;
        publishLate = () => queueMicrotask(next);
      }
      publishLate();
    });

    publish(eventHub, 'epoch-1');
    await policy.settled();
    // Let the deepest publish land (it may fall just after the first settle), then settle again.
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 0); });
    await policy.settled();

    expect(adopted, `microtask depth ${String(depth)}`).toEqual(['epoch-1', 'epoch-2']);
    expect(policy.currentEpochId).toBe('epoch-2');
    await policy.close();
  }
});

it('never adopts a candidate superseded while its lease was being acquired, at every microtask depth', async () => {
  // Epoch-1 passes; while its lease settles, epoch-2 is published from each
  // microtask depth and then fails its contracts. Once epoch-2 has been
  // published, epoch-1 is obsolete: it must not be adopted afterwards, so hosts
  // never serve a stale epoch that a newer build already replaced.
  for (let depth = 0; depth <= 8; depth += 1) {
    const eventHub = new ProjectEventHub();
    const adopted: string[] = [];
    const releases: string[] = [];
    let epoch2Published = false;
    const policy = new EpochAdoptionPolicy({
      contracts: () => ({ diagnostics: [], fixtures: {}, modulePath: '/project/fixtures.ts' }),
      eventHub,
      lease: async (epochId) => {
        if (epochId === 'epoch-1') {
          let publishLate = (): void => {
            epoch2Published = true;
            publish(eventHub, 'epoch-2');
          };
          for (let hop = 0; hop < depth; hop += 1) {
            const next = publishLate;
            publishLate = () => queueMicrotask(next);
          }
          publishLate();
        }
        return { close: async () => { releases.push(epochId); } };
      },
      run: async (epochId) => epochId === 'epoch-1'
        ? passed(epochId)
        : Object.freeze({
            diagnostics: Object.freeze([]),
            epochId,
            failures: Object.freeze([]),
            state: 'failed' as const,
            summary: 'Development contract matrix reported 1 violation(s).',
          }),
    });
    const adoptedAfterSupersession: string[] = [];
    policy.subscribe((epochId) => {
      adopted.push(epochId);
      if (epoch2Published) adoptedAfterSupersession.push(epochId);
    });

    publish(eventHub, 'epoch-1');
    await policy.settled();
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 0); });
    await policy.settled();

    expect(adoptedAfterSupersession, `microtask depth ${String(depth)}`).toEqual([]);
    if (adopted.length === 0) {
      // Superseded before adoption: discarded, and its lease released.
      expect(policy.currentEpochId, `microtask depth ${String(depth)}`).toBeUndefined();
      expect(releases, `microtask depth ${String(depth)}`).toEqual(['epoch-1']);
    } else {
      // Adopted before epoch-2 existed; the failing epoch-2 leaves it in place.
      expect(adopted, `microtask depth ${String(depth)}`).toEqual(['epoch-1']);
      expect(policy.currentEpochId, `microtask depth ${String(depth)}`).toBe('epoch-1');
    }
    await policy.close();
  }
});

it('discards a superseded contract result and evaluates only the latest pending epoch', async () => {
  const eventHub = new ProjectEventHub();
  const first = Promise.withResolvers<EpochContractEvaluation>();
  const runs: string[] = [];
  const adopted: string[] = [];
  const statuses: string[] = [];
  eventHub.subscribe((event) => {
    if (event.type === 'dev.contract.status') statuses.push(event.epochId);
  });
  const policy = new EpochAdoptionPolicy({
    contracts: () => ({ diagnostics: [], fixtures: {}, modulePath: '/project/fixtures.ts' }),
    eventHub,
    run: async (epochId) => {
      runs.push(epochId);
      return epochId === 'epoch-1' ? first.promise : passed(epochId);
    },
  });
  policy.subscribe((epochId) => adopted.push(epochId));

  publish(eventHub, 'epoch-1');
  publish(eventHub, 'epoch-2');
  publish(eventHub, 'epoch-3');
  first.resolve(passed('epoch-1'));
  await policy.settled();

  expect(runs).toEqual(['epoch-1', 'epoch-3']);
  expect(statuses).toEqual(['epoch-3']);
  expect(adopted).toEqual(['epoch-3']);
  await policy.close();
});
