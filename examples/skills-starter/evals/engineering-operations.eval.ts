import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [
    {
      assertions: [expectOutcome({ script: './graders/operations-result.ts' })],
      fixture: './fixtures/incident',
      hosts: { portable: { model: 'deterministic' } },
      id: 'incident-handoff-is-actionable',
      invocation: { mode: 'explicit', skill: 'incident-triage' },
      prompt: 'Use incident-triage to assess the incident evidence and prepare the operational handoff.',
      trials: 1,
    },
    {
      assertions: [expectOutcome({ script: './graders/operations-result.ts' })],
      fixture: './fixtures/upgrade',
      hosts: { portable: { model: 'deterministic' } },
      id: 'upgrade-plan-has-rollback',
      invocation: { mode: 'explicit', skill: 'dependency-upgrade' },
      prompt: 'Use dependency-upgrade to verify the compatibility and rollback evidence.',
      trials: 1,
    },
  ],
  name: 'engineering-operations',
});
