import { expect, it } from '@rstest/core';

import { agent, runAgentRequest, type AgentRequestContext } from '../src/agent-request.js';

it('resolves a provider once per request, detaches its context, and expires access', async () => {
  let calls = 0;
  let saved: AgentRequestContext | undefined;
  const resolveProvider = async () => {
    calls += 1;
    await expect(agent()).rejects.toThrow();
    return { value: calls };
  };
  await runAgentRequest({ invocation: { kind: 'tool' }, resolveProvider }, async () => {
    saved = await agent();
    expect(calls).toBe(0);
    const [left, right] = await Promise.all([saved.provider('policy'), saved.provider('policy')]);
    expect(left).toBe(right);
    expect(calls).toBe(1);
  });
  await expect(saved!.provider('policy')).rejects.toThrow();
  await runAgentRequest({ invocation: { kind: 'tool' }, resolveProvider }, async () => {
    await (await agent()).provider('policy');
  });
  expect(calls).toBe(2);
  await runAgentRequest({ invocation: { kind: 'tool' }, providers: { policy: 'fixture' } }, async () => {
    const context = await agent();
    expect(await context.provider('policy')).toBe('fixture');
    await expect(context.provider('missing')).rejects.toThrow('Unknown provider');
  });
});

it('shares failures and refuses access after cancellation', async () => {
  const failure = new Error('provider failed');
  let calls = 0;
  const controller = new AbortController();
  await runAgentRequest({ invocation: { kind: 'tool' }, signal: controller.signal, resolveProvider: async () => { calls += 1; throw failure; } }, async () => {
    const context = await agent();
    const results = await Promise.allSettled([context.provider('policy'), context.provider('policy')]);
    expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(calls).toBe(1);
    controller.abort();
    await expect(context.provider('other')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
