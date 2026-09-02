import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import type { LifecycleReplay } from '../../src/contracts/lifecycles.ts';
import { LifecycleReplayService } from '../../src/dev/playground/lifecycle-replay-service.ts';
import { projectEventDocument } from '../../src/events/project.ts';
import { compileRouteGraph } from '../../src/routes/graph.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const createFixtureProject = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-lifecycle-replay-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({ name: 'lifecycle-replay-fixture', type: 'module' })),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      'export default async function AfterTool({ canonical }) {',
      '  return createElement(',
      '    Agent.Result,',
      '    null,',
      "    createElement(Agent.Markdown, null, `Observed ${canonical.event} from ${canonical.provenance.host}.`),",
      "    createElement(Agent.Context, null, 'Lifecycle replay context.'),",
      '  );',
      '}',
      '',
    ].join('\n')),
  ]);
  const graph = await compileRouteGraph(root, { targets: ['claude', 'codex'] } as never);
  expect(graph.events.map((route) => route.id)).toEqual(['event:tool/after']);
  return { graph, root };
};

it('replays Claude and Codex PostToolUse through decode, route execution, render, and encode', async () => {
  const { graph } = await createFixtureProject();
  const service = new LifecycleReplayService({
    prepared: () => ({ graph, targets: ['claude', 'codex'] }),
  });
  const fixtures = [
    {
      native: JSON.parse(await readFile(
        new URL('../../../../examples/rsc-agent-runtime/tests/fixtures/events/claude-post-tool-use.json', import.meta.url),
        'utf8',
      )) as Record<string, unknown>,
      source: 'fixture' as const,
      target: 'claude',
    },
    {
      native: JSON.parse(await readFile(
        new URL('../../../../examples/rsc-agent-runtime/tests/fixtures/events/codex-post-tool-use.json', import.meta.url),
        'utf8',
      )) as Record<string, unknown>,
      source: 'observed' as const,
      target: 'codex',
    },
  ];

  for (const fixture of fixtures) {
    const result = await service.replay({
      binding: {
        manifestDigest: graph.digest,
        routeId: 'event:tool/after',
        target: fixture.target,
      },
      native: fixture.native,
      source: fixture.source,
    });
    expect('diagnostics' in result).toBe(false);
    const replay = result as LifecycleReplay;
    expect(replay.source).toBe(fixture.source);
    expect(replay.binding).toEqual({
      manifestDigest: graph.digest,
      routeId: 'event:tool/after',
      target: fixture.target,
    });
    expect(replay.canonical).toMatchObject({
      event: 'tool/after',
      provenance: {
        host: fixture.target,
        hostContractRevision: expect.any(String),
        nativeEvent: 'PostToolUse',
        source: 'native',
      },
    });
    expect(replay.nativeInput).toEqual(fixture.native);
    expect(replay.requestContext).toMatchObject({
      invocationKind: 'event',
      nativeEvent: 'PostToolUse',
      routeId: 'event:tool/after',
      target: fixture.target,
    });
    expect(replay.events[0]?.type).toBe('shell');
    expect(replay.events.at(-1)?.type).toBe('complete');
    const firstSequence = replay.events[0]?.sequence ?? 0;
    expect(replay.events.map((event) => event.sequence)).toEqual(
      replay.events.map((_, index) => firstSequence + index),
    );
    expect(replay.document?.status).toBe('success');
    expect(replay.nativeResponse).toEqual(
      projectEventDocument(replay.document!, 'tool/after', fixture.target, 'PostToolUse'),
    );
    expect(replay.nativeResponse).toEqual({
      hookSpecificOutput: {
        additionalContext: 'Lifecycle replay context.',
        hookEventName: 'PostToolUse',
      },
    });
  }
});
