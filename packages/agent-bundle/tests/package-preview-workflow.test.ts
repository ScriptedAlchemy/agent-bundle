import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';
import { parse as parseYaml } from 'yaml';

const packageUrl = new URL('../../../package.json', import.meta.url);
const workflowUrl = new URL('../../../.github/workflows/package-preview.yml', import.meta.url);

interface WorkflowStep {
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

it('publishes one locked package preview for pull requests', async () => {
  const [packageText, workflow] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(workflowUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText) as {
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const parsed = parseYaml(workflow) as {
    readonly on?: Readonly<Record<string, unknown>>;
    readonly permissions?: Readonly<Record<string, unknown>>;
    readonly jobs?: {
      readonly publish?: {
        readonly steps?: readonly WorkflowStep[];
      };
    };
  };
  const steps = parsed.jobs?.publish?.steps ?? [];

  expect(Object.keys(parsed.on ?? {})).toEqual(['pull_request']);
  expect(parsed.permissions).toEqual({});
  expect(steps.map((step) => step.uses ?? step.run)).toEqual([
    'actions/checkout@v7',
    'pnpm/setup@v1',
    'pnpm install --frozen-lockfile',
    'pnpm build',
    'pnpm preview:publish',
  ]);
  expect(steps[1]?.with).toEqual({ cache: true, install: false, runtime: 'node@22.19.0' });
  expect(packageJson.devDependencies?.['pkg-pr-new']).toBe('0.0.88');
  expect(packageJson.scripts?.['preview:publish']).toBe(
    "pkg-pr-new publish --previewVersion --no-compact --no-template './packages/agent-bundle' './packages/rsc-runtime'",
  );
  expect(workflow).not.toMatch(/pull_request_target|secrets\.|\b(?:corepack|npx)\b/u);
});
