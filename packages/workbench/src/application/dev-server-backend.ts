import type {
  RouteInvocationRequest,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { ProjectEventMessage } from '../../../agent-bundle/src/contracts/project.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';
import type { InvocationClient } from './invocation-client.ts';

export interface DevServerBackendOptions {
  readonly client: InvocationClient;
  readonly events: Readonly<{
    subscribe(listener: (event: ProjectEventMessage) => void): () => void;
  }>;
}

export const createDevServerBackend = ({
  client,
  events,
}: DevServerBackendOptions): InvocationBackend => Object.freeze({
  accepts: (leaf: ApplicationLeaf): boolean =>
    leaf.execution === 'invoke' && leaf.routeId !== undefined,
  history: async (leaf: ApplicationLeaf, signal?: AbortSignal) => {
    if (leaf.routeId === undefined) return Object.freeze([]);
    const invocations = await client.list(50, signal);
    return Object.freeze(invocations.filter((invocation) => invocation.routeId === leaf.routeId));
  },
  invoke: (
    _leaf: ApplicationLeaf,
    request: RouteInvocationRequest,
    signal?: AbortSignal,
  ) => client.invoke(request, signal),
  kind: 'dev-server',
  read: (invocationId: string, signal?: AbortSignal) =>
    client.read(invocationId, signal),
  subscribe: (listener: Parameters<InvocationBackend['subscribe']>[0]) => events.subscribe((event) => {
    if (event.type === 'route.invocation') listener(event.payload.invocation);
  }),
});
