import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { LifecycleListResponse } from '../src/contracts/lifecycles.ts';
import type { RouteManifestResponse } from '../src/dev/routes/route-manifest.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { inspectWorkbenchSurface, workbenchLeafPath } from '../src/test/index.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

/**
 * The workbench-surface level claims to hand a consumer exactly what the dev
 * server serves the Workbench. This proves the claim against a real dev
 * server: the route manifest body and the lifecycle inventory the browser
 * would fetch are byte-equivalent to the helper's in-process projection.
 */
it('matches the route manifest and lifecycle inventory a real dev server serves', { timeout: 60_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'workbench-surface-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/cli/greet.ts': [
        "import { z } from 'zod';",
        '',
        "export const config = { description: 'Greets one name.', positionals: ['name'] };",
        "export const inputSchema = z.object({ loud: z.boolean().optional(), name: z.string().min(1) }).strict();",
        'export const resultSchema = z.object({ message: z.string() }).strict();',
        '',
        'export default async function greet({ input }) {',
        '  return { message: `Hello, ${input.name}${input.loud ? \'!\' : \'.\'}` };',
        '}',
        '',
      ].join('\n'),
      'src/events/tool/after.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        '',
        "export const config = { runtime: 'standalone' };",
        '',
        'export default async function AfterTool({ canonical }) {',
        "  return createElement(Agent.Result, null, createElement(Agent.Context, null, `Recorded ${canonical.provenance.host}.`));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/report.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1) }).strict();",
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        "  return createElement(Agent.Result, { value: { service: input.service } }, createElement(Agent.Text, null, input.service));",
        '}',
        '',
      ].join('\n'),
      'src/providers/clock.ts': [
        'export default () => ({ now: 0 });',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-workbench-surface-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Workbench surface</title>'),
  ]);
  try {
    const surface = await inspectWorkbenchSurface({ root: project.root });
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
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    try {
      await expect.poll(
        async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
        { timeout: 10_000 },
      ).toBe(200);
    } catch (error) {
      throw new Error(`Route manifest did not become ready: ${JSON.stringify(server.status())}`, { cause: error });
    }
    const [manifestResponse, lifecyclesResponse] = await Promise.all([
      fetch(`${server.url}/api/routes/manifest`, { headers }),
      fetch(`${server.url}/api/lifecycles`, { headers }),
    ]);
    expect(manifestResponse.status).toBe(200);
    expect(lifecyclesResponse.status).toBe(200);
    const served = await manifestResponse.json() as RouteManifestResponse;
    const lifecycles = await lifecyclesResponse.json() as LifecycleListResponse;

    // JSON round-trip on both sides: the wire drops `undefined` members, the
    // helper's frozen objects never carry them, and structural equality is
    // the claim.
    expect(JSON.parse(JSON.stringify(surface.manifest))).toEqual(served.manifest);
    expect(JSON.parse(JSON.stringify(surface.lifecycles))).toEqual(lifecycles.lifecycles);
    expect(surface.provenance.sourceRevision).toBe(lifecycles.manifestDigest);
    expect(surface.catalog.groups.map((group) => group.label)).toEqual([
      'status · Tools',
      'Event routes',
      'CLI commands',
    ]);
    expect(surface.catalog.groups[2]?.entries[0]?.commandUsage).toBe('greet <name> [--loud]');
    expect(surface.lifecycles).toMatchObject([{
      event: 'tool/after',
      routeId: 'event:tool/after',
      targets: [{ nativeEvent: 'PostToolUse', target: 'claude' }],
    }]);
    expect(surface.application.groups.map((group) => group.kind)).toEqual(['mcp', 'events', 'cli']);
    const leaves = surface.application.groups.flatMap((group) => group.kind === 'mcp'
      ? group.servers.flatMap((applicationServer) =>
        applicationServer.subgroups.flatMap((subgroup) => subgroup.leaves))
      : group.leaves);
    expect(leaves.map((leaf) => leaf.routeId).sort()).toEqual([
      'cli:greet',
      'event:tool/after',
      'tool:status/report',
    ]);
    expect(leaves.map(workbenchLeafPath).sort()).toEqual([
      '/routes/cli/greet',
      '/routes/events/tool/after',
      '/routes/mcp/status/tool/report',
    ]);
    expect(surface.application.leafCount).toBe(3);
    expect(surface.advanced).toEqual(['artifact', 'protocol', 'hosts', 'logs']);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
