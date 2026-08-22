import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';
import { parse as parseYaml } from 'yaml';

const packageUrl = new URL('../../../package.json', import.meta.url);
const workflowUrl = new URL('../../../.github/workflows/ci.yml', import.meta.url);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

it('runs publint explicitly in CI and the local release audit', async () => {
  const [packageText, workflow] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(workflowUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const parsed = parseYaml(workflow) as {
    readonly jobs?: {
      readonly verify?: { readonly steps?: readonly WorkflowStep[] };
    };
  };
  const steps = parsed.jobs?.verify?.steps ?? [];
  const packageLintIndex = steps.findIndex((step) => step.run === 'npm run lint:package');

  expect(packageJson.scripts?.['lint:package']).toBe('publint packages/agent-bundle');
  expect(packageJson.scripts?.['audit:release']).toMatch(/^npm run lint:package && /u);
  expect(packageLintIndex).toBeGreaterThan(0);
  expect(steps[packageLintIndex]).toEqual({ name: 'Package lint (publint)', run: 'npm run lint:package' });
  expect(steps[packageLintIndex - 1]?.run).toBe('npm run build');
});
