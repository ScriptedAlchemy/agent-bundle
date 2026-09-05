import { expect, it } from '@rstest/core';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/contracts/runtime.ts';
import type { ProjectEventMessage } from '../../agent-bundle/src/contracts/runtime.ts';
import type { RuntimeBootstrap } from '../src/runtime-client.ts';
import {
  createRuntimeEventBuffer,
  createRuntimePlaygroundController,
  runtimeBootstrapRetryPlan,
  type RuntimePlaygroundClient,
} from '../src/runtime-controller.ts';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';

const vector = Object.freeze({
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
});
const status = Object.freeze({
  activeVector: vector,
  descriptor: Object.freeze({
    environmentVariables: Object.freeze([]),
    id: 'rsc',
    label: 'RSC',
    schemaVersion: 1 as const,
  }),
  diagnostics: Object.freeze([]),
  hmrReady: true,
  lastGoodVector: vector,
  state: 'active' as const,
}) satisfies DevRuntimeStatus;
const surface = Object.freeze({
  defaultTarget: 'portable',
  fixtures: Object.freeze([{
    id: 'fixture-a',
    label: 'Fixture A',
    seed: Object.freeze({ city: 'London' }),
  }]),
  id: 'hook.claude',
  kind: 'hook' as const,
  label: 'Claude hook',
  readOnly: true,
  targets: Object.freeze(['portable']),
}) satisfies DevRuntimeSurface;
const run = (id: string): DevRuntimeRun => Object.freeze({
  completedAt: '2026-09-05T07:00:01.000Z',
  id,
  input: Object.freeze({ city: 'London' }),
  result: Object.freeze({
    state: Object.freeze({
      identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }),
    }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded' as const,
  surfaceId: surface.id,
  target: 'portable',
  vector,
});
const profiles = Object.freeze([{
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable',
  version: '1',
}] satisfies readonly RuntimeProfileOption[]);
const bootstrap = (history: readonly DevRuntimeRun[] = []): RuntimeBootstrap =>
  Object.freeze({
    history,
    kind: 'available' as const,
    providerSessionId: 'provider-a',
    status,
    surfaces: Object.freeze([surface]),
  });

const clientFor = () => {
  const requests: Array<
    DevRuntimeInvocationRequest |
    DevRuntimeReplayRequest |
    DevRuntimeStateResetRequest |
    string
  > = [];
  const client: RuntimePlaygroundClient = {
    bootstrap: async () => bootstrap(),
    createRun: async (request) => {
      requests.push(request);
      return run('created');
    },
    readRun: async (id) => {
      requests.push(id);
      return run(id);
    },
    readRunDocument: async () => Object.freeze([]),
    readRunFlight: async () => new Blob(),
    replayRun: async (request) => {
      requests.push(request);
      return run('replayed');
    },
    resetState: async (request): Promise<DevRuntimeStateIdentity> => {
      requests.push(request);
      return Object.freeze({ stateStoreId: 'state-a', stateVersion: 2 });
    },
  };
  return { client, requests };
};

const runtimeEvent = (sequence: number, runId: string): ProjectEventMessage =>
  Object.freeze({
    occurredAt: '2026-09-05T07:00:00.000Z',
    payload: Object.freeze({
      providerSessionId: 'provider-a',
      runId,
      type: 'runtime.run.completed' as const,
    }),
    sequence,
    type: 'runtime.event' as const,
  });

it('keeps bootstrap retries bounded without closing an installed receiver', () => {
  expect(runtimeBootstrapRetryPlan(0, false)).toEqual({
    closePreControllerIngress: false,
    delay: 250,
    retryCount: 1,
  });
  expect(runtimeBootstrapRetryPlan(2, false)).toEqual({
    closePreControllerIngress: true,
    delay: undefined,
    retryCount: 2,
  });
  expect(runtimeBootstrapRetryPlan(2, true)).toEqual({
    closePreControllerIngress: false,
    delay: undefined,
    retryCount: 2,
  });
});

it('executes a read-only run once and merges it into replay history', async () => {
  const fixture = clientFor();
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: fixture.client,
    profiles,
  });

  controller.dispatch({ type: 'run.request' });
  await controller.whenIdle();

  expect(fixture.requests).toEqual([{
    expectedGenerationId: 'generation-a',
    fixtureId: 'fixture-a',
    input: { city: 'London' },
    surfaceId: 'hook.claude',
    target: 'portable',
  }]);
  expect(controller.model.history.map((entry) => entry.id)).toEqual(['created']);
});

it('reads a terminal runtime event once', async () => {
  const fixture = clientFor();
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: fixture.client,
    profiles,
  });

  await controller.receive(runtimeEvent(1, 'observed'));
  await controller.receive(runtimeEvent(1, 'observed'));
  await controller.whenIdle();

  expect(fixture.requests).toEqual(['observed']);
});

it('buffers runtime ingress in FIFO order until a controller is installed', async () => {
  const buffer = createRuntimeEventBuffer({ maximumPendingEvents: 2 });
  const received: ProjectEventMessage[] = [];
  buffer.receive(runtimeEvent(1, 'one'));
  buffer.receive(runtimeEvent(2, 'two'));
  buffer.install({
    receive: async (event) => { received.push(event); },
  });
  await buffer.whenIdle();
  buffer.receive(runtimeEvent(3, 'three'));
  await buffer.whenIdle();

  expect(received.map((event) =>
    event.type === 'runtime.event' ? event.payload.runId : event.type,
  )).toEqual(['one', 'two', 'three']);
});

it('ignores late client work after close', async () => {
  let resolve!: (value: DevRuntimeRun) => void;
  const pending = new Promise<DevRuntimeRun>((next) => { resolve = next; });
  const fixture = clientFor();
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: { ...fixture.client, createRun: async () => pending },
    profiles,
  });
  const observed: unknown[] = [];
  controller.subscribe((model) => observed.push(model));

  controller.dispatch({ type: 'run.request' });
  controller.close();
  resolve(run('late'));
  await pending;

  expect(observed).toHaveLength(1);
  expect(controller.model.history).toEqual([]);
});
