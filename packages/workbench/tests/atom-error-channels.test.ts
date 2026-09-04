import { describe, expect, it } from '@rstest/core';
import { Cause } from 'effect';
import { AsyncResult, AtomRegistry, type Atom } from 'effect/unstable/reactivity';

import { DiscoveryClientError, type HostDiscoveryReport } from '../src/discovery/discovery-client.ts';
import { discoveryLoaderAtom, discoveryReportAtom } from '../src/discovery/discovery-atoms.ts';
import { AgentDocumentClientError } from '../src/runtime/agent-document-client.ts';
import { agentDocumentEventsAtom, agentDocumentLoaderAtom } from '../src/runtime/agent-document-atoms.ts';

const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<AsyncResult.AsyncResult<A, E>> => {
  let dispose: (() => void) | undefined;
  // A synchronously failing atom settles inside the immediate callback, before
  // `subscribe` returns its disposer, so the subscription is released after
  // the promise settles rather than from inside the callback.
  return new Promise<AsyncResult.AsyncResult<A, E>>((resolve) => {
    dispose = registry.subscribe(atom, (result) => {
      if (AsyncResult.isInitial(result) || AsyncResult.isWaiting(result)) return;
      resolve(result);
    }, { immediate: true });
  }).finally(() => dispose?.());
};

const failureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): E => {
  if (!AsyncResult.isFailure(result)) throw new Error(`Expected a failed AsyncResult, received ${result._tag}.`);
  const failure = result.cause.reasons.find(Cause.isFailReason);
  if (failure === undefined) throw new Error('Expected a typed failure on the atom error channel.');
  return failure.error;
};

const report: HostDiscoveryReport = {
  diagnostics: [],
  endpoints: {
    diagnostics: [],
    directory: '/tmp/agent-bundle',
    findings: [],
    status: 'healthy',
    summary: { live: 0, staleLocks: 0, staleSockets: 0 },
  },
  generatedAt: '2026-09-01T12:00:00.000Z',
  hosts: [],
  manifestDigest: 'manifest-current',
  summary: { errors: 0, infos: 0, warnings: 0 },
};

describe('Workbench atom error channels', () => {
  it('fails the Agent Document atom with AgentDocumentClientError in every failure state', async () => {
    const registry = AtomRegistry.make();
    try {
      const unavailable = failureOf(await settled(registry, agentDocumentEventsAtom('run-1')));
      expect(unavailable).toBeInstanceOf(AgentDocumentClientError);
      expect(unavailable).toMatchObject({
        code: 'AB8206',
        message: 'Agent Document loading is not available in this Workbench session.',
        name: 'AgentDocumentClientError',
      });

      const routeFailure = new AgentDocumentClientError('AB8208', 'Stored Flight could not be decoded.', 409);
      registry.set(agentDocumentLoaderAtom, async () => { throw routeFailure; });
      expect(failureOf(await settled(registry, agentDocumentEventsAtom('run-2')))).toBe(routeFailure);

      registry.set(agentDocumentLoaderAtom, async () => { throw new TypeError('Failed to fetch'); });
      expect(failureOf(await settled(registry, agentDocumentEventsAtom('run-3')))).toMatchObject({
        code: 'AB8206',
        message: 'Failed to fetch',
        name: 'AgentDocumentClientError',
      });

      registry.set(agentDocumentLoaderAtom, async () => { throw 'opaque'; });
      expect(failureOf(await settled(registry, agentDocumentEventsAtom('run-4')))).toMatchObject({
        code: 'AB8206',
        message: 'Agent Document request could not be completed.',
        name: 'AgentDocumentClientError',
      });

      registry.set(agentDocumentLoaderAtom, async () => []);
      const loaded = await settled(registry, agentDocumentEventsAtom('run-5'));
      expect(AsyncResult.isSuccess(loaded)).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('fails the host discovery report atom with DiscoveryClientError in every failure state', async () => {
    const registry = AtomRegistry.make();
    try {
      const unavailable = failureOf(await settled(registry, discoveryReportAtom(0)));
      expect(unavailable).toBeInstanceOf(DiscoveryClientError);
      expect(unavailable).toMatchObject({
        code: 'AB8234',
        message: 'Host discovery loading is not available in this Workbench session.',
        name: 'DiscoveryClientError',
      });

      const routeFailure = new DiscoveryClientError('AB8007', 'Discovery route rejected the request.', 503);
      registry.set(discoveryLoaderAtom, async () => { throw routeFailure; });
      expect(failureOf(await settled(registry, discoveryReportAtom(1)))).toBe(routeFailure);

      registry.set(discoveryLoaderAtom, async () => { throw new TypeError('Failed to fetch'); });
      expect(failureOf(await settled(registry, discoveryReportAtom(2)))).toMatchObject({
        code: 'AB8234',
        message: 'Failed to fetch',
        name: 'DiscoveryClientError',
      });

      registry.set(discoveryLoaderAtom, async () => { throw 'opaque'; });
      expect(failureOf(await settled(registry, discoveryReportAtom(3)))).toMatchObject({
        code: 'AB8234',
        message: 'Host discovery request could not be completed.',
        name: 'DiscoveryClientError',
      });

      registry.set(discoveryLoaderAtom, async () => report);
      const loaded = await settled(registry, discoveryReportAtom(4));
      expect(AsyncResult.isSuccess(loaded)).toBe(true);
      if (AsyncResult.isSuccess(loaded)) expect(loaded.value).toBe(report);
    } finally {
      registry.dispose();
    }
  });
});
