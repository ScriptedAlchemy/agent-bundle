import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import type { LifecycleListResponse, LifecycleReplay } from '../src/contracts/lifecycles.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

it('renders a lifecycle replay through a real default-pool dev server', { timeout: 30_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'lifecycle-replay-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"type":"module"}\n',
      'src/events/tool/after.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        '',
        "export const config = { runtime: 'standalone' };",
        '',
        'export default async function AfterTool({ canonical, native }) {',
        "  return createElement(Agent.Result, null, createElement(Agent.Context, null, `Recorded ${native.tool_input.file_path} from ${canonical.provenance.host}.`));",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-lifecycle-replay-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Lifecycle replay</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(bootstrap.status).toBe(200);
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': token,
    };
    try {
      await expect.poll(
        async () => fetch(`${server!.url}/api/lifecycles`, { headers }).then((response) => response.status),
        { timeout: 10_000 },
      ).toBe(200);
    } catch (error) {
      throw new Error(`Lifecycle list did not become ready: ${JSON.stringify(server.status())}`, { cause: error });
    }
    const listedResponse = await fetch(`${server.url}/api/lifecycles`, { headers });
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json() as LifecycleListResponse;
    const lifecycle = listed.lifecycles.find((candidate) => candidate.routeId === 'event:tool/after');
    const target = lifecycle?.targets.find((candidate) => candidate.target === 'claude');
    if (lifecycle === undefined || target?.fixture === undefined) {
      throw new Error(`Expected the Claude tool/after lifecycle fixture, received ${JSON.stringify(listed)}.`);
    }

    const replayedResponse = await fetch(`${server.url}/api/lifecycles/replays`, {
      body: JSON.stringify({
        binding: {
          manifestDigest: listed.manifestDigest,
          routeId: lifecycle.routeId,
          target: target.target,
        },
        native: target.fixture.native,
        source: 'fixture',
      }),
      headers,
      method: 'POST',
    });
    const replayed = await replayedResponse.json() as { readonly replay?: LifecycleReplay };
    expect(replayedResponse.status).toBe(200);
    expect(replayed.replay).toMatchObject({
      canonical: {
        event: 'tool/after',
        provenance: { host: 'claude', nativeEvent: 'PostToolUse' },
      },
      events: [
        { sequence: 0, type: 'shell' },
        { sequence: 1, type: 'complete' },
      ],
      nativeResponse: {
        hookSpecificOutput: {
          additionalContext: expect.stringMatching(/^Recorded .* from claude\.$/u),
          hookEventName: 'PostToolUse',
        },
      },
      requestContext: {
        actor: { reason: 'not-provided', state: 'unavailable' },
        host: { source: 'receipt', state: 'available', value: { name: 'claude' } },
        invocation: {
          kind: 'event',
          operationId: 'event:tool/after',
          surface: 'tool/after',
        },
      },
      source: 'fixture',
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
