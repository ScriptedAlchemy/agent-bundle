import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';
import { parse as parseYaml } from 'yaml';

const packageUrl = new URL('../../../package.json', import.meta.url);
const workflowUrl = new URL('../../../.github/workflows/ci.yml', import.meta.url);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
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
      readonly 'rsc-runtime-micro-eval'?: { readonly steps?: readonly WorkflowStep[] };
      readonly verify?: { readonly steps?: readonly WorkflowStep[] };
    };
  };
  const steps = parsed.jobs?.verify?.steps ?? [];
  const rscSteps = parsed.jobs?.['rsc-runtime-micro-eval']?.steps ?? [];
  const packageLintIndex = steps.findIndex((step) => step.run === 'pnpm lint:package');
  const setup = steps.find((step) => step.uses === 'pnpm/setup@v1');

  expect(packageJson.scripts?.['lint:package']).toBe('publint packages/agent-bundle');
  expect(packageJson.scripts?.['audit:release']).toMatch(/^pnpm lint:package && /u);
  expect(setup?.with).toEqual({ cache: true, install: false, runtime: 'node@${{ matrix.node-version }}' });
  expect(packageLintIndex).toBeGreaterThan(0);
  expect(steps[packageLintIndex]).toEqual({ name: 'Package lint (publint)', run: 'pnpm lint:package' });
  expect(steps[packageLintIndex - 1]?.run).toBe('pnpm build');
  expect(rscSteps.map((step) => step.uses ?? step.run)).toEqual([
    'actions/checkout@v7',
    'pnpm/setup@v1',
    'pnpm install --frozen-lockfile',
    'pnpm eval:spot',
  ]);
  expect(rscSteps[1]?.with).toEqual({ cache: true, install: false, runtime: 'node@22.19.0' });
  expect(workflow).not.toMatch(/\bcorepack\b/u);
});
