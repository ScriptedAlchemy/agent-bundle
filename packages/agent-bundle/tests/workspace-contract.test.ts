import { execFile as executeFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);

it('selects product packages through the pinned pnpm workspace', async () => {
  const { stdout } = await execFile('corepack', [
    'pnpm',
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
    readonly scripts?: Readonly<Record<string, string>>;
  };
  expect(rootManifest.scripts).toMatchObject({
    'example:hooks': 'pnpm --filter @agent-bundle-example/hooks-and-scripts dev',
    'example:mcp-app': 'pnpm --filter @agent-bundle-example/mcp-app dev',
    'example:skills': 'pnpm --filter @agent-bundle-example/skills-starter dev',
    'examples:check': "pnpm --filter './examples/*' --workspace-concurrency=1 check",
  });
});
