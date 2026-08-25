import { execFile as executeFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { integrationTestFiles } from '../../../rstest.integration-tests.ts';

const execFile = promisify(executeFile);

it('selects product packages through the pinned pnpm workspace', async () => {
  const { stdout } = await execFile('pnpm', [
    '--recursive',
    '--depth',
    '-1',
    'list',
    '--json',
  ], { cwd: process.cwd() });
  const documents = stdout.trim().split(/\n\]\s*\n\[\n/u).map((document, index, all) => {
    const opening = index === 0 ? '' : '[\n';
    const closing = index === all.length - 1 ? '' : '\n]';
    return JSON.parse(`${opening}${document}${closing}`) as readonly {
      name: string;
      path: string;
      private?: boolean;
    }[];
  });
  const packages = documents.flat();

  expect(packages.map(({ name }) => name).sort()).toEqual([
    '@agent-bundle-example/hooks-and-scripts',
    '@agent-bundle-example/mcp-app',
    '@agent-bundle-example/skills-starter',
    'agent-bundle',
    'agent-bundle-workbench',
    'agent-bundle-workspace',
  ]);

  const examples = packages.filter(({ name }) => name.startsWith('@agent-bundle-example/'));
  expect(examples.every(({ private: isPrivate }) => isPrivate === true)).toBe(true);
  await Promise.all(examples.map(async ({ path }) => {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.devDependencies?.['agent-bundle']).toBe('workspace:*');
    expect(manifest.scripts).toEqual({
      build: 'agent-bundle build --json',
      check: 'pnpm validate && pnpm build',
      dev: 'agent-bundle dev',
      validate: 'agent-bundle validate --json',
    });
  }));

  const rootManifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const agentBundleManifest = JSON.parse(
    await readFile(join(process.cwd(), 'packages/agent-bundle/package.json'), 'utf8'),
  ) as {
    readonly bin?: Readonly<Record<string, string>>;
    readonly files?: readonly string[];
    readonly scripts?: Readonly<Record<string, string>>;
  };
  expect(rootManifest.devDependencies).toMatchObject({
    '@modelcontextprotocol/server': '2.0.0',
    'agent-bundle': 'workspace:*',
    'playwright-core': '1.62.1',
  });
  expect(rootManifest.scripts).toMatchObject({
    build: 'pnpm --filter agent-bundle build',
    'example:hooks': 'pnpm build && pnpm --filter @agent-bundle-example/hooks-and-scripts dev',
    'example:mcp-app': 'pnpm build && pnpm --filter @agent-bundle-example/mcp-app dev',
    'example:skills': 'pnpm build && pnpm --filter @agent-bundle-example/skills-starter dev',
    'examples:check': "pnpm build && pnpm --filter './examples/*' --workspace-concurrency=1 check",
  });
  expect(rootManifest.scripts).not.toHaveProperty('build:workbench');
  expect(agentBundleManifest.scripts).toEqual({
    build: 'pnpm build:workbench && rslib build',
    'build:workbench': 'pnpm --filter agent-bundle-workbench build',
  });
  expect(agentBundleManifest.bin).toEqual({ 'agent-bundle': './bin/agent-bundle.js' });
  expect(agentBundleManifest.files).toContain('bin');
  await expect(access(join(process.cwd(), 'packages/agent-bundle/bin/agent-bundle.js'))).resolves.toBeUndefined();

  await expect(access(join(process.cwd(), 'packages/agent-bundle/rslib.config.ts'))).resolves.toBeUndefined();
  await expect(access(join(process.cwd(), 'rslib.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });

  expect(integrationTestFiles).toEqual(expect.arrayContaining([
    'packages/agent-bundle/tests/examples-contract.test.ts',
    'packages/agent-bundle/tests/workspace-contract.test.ts',
  ]));
  expect(integrationTestFiles).not.toContain('packages/agent-bundle/tests/package-preview-workflow.test.ts');
});
