import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/reads-result.ts' })],
    fixture: './fixtures/deterministic',
    hosts: { portable: { model: 'deterministic' } },
    id: 'deterministic-review',
    invocation: { mode: 'automatic' },
    prompt: 'Review the deterministic packed fixture.',
    trials: 1,
  }],
  name: 'packed-deterministic',
});
