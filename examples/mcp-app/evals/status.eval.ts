import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/status-result.ts' })],
    fixture: './fixtures/status',
    hosts: { portable: { model: 'deterministic' } },
    id: 'status-is-healthy',
    invocation: { mode: 'automatic' },
    prompt: 'Verify the example service status.',
    trials: 1,
  }],
  name: 'mcp-app-status',
});
