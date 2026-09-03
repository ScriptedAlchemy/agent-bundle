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
