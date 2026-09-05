import { mkdir, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterAll, expect, it } from '@rstest/core';

import { inspectWorkbenchSurface, workbenchLeafPath } from '../../src/test/index.ts';
import { createProjectFixture } from '../helpers/project-fixture.ts';

/**
 * The route-unit pool runs under `--conditions=react-server`, so a rendered
 * `SKILL.tsx` evaluated by the compiler pass used to bind the consumer's
 * client `react/jsx-runtime` to the server `react` build and throw inside
 * React (#441). The Workbench surface must inspect such a project from this
 * pool like any other harness level.
 */
const reactPackageRoot = dirname(createRequire(import.meta.url).resolve('react/package.json'));

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

it('inspects the Workbench surface of a project with a rendered skill under the react-server condition (#441)', async () => {
  expect(process.execArgv).toContain('react-server');

  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { description: 'Rendered skill under react-server.', name: 'rendered-skill-surface' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{ "name": "rendered-skill-surface", "version": "1.2.3", "type": "module" }\n',
      'src/mcp/demo/tools/ping.tsx': [
        "import React from 'react';",
        "import { Agent } from '@agent-bundle/runtime';",
        "import { z } from 'zod';",
        "export const config = { annotations: { readOnlyHint: true }, description: 'Ping.' };",
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
        'export default async function Ping() {',
        '  return <Agent.Result value={{ ok: true }}><Agent.Text>pong</Agent.Text></Agent.Result>;',
        '}',
        '',
      ].join('\n'),
      'src/skills/demo/SKILL.tsx': [
        "import { version } from 'agent-bundle/meta';",
        "import React from 'react';",
        '',
        "export const frontmatter = { description: 'Demo rendered skill.', name: 'demo' };",
        'export default () => (',
        '  <>',
        '    <h1>Demo</h1>',
        '    <p>Hello <strong>world</strong> from <code>{version}</code>.</p>',
        '  </>',
        ');',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-rendered-skill-surface-',
  });
  roots.push(project.root);
  // The skill imports `react`; the fixture resolves it to the real package so
  // the consumer-side resolution the pool condition affects is exercised.
  await mkdir(join(project.root, 'node_modules'), { recursive: true });
  await symlink(reactPackageRoot, join(project.root, 'node_modules', 'react'), 'dir');

  const surface = await inspectWorkbenchSurface({ root: project.root });

  expect(surface.catalog.diagnostics).toEqual([]);
  expect(surface.manifest.diagnostics).toEqual([]);
  expect(surface.counts).toMatchObject({ mcpServers: 1, skills: 1 });
  expect(surface.provenance).toMatchObject({ proofLevel: 'workbench-surface', targets: ['claude'] });
  const skills = surface.application.groups.find((group) => group.kind === 'skills');
  expect(skills).toMatchObject({
    leaves: [expect.objectContaining({ execution: 'document', label: 'demo' })],
  });
  if (skills?.kind !== 'skills') throw new Error('Expected a Skills application group.');
  expect(workbenchLeafPath(skills.leaves[0]!)).toBe('/routes/skills/skill%3Ademo');
});
