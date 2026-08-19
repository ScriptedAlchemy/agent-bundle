import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

const workflowUrl = new URL('../../../.github/workflows/native-host-smoke.yml', import.meta.url);

const sourceSuites = [
  'packages/agent-bundle/tests/native-claude-contract.test.ts',
  'packages/agent-bundle/tests/eval-claude-harness.test.ts',
  'packages/agent-bundle/tests/native-codex-contract.test.ts',
  'packages/agent-bundle/tests/eval-codex-home.test.ts',
] as const;

it('keeps every source authenticated smoke suite in the manual self-hosted matrix', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('runs-on: self-hosted');
  expect(workflow).toContain('strategy:');
  expect(workflow).toContain('matrix:');
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: ${{ matrix.host == 'claude' && '1' || '' }}");
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CODEX_SMOKE: ${{ matrix.host == 'codex' && '1' || '' }}");

  for (const suite of sourceSuites) expect(workflow).toContain(suite);

  expect(workflow).not.toMatch(/\b(?:push|pull_request):/u);
  expect(workflow).not.toMatch(/\bsecrets\./u);
  expect(workflow).not.toMatch(/(?:API[_-]?KEY|packed-native|test:packed)/iu);
});
