import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { validate } from '../src/api.ts';
import {
  DiagnosticService,
  ProjectService,
  type RslintEngine,
} from '../src/dev/index.ts';

const createProject = async (skillMarkdown: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-service-'));
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'dev-service-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(join(root, 'skills', 'review', 'SKILL.md'), skillMarkdown),
  ]);
  return root;
};

it('stops the shared project pipeline on source errors with a frozen structured status', async () => {
  const root = await createProject('# Missing frontmatter\n');
  try {
    const prepared = await new ProjectService({ root }).prepare('build');

    expect(prepared.source.state).toBe('invalid');
    expect(prepared.source.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB3001',
        sourcePath: join(root, 'skills', 'review', 'SKILL.md'),
      }),
    ]));
    expect(prepared.model).toBeUndefined();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.diagnostics)).toBe(true);
    expect(Object.isFrozen(prepared.source)).toBe(true);
    expect(Object.isFrozen(prepared.source.diagnostics)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns a frozen source diagnostic when configuration loading fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-missing-config-'));
  try {
    const prepared = await new ProjectService({ root }).prepare('inspect');

    expect(prepared).toMatchObject({
      source: {
        diagnostics: [{ code: 'AB7000', sourcePath: join(root, 'agent-bundle.config.ts') }],
        state: 'invalid',
      },
    });
    expect(prepared.model).toBeUndefined();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.source.diagnostics[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('routes API validation through the project service for configuration failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dev-api-config-'));
  try {
    const prepared = await new ProjectService({ root }).prepare('validate');
    const result = await validate({ root });

    expect(result).toEqual({ diagnostics: prepared.diagnostics });
    expect(Object.isFrozen(result)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reuses one resident Rslint engine and closes it idempotently', async () => {
  const root = '/workspace/project';
  const lintCalls: string[][] = [];
  let created = 0;
  let closed = 0;
  const engine: RslintEngine = {
    close: async () => {
      closed += 1;
    },
    lintFiles: async (paths) => {
      lintCalls.push([...paths]);
      return [{
        filePath: join(root, 'src', 'entry.ts'),
        messages: [{
          column: 7,
          line: 3,
          message: 'Unexpected console statement.',
          ruleId: 'no-console',
          severity: 2,
        }],
      }];
    },
  };
  const service = new DiagnosticService({
    createRslint: () => {
      created += 1;
      return engine;
    },
    root,
  });

  const first = await service.lint(['src/entry.ts']);
  const second = await service.lint(['src/other.ts']);
  await service.close();
  await service.close();

  expect(first).toEqual({
    diagnostics: [{
      code: 'RSLINT/no-console',
      message: 'Unexpected console statement. (3:7)',
      severity: 'error',
      sourcePath: join(root, 'src', 'entry.ts'),
    }],
    paths: [join(root, 'src', 'entry.ts')],
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.diagnostics)).toBe(true);
  expect(created).toBe(1);
  expect(lintCalls).toEqual([
    [join(root, 'src', 'entry.ts')],
    [join(root, 'src', 'other.ts')],
  ]);
  expect(closed).toBe(1);
  expect(second.paths).toEqual([join(root, 'src', 'other.ts')]);
});
