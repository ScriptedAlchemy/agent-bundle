import { expect, it } from '@rstest/core';

import { ProjectService } from '../src/dev/project-service.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

const configSource = [
  'export default {',
  "  dev: { contracts: { fixtures: './contract-fixtures.ts', server: 'fixture' } },",
  "  plugin: { name: 'dev-contract-fixture', version: '1.0.0' },",
  '};',
  '',
].join('\n');

it('loads validated development contract fixtures into the prepared project', async () => {
  const project = await createProjectFixture({
    config: configSource,
    files: {
      'contract-fixtures.ts': [
        'export default {',
        "  'mcp:fixture/tool:version': { input: {}, resultCompat: 'closed' },",
        '};',
        '',
      ].join('\n'),
    },
  });
  try {
    const prepared = await new ProjectService({ root: project.root }).prepare('dev');

    expect(prepared.devContracts).toMatchObject({
      fixtures: {
        'mcp:fixture/tool:version': { input: {}, resultCompat: 'closed' },
      },
      modulePath: expect.stringContaining('contract-fixtures.ts'),
      server: 'fixture',
    });
    expect(prepared.devContracts?.diagnostics).toEqual([]);
  } finally {
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('retains a buildable prepared project when the fixture module shape is invalid', async () => {
  const project = await createProjectFixture({
    config: configSource,
    files: {
      'contract-fixtures.ts': 'export default [];\n',
    },
  });
  try {
    const prepared = await new ProjectService({ root: project.root }).prepare('dev');

    expect(prepared.source.state).toBe('ready');
    expect(prepared.model).toBeDefined();
    expect(prepared.devContracts).toMatchObject({
      diagnostics: [{
        code: 'AB7005',
        severity: 'error',
        sourcePath: expect.stringContaining('contract-fixtures.ts'),
      }],
      modulePath: expect.stringContaining('contract-fixtures.ts'),
      server: 'fixture',
    });
    expect(prepared.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB7005' }),
    ]));
  } finally {
    await removeProjectFixture(project.root);
  }
}, 30_000);

it('leaves development contract preparation absent when the channel is not declared', async () => {
  const project = await createProjectFixture();
  try {
    const prepared = await new ProjectService({ root: project.root }).prepare('dev');
    expect(prepared.devContracts).toBeUndefined();
  } finally {
    await removeProjectFixture(project.root);
  }
});
