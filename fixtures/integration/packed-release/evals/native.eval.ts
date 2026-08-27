import { defineEvalSuite, expectExitCode } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectExitCode(0)],
    fixture: './fixtures/native',
    hosts: { claude: { model: 'claude-sonnet-4-5' } },
    id: 'native-review',
    invocation: { mode: 'explicit', skill: 'review' },
    prompt: 'Review the packed native fixture.',
    trials: 1,
  }],
  name: 'packed-native',
});
