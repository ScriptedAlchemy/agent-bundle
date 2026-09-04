import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Returns the request identity axes observed by this route.',
  title: 'Context',
};

export const inputSchema = z.object({
  host: z.string().optional(),
  session: z.string().optional(),
}).strict();

export const resultSchema = z.object({
  actor: z.unknown(),
  host: z.unknown(),
  lineage: z.unknown(),
  session: z.unknown(),
  terminal: z.unknown(),
  workspace: z.unknown(),
}).strict();

export default async function Context() {
  const context = await agent();
  const actor: JsonValue = context.actor.state === 'available'
    ? { source: context.actor.source, state: context.actor.state, value: { id: context.actor.value.id } }
    : { reason: context.actor.reason, state: context.actor.state };
  const host: JsonValue = context.host.state === 'available'
    ? { source: context.host.source, state: context.host.state, value: { name: context.host.value.name } }
    : { reason: context.host.reason, state: context.host.state };
  const session: JsonValue = context.session.state === 'available'
    ? { source: context.session.source, state: context.session.state, value: { sessionId: context.session.value.sessionId } }
    : { reason: context.session.reason, state: context.session.state };
  const workspace: JsonValue = context.workspace.state === 'available'
    ? { source: context.workspace.source, state: context.workspace.state, value: { root: context.workspace.value.root } }
    : { reason: context.workspace.reason, state: context.workspace.state };
  const lineage: JsonValue = context.lineage.state === 'available'
    ? { source: context.lineage.source, state: context.lineage.state, value: JSON.parse(JSON.stringify(context.lineage.value)) as JsonValue }
    : { reason: context.lineage.reason, state: context.lineage.state };
  const terminal: JsonValue = context.terminal.state === 'available'
    ? { source: context.terminal.source, state: context.terminal.state, value: JSON.parse(JSON.stringify(context.terminal.value)) as JsonValue }
    : { reason: context.terminal.reason, state: context.terminal.state };
  const result = {
    actor,
    host,
    lineage,
    session,
    terminal,
    workspace,
  };
  return (
    <Agent.Result value={result}>
      <Agent.Text>Request context observed.</Agent.Text>
    </Agent.Result>
  );
}
