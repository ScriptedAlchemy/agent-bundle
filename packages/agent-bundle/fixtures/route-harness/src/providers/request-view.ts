import { AgentRequestError, useAgent } from '@agent-bundle/runtime';
import type { AgentProviderContext } from 'agent-bundle';

/**
 * A conventional provider that reports what the request view hands it (#459):
 * the identity axes (plugin root included) and lineage as the route will read
 * them, the read-only `state`/`notices` handles (their keys prove the
 * narrowing; `state.read()` and `notices.published()` are pure reads), and the
 * runtime error `useAgent()` raises because providers run outside the
 * request's async context. `notices.inbox()` records an exposure receipt on
 * the ledger, so it runs only when a tool input asks.
 */
export default async function requestView(context: AgentProviderContext) {
  let handle: string;
  try {
    useAgent();
    handle = 'reachable';
  } catch (error) {
    handle = error instanceof AgentRequestError ? error.code : 'unexpected';
  }
  const inbox = context.invocation.kind === 'tool'
    && typeof context.invocation.props.input === 'object'
    && context.invocation.props.input !== null
    && (context.invocation.props.input as { readonly inbox?: unknown }).inbox === true;
  return {
    handle,
    host: context.host.state === 'available' ? context.host.value.name : context.host.reason,
    lineage: context.lineage.state === 'available'
      ? {
          conversation: context.lineage.value.conversation,
          depth: context.lineage.value.depth,
          siblings: context.lineage.value.tree?.siblings.map((peer) => peer.conversation) ?? null,
        }
      : context.lineage.reason,
    notices: context.notices === undefined
      ? null
      : {
          keys: Object.keys(context.notices).sort(),
          published: (await context.notices.published()).map((notice) => notice.id),
          ...(inbox ? { inbox: (await context.notices.inbox()).map((notice) => notice.id) } : {}),
        },
    plugin: context.plugin.state === 'available' ? context.plugin.value.stateRoot : context.plugin.reason,
    session: context.session.state === 'available' ? context.session.value.sessionId : context.session.reason,
    state: context.state === undefined
      ? null
      : {
          keys: Object.keys(context.state).sort(),
          lifetime: context.state.lifetime,
          revision: (await context.state.read({ signal: context.signal })).revision,
        },
    workspace: context.workspace.state === 'available' ? context.workspace.value.root : context.workspace.reason,
  };
}
