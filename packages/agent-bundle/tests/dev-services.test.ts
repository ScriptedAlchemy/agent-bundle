import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

it('retains the resolved configuration path in the prepared project', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  try {
    const prepared = await new ProjectService({ root }).prepare('build');

    expect(Object.getOwnPropertyDescriptor(prepared, 'configPath')?.value).toBe(
      join(root, 'agent-bundle.config.ts'),
    );
    expect(prepared.configDigest).toBe(
      createHash('sha256').update(await readFile(join(root, 'agent-bundle.config.ts'))).digest('hex'),
    );
    expect(prepared.sourceInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-bundle.config.ts' }),
      expect.objectContaining({ path: 'skills/review/SKILL.md' }),
    ]));
    expect(Object.isFrozen(prepared.sourceInputs)).toBe(true);
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

it('derives source revisions from authored bytes, including resources and invalid Skill content', async () => {
  const skillMarkdown = [
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    '[Guide](guide.txt)',
    '',
  ].join('\n');
  const root = await createProject(skillMarkdown);
  const equivalentRoot = await createProject(skillMarkdown);
  const invalidRoot = await createProject('# First invalid skill\n');
  try {
    await Promise.all([
      writeFile(join(root, 'skills', 'review', 'guide.txt'), 'one'),
      writeFile(join(equivalentRoot, 'skills', 'review', 'guide.txt'), 'one'),
    ]);
    const initial = await new ProjectService({ root }).prepare('build');
    const equivalentInitial = await new ProjectService({ root: equivalentRoot }).prepare('build');
    await writeFile(join(root, 'skills', 'review', 'guide.txt'), 'two');
    const resourceChanged = await new ProjectService({ root }).prepare('build');
    await writeFile(join(equivalentRoot, 'skills', 'review', 'guide.txt'), 'two');
    const equivalentChanged = await new ProjectService({ root: equivalentRoot }).prepare('build');

    const invalidInitial = await new ProjectService({ root: invalidRoot }).prepare('build');
    await writeFile(join(invalidRoot, 'skills', 'review', 'SKILL.md'), '# Second invalid skill\n');
    const invalidChanged = await new ProjectService({ root: invalidRoot }).prepare('build');

    expect(initial.source.revision).toBe(equivalentInitial.source.revision);
    expect(resourceChanged.source.revision).toBe(equivalentChanged.source.revision);
    expect(resourceChanged.source.revision).not.toBe(initial.source.revision);
    expect(invalidInitial.source.state).toBe('invalid');
    expect(invalidChanged.source.state).toBe('invalid');
    expect(invalidChanged.source.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      invalidInitial.source.diagnostics.map((diagnostic) => diagnostic.code),
    );
    expect(invalidChanged.source.revision).not.toBe(invalidInitial.source.revision);
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(equivalentRoot, { force: true, recursive: true }),
      rm(invalidRoot, { force: true, recursive: true }),
    ]);
  }
});

it('derives source revisions from the broad authored project graph while excluding generated and dependency trees', async () => {
  const root = await createProject([
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    'Review the changed files.',
    '',
  ].join('\n'));
  try {
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'dist'), { recursive: true }),
      mkdir(join(root, 'node_modules', 'dependency'), { recursive: true }),
      mkdir(join(root, '.agent-bundle'), { recursive: true }),
      mkdir(join(root, '.git'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'src', 'entry.ts'), "import { value } from './shared.ts';\nexport { value };\n"),
      writeFile(join(root, 'src', 'shared.ts'), 'export const value = 1;\n'),
      writeFile(join(root, 'dist', 'generated.js'), 'first\n'),
      writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'first\n'),
      writeFile(join(root, '.agent-bundle', 'active-epoch.json'), 'first\n'),
      writeFile(join(root, '.git', 'HEAD'), 'first\n'),
    ]);

    const initial = await new ProjectService({ root }).prepare('build');
    await writeFile(join(root, 'src', 'shared.ts'), 'export const value = 2;\n');
    const importedSourceChanged = await new ProjectService({ root }).prepare('build');
    await Promise.all([
      writeFile(join(root, 'dist', 'generated.js'), 'second\n'),
      writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'second\n'),
      writeFile(join(root, '.agent-bundle', 'active-epoch.json'), 'second\n'),
      writeFile(join(root, '.git', 'HEAD'), 'second\n'),
    ]);
    const excludedOnlyChanged = await new ProjectService({ root }).prepare('build');

    expect(importedSourceChanged.source.revision).not.toBe(initial.source.revision);
    expect(excludedOnlyChanged.source.revision).toBe(importedSourceChanged.source.revision);
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

it('shares a failed engine close with concurrent and later callers', async () => {
  const failure = new Error('engine shutdown failed');
  let closeCalls = 0;
  let rejectClose: (reason: Error) => void = () => undefined;
  const engine: RslintEngine = {
    close: () => {
      closeCalls += 1;
      return new Promise<void>((_resolve, reject) => {
        rejectClose = reject as (reason: Error) => void;
      });
    },
    lintFiles: async () => [],
  };
  const service = new DiagnosticService({
    createRslint: () => engine,
    root: '/workspace/project',
  });
  await service.lint(['src/entry.ts']);

  const first = service.close();
  const second = service.close();
  rejectClose(failure);
  const observed = await Promise.all([
    first.then(() => undefined, (error: unknown) => error),
    second.then(() => undefined, (error: unknown) => error),
  ]);
  const later = service.close();
  const laterError = await later.then(() => undefined, (error: unknown) => error);

  expect(closeCalls).toBe(1);
  expect(first).toBe(second);
  expect(later).toBe(first);
  expect(observed).toEqual([failure, failure]);
  expect(laterError).toBe(failure);
});
