import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';
import { parse as parseYaml } from 'yaml';

const workflowUrl = new URL('../../../.github/workflows/native-host-smoke.yml', import.meta.url);

interface NativeSmokeMatrixRow {
  readonly host: string;
  readonly source_tests: string;
  readonly packed_command: string;
}

it('keeps source and installed-tarball native smokes in the manual self-hosted matrix', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const parsed = parseYaml(workflow) as {
    readonly on?: { readonly workflow_dispatch?: unknown };
    readonly jobs?: {
      readonly ['native-host-smoke']?: {
        readonly ['runs-on']?: string;
        readonly strategy?: { readonly matrix?: { readonly include?: readonly NativeSmokeMatrixRow[] } };
      };
    };
  };
  const matrix = parsed.jobs?.['native-host-smoke']?.strategy?.matrix?.include;

  expect(parsed.on?.workflow_dispatch).toBeDefined();
  expect(parsed.jobs?.['native-host-smoke']?.['runs-on']).toBe('self-hosted');
  expect(matrix).toHaveLength(2);
  expect(matrix).toEqual(expect.arrayContaining([
    {
      host: 'claude',
      source_tests: 'packages/agent-bundle/tests/native-claude-contract.test.ts packages/agent-bundle/tests/eval-claude-harness.test.ts',
      packed_command: 'npm run test:packed:native:claude',
    },
    {
      host: 'codex',
      source_tests: 'packages/agent-bundle/tests/native-codex-contract.test.ts packages/agent-bundle/tests/eval-codex-home.test.ts',
      packed_command: 'npm run test:packed:native:codex',
    },
  ]));
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: ${{ matrix.host == 'claude' && '1' || '' }}");
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CODEX_SMOKE: ${{ matrix.host == 'codex' && '1' || '' }}");

  expect(workflow).not.toMatch(/\b(?:push|pull_request):/u);
  expect(workflow).not.toMatch(/\bsecrets\./u);
  expect(workflow).not.toMatch(/API[_-]?KEY/iu);
});
