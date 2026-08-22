import { defineEvalSuite, expectExitCode } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [
    {
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repository',
      hosts: { claude: { model: 'claude-sonnet-4-5' } },
      id: 'packed-native-claude',
      invocation: { mode: 'explicit', skill: 'review' },
      prompt: 'Use the review Skill to identify the purpose of this fixture.',
      trials: 1,
    },
    {
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repository',
      hosts: { codex: { model: 'gpt-5.6-sol' } },
      id: 'packed-native-codex',
      invocation: { mode: 'explicit', skill: 'review' },
      prompt: 'Use the review Skill to identify the purpose of this fixture.',
      trials: 1,
    },
  ],
  name: 'packed-native-smoke',
});
