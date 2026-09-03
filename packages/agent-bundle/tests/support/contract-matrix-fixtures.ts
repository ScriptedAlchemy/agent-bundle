import type {
  ContractLifecyclePhase,
  ContractRouteFixture,
} from '../../src/test/contract.ts';

const lifecyclePhases: readonly ContractLifecyclePhase[] = [
  'unknown',
  'queued',
  'running',
  'first-progress',
  'repeated-progress',
  'terminal',
];

const lifecycleHistory = (phase: ContractLifecyclePhase): readonly ContractLifecyclePhase[] => {
  const index = lifecyclePhases.indexOf(phase);
  return phase === 'unknown' ? [] : lifecyclePhases.slice(1, index + 1);
};

const lifecycleFixture = (revisionOffset = 0): ContractRouteFixture => ({
  input: { action: 'observe' },
  lifecycle: {
    state: {
      budget: {
        codePath: ['budgetError'],
        expectedCode: 'budget-exceeded',
        input: { action: 'exceed-budget', payload: 'x'.repeat(512) },
        revisionPath: ['revision'],
      },
      catalog: {
        id: 'route-harness/journal',
        lifetime: 'workspace-durable',
      },
      durability: {
        expectedStructuredContent: {
          history: lifecyclePhases.slice(1),
          phase: 'terminal',
          revision: revisionOffset + 5,
        },
        input: { action: 'observe' },
      },
      idempotency: {
        phase: 'repeated-progress',
        replayedPath: ['replayed'],
        revisionPath: ['revision'],
      },
      journal: {
        expected: lifecyclePhases.slice(1),
        path: ['history'],
      },
      notice: {
        expected: 'pending',
        path: ['noticeState'],
        phase: 'terminal',
      },
    },
    transitionDriver: () => lifecyclePhases.map((phase, index) => ({
      expectedStructuredContent: {
        history: lifecycleHistory(phase),
        phase,
        replayed: false,
        revision: revisionOffset + index,
        ...(phase === 'terminal' ? { noticeState: 'pending' } : {}),
      },
      input: phase === 'unknown'
        ? { action: 'observe' }
        : {
          action: 'transition',
          emitProgress: phase === 'first-progress' || phase === 'repeated-progress',
          idempotencyKey: `lifecycle:${phase}`,
          phase,
        },
      phase,
      progressNotifications: phase === 'first-progress'
        ? 1
        : phase === 'repeated-progress' ? 2 : 0,
      renderedTextIncludes: `lifecycle: ${phase}`,
    })),
  },
  resultCompat: 'additive',
});

/** Shared route-harness fixtures for projection-level contract matrix tests. */
export const routeHarnessContractFixtures = (): Record<string, ContractRouteFixture> => ({
  'prompt:harness/summarize': { input: { note: 'chapter one' } },
  'resource:harness/notes': {},
  'tool:harness/catalog': { input: { genre: 'mystery' }, resultCompat: 'additive' },
  'tool:harness/context': { resultCompat: 'closed' },
  'tool:harness/echo': { input: { message: 'contract matrix' }, resultCompat: 'additive' },
  'tool:harness/journal': { resultCompat: 'closed' },
  'tool:harness/lifecycle': lifecycleFixture(),
  'tool:harness/mutation-probe': { input: { marker: 'contract matrix' }, resultCompat: 'closed' },
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
  'tool:harness/tooling': { resultCompat: 'closed' },
  'tool:harness/unavailable': { resultCompat: 'additive' },
  'tool:harness/wait': {
    cancellation: { abortAfterMs: 50, input: { holdMs: 5000 } },
    input: { holdMs: 1 },
    resultCompat: 'additive',
  },
});

/**
 * Packed-journey fixtures: journal sweep is read-only (`{}`) so durable-state
 * assertions in `packed-stdio-projection.test.ts` stay intact. The compiled
 * `app:harness/panel` route is deliberately absent — the packed level
 * auto-covers app routes (#401).
 */
export const routeHarnessPackedContractFixtures = (): Record<string, ContractRouteFixture> => ({
  ...routeHarnessContractFixtures(),
  'tool:harness/journal': { resultCompat: 'closed' },
  'tool:harness/lifecycle': lifecycleFixture(1),
});

export const routeHarnessLifecycleWithoutLiveProgress = (): Record<string, ContractRouteFixture> => {
  const fixtures = routeHarnessContractFixtures();
  const lifecycle = fixtures['tool:harness/lifecycle']?.lifecycle;
  if (lifecycle === undefined) throw new TypeError('Lifecycle fixture is unavailable.');
  return {
    ...fixtures,
    'tool:harness/lifecycle': {
      ...fixtures['tool:harness/lifecycle'],
      lifecycle: {
        ...lifecycle,
        transitionDriver: () => lifecycle.transitionDriver().map((transition) => ({
          ...transition,
          input: transition.phase === 'first-progress'
            ? { ...transition.input as Record<string, unknown>, emitProgress: false }
            : transition.input,
        })),
      },
    },
  };
};
