import { setTimeout as delay } from 'node:timers/promises';

import { Agent, agent } from '@agent-bundle/runtime';
import { AgentStateError } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const lifecyclePhaseSchema = z.enum([
  'queued',
  'running',
  'first-progress',
  'repeated-progress',
  'terminal',
]);

export const config = {
  description: 'Replays a deterministic durable lifecycle through mounted state.',
  title: 'Lifecycle',
};

export const inputSchema = z.object({
  action: z.enum(['exceed-budget', 'observe', 'transition']),
  emitProgress: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
  payload: z.string().optional(),
  phase: lifecyclePhaseSchema.optional(),
}).strict();

export const resultSchema = z.object({
  budgetError: z.literal('budget-exceeded').optional(),
  history: z.array(lifecyclePhaseSchema),
  noticeState: z.literal('pending').optional(),
  phase: z.union([z.literal('unknown'), lifecyclePhaseSchema]),
  replayed: z.boolean(),
  revision: z.number().int().nonnegative(),
});

type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;

interface LifecycleState {
  readonly lifecycle: {
    readonly history: readonly LifecyclePhase[];
    readonly phase: 'unknown' | LifecyclePhase;
  };
}

export default async function Lifecycle({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  if (context.state === undefined) throw new TypeError('Lifecycle state is unavailable.');

  if (input.action === 'observe') {
    const snapshot = await context.state.read();
    const lifecycle = (snapshot.state as LifecycleState).lifecycle;
    return (
      <Agent.Result value={{
        history: lifecycle.history,
        phase: lifecycle.phase,
        replayed: false,
        revision: snapshot.revision,
      }}>
        <Agent.Text>{`lifecycle: ${lifecycle.phase}`}</Agent.Text>
      </Agent.Result>
    );
  }

  if (input.action === 'exceed-budget') {
    try {
      await context.state.dispatch('transitioned', {
        payload: input.payload ?? '',
        phase: 'terminal',
      }, {
        idempotencyKey: 'lifecycle:budget',
      });
      throw new TypeError('Lifecycle budget fixture unexpectedly committed.');
    } catch (error) {
      if (!(error instanceof AgentStateError) || error.code !== 'budget-exceeded') throw error;
      const snapshot = await context.state.read();
      const lifecycle = (snapshot.state as LifecycleState).lifecycle;
      return (
        <Agent.Result value={{
          budgetError: error.code,
          history: lifecycle.history,
          phase: lifecycle.phase,
          replayed: false,
          revision: snapshot.revision,
        }}>
          <Agent.Text>{`lifecycle: ${lifecycle.phase}`}</Agent.Text>
        </Agent.Result>
      );
    }
  }

  if (input.phase === undefined || input.idempotencyKey === undefined) {
    throw new TypeError('Lifecycle transitions require phase and idempotencyKey.');
  }
  if (input.emitProgress === true) {
    const reports = input.phase === 'repeated-progress' ? 2 : 1;
    for (let completed = 1; completed <= reports; completed += 1) {
      await context.progress.report({
        completed,
        message: `${input.phase}:${String(completed)}`,
        total: reports,
      });
    }
    await delay(10);
  }
  const committed = await context.state.dispatch('transitioned', {
    phase: input.phase,
  }, {
    idempotencyKey: input.idempotencyKey,
  });
  let noticeState: 'pending' | undefined;
  if (input.phase === 'terminal') {
    if (context.notices === undefined) throw new TypeError('Lifecycle notices are unavailable.');
    if (context.workspace.state !== 'available') throw new TypeError('Lifecycle workspace identity is unavailable.');
    const published = await context.notices.publish({
      content: {
        root: { kind: 'text', text: 'lifecycle terminal' },
        status: 'success',
        version: 1,
      },
      priority: 'normal',
      recipient: { workspace: context.workspace.value },
    }, {
      idempotencyKey: 'lifecycle:terminal-notice',
    });
    noticeState = published.notice.state === 'pending' ? 'pending' : undefined;
  }
  const lifecycle = (committed.state as LifecycleState).lifecycle;
  return (
    <Agent.Result value={{
      history: lifecycle.history,
      ...(noticeState === undefined ? {} : { noticeState }),
      phase: lifecycle.phase,
      replayed: committed.replayed,
      revision: committed.revision,
    }}>
      <Agent.Text>{`lifecycle: ${lifecycle.phase}`}</Agent.Text>
    </Agent.Result>
  );
}
