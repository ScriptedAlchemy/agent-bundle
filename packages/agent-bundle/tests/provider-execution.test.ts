import { expect, it } from '@rstest/core';
import { executeProviders } from '../src/routes/provider-execution.ts';

it('executes a requested provider with the read-only request and canonical error identity', async () => {
  const options = { invocation: { kind: 'tool' }, processLifetime: { hits: 1, instanceId: 'test', pid: 1 }, request: { host: undefined, lineage: undefined, plugin: undefined, session: undefined, signal: new AbortController().signal, workspace: undefined } };
  const values = await executeProviders({ ...options, providers: [{ key: 'policy', source: 'src/providers/policy.ts', module: { default: () => 'ready' } }] });
  expect(values.policy).toBe('ready');
  await expect(executeProviders({ ...options, providers: [{ key: 'policy', source: 'src/providers/policy.ts', module: {} }] })).rejects.toThrow('must default-export a factory');
});
