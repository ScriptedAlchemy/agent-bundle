import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { RouteInvocationResponse } from '../src/dev/routes/route-invocation-result.ts';
import type { RouteInvocationListResponse } from '../src/dev/routes/route-invocation.ts';
import type { RouteManifestResponse } from '../src/dev/routes/route-manifest.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { replaceWatchedSourceAndAwaitRebuild } from './support/watched-files.ts';

const readEvent = async (response: Response, type: string): Promise<Record<string, unknown>> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error(`Project event stream ended before ${type}.`);
    buffered += next.value;
    const frames = buffered.split('\n\n');
    buffered = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.includes(`event: ${type}\n`)) continue;
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
    }
  }
};

it('invokes compiled tool and event routes through the foreground server', { timeout: 60_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'route-invocation-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/cli/greet.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { description: 'Greets one name.', positionals: ['name'] };",
        "export const inputSchema = z.object({ name: z.string().min(1) }).strict();",
        "export const resultSchema = z.object({ message: z.string() }).strict();",
        '',
        'export default async function Greet({ input }) {',
        '  const message = `Hello, ${input.name}.`;',
        '  return createElement(Agent.Result, { value: { message } }, createElement(Agent.Text, null, message));',
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
        "  return createElement(Agent.Result, null, createElement(Agent.Context, null, `Observed ${canonical.payload.toolName}.`));",
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
        "  return createElement(Agent.Result, { value: { service: input.service } }, createElement(Agent.Text, null, `Service ${input.service}`));",
        '}',
        '',
      ].join('\n'),
      'src/providers/clock.ts': [
        'export default () => ({ now: 0 });',
        '',
      ].join('\n'),
      'src/scripts/summary.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        '',
        'export default async function Summary({ argv }) {',
        "  return createElement(Agent.Result, { value: { arguments: argv } }, createElement(Agent.Text, null, 'Summary ready.'));",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route invocation</title>'),
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
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    try {
      await expect.poll(
        async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
        { timeout: 10_000 },
      ).toBe(200);
    } catch (error) {
      throw new Error(`Route manifest did not become ready: ${JSON.stringify(server.status())}`, { cause: error });
    }

    const cookie = bootstrap.headers.get('set-cookie')!.split(';', 1)[0]!;
    const stream = await fetch(`${server.url}/api/project/events`, {
      headers: { cookie, origin: server.url },
    });
    const toolResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'catalog' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(toolResponse.status).toBe(200);
    const tool = await toolResponse.json() as RouteInvocationResponse;
    expect(tool.invocation.status).toBe('succeeded');
    expect(tool.invocation.events.at(-1)?.type).toBe('complete');
    expect(tool.invocation.document).toBeDefined();
    expect(tool.invocation.projection.mcp).toBeDefined();
    expect(tool.invocation.providers).toEqual([
      expect.objectContaining({ name: 'clock', status: 'unobserved' }),
    ]);
    expect(tool.invocation.providers[0]).not.toHaveProperty('durationMs');
    expect(tool.invocation.timings.map((entry) => entry.phase)).toEqual(['render', 'projection']);

    const eventResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        event: { host: 'claude' },
        input: {
          cwd: project.root,
          hook_event_name: 'PostToolUse',
          session_id: 'session-1',
          tool_input: {},
          tool_name: 'Write',
          tool_response: { ok: true },
          tool_use_id: 'use-1',
          transcript_path: join(project.root, 'transcript.json'),
        },
        routeId: 'event:tool/after',
      }),
      headers,
      method: 'POST',
    });
    const eventFailure = eventResponse.status === 200 ? undefined : await eventResponse.clone().text();
    expect(eventResponse.status, eventFailure).toBe(200);
    const event = await eventResponse.json() as RouteInvocationResponse;
    expect(event.invocation.status).toBe('succeeded');
    expect(event.invocation.events.at(-1)?.type).toBe('complete');
    expect(event.invocation.document).toBeDefined();
    expect(event.invocation.projection.hosts?.[0]).toMatchObject({ host: 'claude' });

    const cliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { name: 'Ada' }, routeId: 'cli:greet' }),
      headers,
      method: 'POST',
    });
    expect(cliResponse.status).toBe(200);
    const cli = await cliResponse.json() as RouteInvocationResponse;
    expect(cli.invocation).toMatchObject({
      kind: 'cli',
      projection: {
        cli: {
          exitCode: 0,
          text: expect.stringContaining('Hello, Ada.'),
        },
      },
      result: { message: 'Hello, Ada.' },
      status: 'succeeded',
    });

    const scriptResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'script:summary' }),
      headers,
      method: 'POST',
    });
    expect(scriptResponse.status).toBe(200);
    const script = await scriptResponse.json() as RouteInvocationResponse;
    expect(script.invocation).toMatchObject({
      kind: 'script',
      projection: {
        cli: {
          exitCode: 0,
          text: expect.stringContaining('Summary ready.'),
        },
      },
      status: 'succeeded',
    });

    const listedResponse = await fetch(`${server.url}/api/routes/invocations?limit=4`, { headers });
    const listed = await listedResponse.json() as RouteInvocationListResponse;
    expect(listed.invocations.map((invocation) => invocation.id)).toEqual([
      script.invocation.id,
      cli.invocation.id,
      event.invocation.id,
      tool.invocation.id,
    ]);
    const read = await fetch(`${server.url}/api/routes/invocations/${tool.invocation.id}`, { headers });
    await expect(read.json()).resolves.toEqual(tool);

    const published = await readEvent(stream, 'route.invocation');
    expect(published).toMatchObject({
      payload: { invocation: { routeId: 'tool:status/report', status: 'succeeded' } },
      type: 'route.invocation',
    });

    const shell = await fetch(`${server.url}/routes/mcp/status/tool/report`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>Route invocation</title>');

    const reportRoutePath = join(project.root, 'src/mcp/status/tools/report.tsx');
    const failedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        "import './missing.js';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1) }).strict();",
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  const service = `rebuilt-${input.service}`;',
        '  return createElement(Agent.Result, { value: { service } }, createElement(Agent.Text, null, `Service ${service}`));',
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 10_000 },
    );
    expect(failedAttempt.outcome).toBe('failed');
    expect(server.status().build.state).toBe('failed');

    const staleManifestResponse = await fetch(`${server.url}/api/routes/manifest`, { headers });
    const staleManifest = await staleManifestResponse.json() as RouteManifestResponse;
    const staleRouteIds = staleManifest.manifest.servers.flatMap((manifestServer) =>
      manifestServer.routes.map((route) => route.id));
    expect(staleRouteIds).toContain('tool:status/report');

    const staleInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'published' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(staleInvocationResponse.status).toBe(409);
    await expect(staleInvocationResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'The source is newer than the published build. Rebuild before invoking routes.',
      },
    });

    const repairedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1) }).strict();",
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  const service = `rebuilt-${input.service}`;',
        '  return createElement(Agent.Result, { value: { service } }, createElement(Agent.Text, null, `Service ${service}`));',
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 10_000 },
    );
    expect(repairedAttempt.outcome).toBe('succeeded');
    const repairedInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'published' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(repairedInvocationResponse.status).toBe(200);
    const repairedInvocation = await repairedInvocationResponse.json() as RouteInvocationResponse;
    expect(repairedInvocation.invocation).toMatchObject({
      result: { service: 'rebuilt-published' },
      status: 'succeeded',
    });

    const missingApi = await fetch(`${server.url}/api/nope`);
    expect(missingApi.status).toBe(404);
    await expect(missingApi.json()).resolves.toEqual({
      diagnostic: { code: 'AB8007', message: 'Route was not found.' },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('publishes invocation routes only after a successful initial or recovered build', { timeout: 90_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'route-invocation-publication-gate', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/mcp/status/tools/report.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        "import './missing.js';",
        '',
        "export const inputSchema = z.object({}).strict();",
        'export const resultSchema = z.object({ version: z.string() }).strict();',
        '',
        'export default async function Report() {',
        "  return createElement(Agent.Result, { value: { version: 'published' } }, createElement(Agent.Text, null, 'Published route.'));",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-publication-gate-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const reportRoutePath = join(project.root, 'src/mcp/status/tools/report.tsx');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route publication gate</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    let bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    let session = await bootstrap.json() as { readonly token: string };
    let headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };

    await expect.poll(
      () => server!.status().build.state,
      { timeout: 10_000 },
    ).toBe('failed');
    const unavailableManifest = await fetch(`${server.url}/api/routes/manifest`, { headers });
    expect(unavailableManifest.status).toBe(409);
    const unavailableInvocation = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(unavailableInvocation.status).toBe(409);
    await expect(unavailableInvocation.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'No published build and route manifest are available.',
      },
    });

    const repairedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ version: z.string() }).strict();',
        '',
        'export default async function Report() {',
        "  return createElement(Agent.Result, { value: { version: 'published' } }, createElement(Agent.Text, null, 'Published route.'));",
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 10_000 },
    );
    expect(repairedAttempt.outcome, JSON.stringify(repairedAttempt.diagnostics)).toBe('succeeded');
    const publishedInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(publishedInvocationResponse.status).toBe(200);
    const publishedInvocation = await publishedInvocationResponse.json() as RouteInvocationResponse;
    expect(publishedInvocation.invocation).toMatchObject({
      result: { version: 'published' },
      status: 'succeeded',
    });

    await server.close();
    server = undefined;
    await writeFile(reportRoutePath, [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "import './missing.js';",
      '',
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ version: z.string() }).strict();',
      '',
      'export default async function Report() {',
      "  return createElement(Agent.Result, { value: { version: 'unpublished' } }, createElement(Agent.Text, null, 'Unpublished route.'));",
      '}',
      '',
    ].join('\n'));
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    session = await bootstrap.json() as { readonly token: string };
    headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };

    expect(server.status().artifact.state).toBe('stale');
    const recoveredManifestResponse = await fetch(`${server.url}/api/routes/manifest`, { headers });
    expect(recoveredManifestResponse.status).toBe(409);
    await expect(recoveredManifestResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8121',
        message: 'Route manifest is not available.',
      },
    });
    const recoveredInvocation = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(recoveredInvocation.status).toBe(409);
    await expect(recoveredInvocation.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'No published build and route manifest are available.',
      },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
