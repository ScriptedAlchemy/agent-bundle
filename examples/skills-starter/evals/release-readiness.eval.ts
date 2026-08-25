import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/release-result.ts' })],
    fixture: './fixtures/release',
    hosts: { portable: { model: 'deterministic' } },
    id: 'release-artifact-is-ready',
    invocation: { mode: 'explicit', skill: 'release-review' },
    prompt: 'Review the release evidence and issue a readiness verdict.',
    trials: 1,
  }],
  name: 'release-readiness',
});
