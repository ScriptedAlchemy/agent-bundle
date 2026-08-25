import { execFile as executeFile } from 'node:child_process';
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
    'agent-bundle',
    'agent-bundle-workbench',
    'agent-bundle-workspace',
  ]);
});
