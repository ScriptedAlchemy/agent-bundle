import { expect, it } from '@rstest/core';

const loadPackedNativeSmoke = async () => import('./support/packed-native-smoke.ts').catch(() => undefined);

const enabledHosts = [
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE === '1' ? ['claude' as const] : []),
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE === '1' ? ['codex' as const] : []),
];
const nativeIt = enabledHosts.length === 0 ? it.skip : it;

it('requires a host-specific opt-in and keeps the canonical Claude model pinned', async () => {
  const harness = await loadPackedNativeSmoke();
  expect(harness).toBeDefined();

  expect(harness!.packedNativeSmokePlan({})).toEqual({
    hosts: [
      { enabled: false, host: 'claude', model: 'claude-sonnet-4-5', reason: 'explicit-opt-in-required' },
      { enabled: false, host: 'codex', reason: 'explicit-opt-in-required' },
    ],
  });
  expect(harness!.packedNativeSmokePlan({ AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE: '1' })).toEqual({
    hosts: [
      { enabled: false, host: 'claude', model: 'claude-sonnet-4-5', reason: 'explicit-opt-in-required' },
      { enabled: true, host: 'codex' },
    ],
  });
});

nativeIt('runs opted-in authored Eval hosts through one production-only packed installation', async () => {
  const harness = await loadPackedNativeSmoke();
  expect(harness).toBeDefined();

  const report = await harness!.runPackedNativeSmoke({ environment: process.env });
  expect(report.package).toEqual({ externalBinary: true, productionOnly: true, tarballs: 1 });
  expect(report.hosts.map((host) => host.host)).toEqual(enabledHosts);
  expect(report.hosts.every((host) => host.status === 'passed')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(
    /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|authorization|sk-[A-Za-z0-9_-]{16,}|\/home\/|\/Users\/|prompt|response|stdout|stderr)/iu,
  );
}, 600_000);
