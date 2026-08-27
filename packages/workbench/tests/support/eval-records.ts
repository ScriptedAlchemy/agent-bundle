import type { EvalRunRecord, EvalTrialRecord } from '../../../agent-bundle/src/eval/run-store.ts';

export const makeRunRecord = (overrides: Partial<EvalRunRecord> = {}): EvalRunRecord => ({
  agentBundleVersion: '0.1.0',
  artifact: {
    manifestPath: 'agent-bundle.manifest.json',
    source: 'run-owned',
    targetDigests: { portable: 'c'.repeat(64) },
  },
  completedAt: '2026-08-17T00:00:02.000Z',
  createdAt: '2026-08-17T00:00:00.000Z',
  harness: 'deterministic',
  id: '20260817t000000000z-abcdef01',
  projectRevision: 'd'.repeat(64),
  summary: { cases: 2, fail: 1, inconclusive: 1, pass: 1, trials: 3 },
  ...overrides,
});

export const makeTrialRecord = (overrides: Partial<EvalTrialRecord> = {}): EvalTrialRecord => ({
  assertions: [{
    assertionId: 'outcome:0123456789abcdef',
    detail: 'The grader passed.',
    evidence: 'observed',
    kind: 'outcome',
    outcome: 'pass',
  }],
  caseDigest: 'a'.repeat(64),
  caseId: 'reads-result',
  completedAt: '2026-08-17T00:00:01.000Z',
  durationMs: 12,
  evidence: {
    mcp: { calls: [], level: 'unavailable' },
    process: { level: 'unavailable', timedOut: false },
    scripts: { level: 'observed', results: {} },
    skillActivation: { activated: [], level: 'unavailable' },
  },
  fixtureDigest: 'b'.repeat(64),
  host: 'portable',
  id: 'portable-1',
  model: 'deterministic',
  outcome: 'pass',
  prompt: 'Report the highest-risk regression.',
  provenance: {
    hostCliVersion: 'agent-bundle@0.1.0',
    invocation: { mode: 'automatic' },
    semanticGrader: null,
  },
  rawArtifacts: ['artifacts/portable-1/evidence.json'],
  startedAt: '2026-08-17T00:00:00.500Z',
  targetDigest: 'c'.repeat(64),
  trialIndex: 0,
  ...overrides,
});
