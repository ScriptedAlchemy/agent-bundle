import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/status-result.ts' })],
    fixture: './fixtures/status',
    hosts: { portable: { model: 'deterministic' } },
    id: 'status-is-healthy',
    invocation: { mode: 'explicit', skill: 'service-readiness' },
    prompt: 'Use service-readiness to verify the checked-in compiler service fixture.',
    trials: 1,
  }],
  name: 'mcp-app-status',
});
