import type { ContractRouteFixture } from '../../src/test/contract.ts';

/** Shared route-harness fixtures for projection-level contract matrix tests. */
export const routeHarnessContractFixtures = (): Record<string, ContractRouteFixture> => ({
  'prompt:harness/summarize': { input: { note: 'chapter one' } },
  'resource:harness/notes': {},
  'tool:harness/catalog': { input: { genre: 'mystery' }, resultCompat: 'additive' },
  'tool:harness/echo': { input: { message: 'contract matrix' }, resultCompat: 'additive' },
  'tool:harness/journal': { input: { note: 'matrix proof' }, resultCompat: 'closed' },
  'tool:harness/publish-notice': {
    input: { message: 'matrix notice', recipientSession: 'matrix-session' },
    resultCompat: 'closed',
  },
  'tool:harness/strict-report': { input: { reportId: 'closed-1' }, resultCompat: 'closed' },
  'tool:harness/ticket': {
    input: { status: 'completed' },
    inputs: [{ status: 'pending' }, { includeDiagnostics: true, status: 'running' }],
    previousResults: [{ status: 'completed' }],
    resultCompat: 'additive',
  },
  'tool:harness/unavailable': { resultCompat: 'additive' },
  'tool:harness/wait': {
    cancellation: { abortAfterMs: 50, input: { holdMs: 5000 } },
    input: { holdMs: 1 },
    resultCompat: 'additive',
  },
});

/**
 * Packed-journey fixtures: journal sweep is read-only (`{}`) so durable-state
 * assertions in `packed-stdio-projection.test.ts` stay intact.
 */
export const routeHarnessPackedContractFixtures = (): Record<string, ContractRouteFixture> => ({
  ...routeHarnessContractFixtures(),
  'app:harness/panel': {},
  'tool:harness/journal': { resultCompat: 'closed' },
});
