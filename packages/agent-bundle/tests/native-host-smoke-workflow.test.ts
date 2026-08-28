import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';
import { parse as parseYaml } from 'yaml';

const workflowUrl = new URL('../../../.github/workflows/native-host-smoke.yml', import.meta.url);
const packageUrl = new URL('../../../package.json', import.meta.url);
const launcherUrl = new URL('../../../scripts/run-packed-native-smoke.mjs', import.meta.url);

interface NativeSmokeMatrixRow {
  readonly host: string;
  readonly source_tests: string;
  readonly packed_command: string;
}

it('keeps source and installed-tarball native smokes in the manual self-hosted matrix', async () => {
  const [workflow, packageBytes, launcher] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(packageUrl, 'utf8'),
    readFile(launcherUrl, 'utf8'),
  ]);
  const packageDocument = JSON.parse(packageBytes) as { readonly scripts?: Readonly<Record<string, string>> };
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
      packed_command: 'pnpm test:packed:native:claude',
    },
    {
      host: 'codex',
      source_tests: 'packages/agent-bundle/tests/native-codex-contract.test.ts packages/agent-bundle/tests/eval-codex-home.test.ts',
      packed_command: 'pnpm test:packed:native:codex',
    },
  ]));
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE: ${{ matrix.host == 'claude' && '1' || '' }}");
  expect(workflow).toContain("AGENT_BUNDLE_NATIVE_CODEX_SMOKE: ${{ matrix.host == 'codex' && '1' || '' }}");

  expect(workflow).not.toMatch(/\b(?:push|pull_request):/u);
  expect(workflow).not.toMatch(/\bsecrets\./u);
  expect(workflow).not.toMatch(/API[_-]?KEY/iu);
  expect(packageDocument.scripts?.['test:packed:native:claude']).toBe('pnpm build && AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE=1 pnpm test:packed:native');
  expect(packageDocument.scripts?.['test:packed:native:codex']).toBe('pnpm build && AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE=1 pnpm test:packed:native');
  expect(launcher).toContain("process.platform === 'win32' ? 'npm.cmd' : 'npm'");
  expect(launcher).toContain("spawn(npm, args, { env: environment, stdio: 'inherit' })");
  expect(launcher).not.toMatch(/(?:^|\s)AGENT_BUNDLE_PACKED_NATIVE_[A-Z_]+=1\s+npm/u);
  expect(workflow).not.toMatch(/\bcorepack\b/u);
  expect(workflow).toContain('uses: pnpm/setup@v2');
});
