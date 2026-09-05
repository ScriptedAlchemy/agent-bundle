import { execFile as executeFile } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

import { availablePort } from './support/available-port.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');
const appRendererLicense = join('src', 'mcp', 'APP-RENDERER-LICENSE');
let built: Promise<void> | undefined;

const buildPackage = async (): Promise<void> => {
  if (process.env['AGENT_BUNDLE_PACKAGE_PREBUILT'] === '1') return;
  built ??= execFile('pnpm', ['build'], { cwd: workspaceRoot }).then(() => undefined);
  await built;
};

describe.sequential('workbench package build', () => {
it('copies stable prebuilt workbench assets and the exact app-renderer license into the package distribution', async () => {
  await buildPackage();

  await expect(access(join(packageRoot, 'dist', 'workbench', 'index.html'))).resolves.toBeUndefined();
  await expect(readFile(join(packageRoot, 'dist', 'workbench', 'static', 'js', 'index.js'), 'utf8')).resolves.toContain('Workbench navigation');
  await expect(readFile(join(packageRoot, 'dist', 'workbench', 'THIRD_PARTY_NOTICES'), 'utf8')).resolves.toContain('MCP Inspector');
  await expect(readFile(join(packageRoot, 'dist', 'workbench', appRendererLicense), 'utf8')).resolves.toBe(
    await readFile(join(workbenchRoot, appRendererLicense), 'utf8'),
  );
}, 60_000);

it('prunes stale copied workbench assets without removing the package library output', async () => {
  await buildPackage();
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-prune-'));
  const isolatedDist = join(isolatedRoot, 'dist');
  try {
    await cp(join(packageRoot, 'dist'), isolatedDist, { recursive: true });
    const workbench = join(isolatedDist, 'workbench');
    const stale = join(workbench, 'static', 'js', 'async', 'stale-nested.js');
    await mkdir(join(workbench, 'static', 'js', 'async'), { recursive: true });
    await writeFile(stale, 'obsolete workbench output\n');
    await expect(access(stale)).resolves.toBeUndefined();
    // installedEnvironment() gives this build its own persistent-cache
    // directory: packed-consumer rebuilds the same config from another
    // worker, and Rslib keys the shared default by the config root.
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'rslib'), [
      'build',
      '--config', join(packageRoot, 'rslib.config.ts'),
      '--dist-path', isolatedDist,
    ], { cwd: workspaceRoot, env: installedEnvironment() });
    await expect(access(stale)).rejects.toThrow();
    await expect(access(join(isolatedDist, 'cli.js'))).resolves.toBeUndefined();
    expect(await readdir(workbench, { recursive: true })).not.toContain('index.js.map');
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
}, 60_000);

it('serves prebuilt workbench assets from an installed tarball without the repository source tree', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-consumer-'));
  const project = join(consumer, 'project');
  try {
    const listing = await execFile('tar', ['-tf', tarball]);
    expect(listing.stdout).toContain('package/dist/workbench/index.html');
    expect(listing.stdout).toContain('package/dist/workbench/THIRD_PARTY_NOTICES');
    expect(listing.stdout).toContain('package/dist/workbench/src/mcp/APP-RENDERER-LICENSE');
    expect(listing.stdout).not.toMatch(/package\/dist\/workbench\/.*\.map$/mu);
    expect(listing.stdout).not.toMatch(/package\/dist\/workbench\/.*-[a-f0-9]{8,}/iu);

    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', ...cachedNpmInstallArguments, tarball], { cwd: consumer, env: installedEnvironment() });
    await mkdir(join(project, 'skills', 'review'), { recursive: true });
    await Promise.all([
      writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(project, 'agent-bundle.config.ts'), "export default { plugin: { name: 'packed-workbench', version: '1.0.0' }, targets: ['portable'] };\n"),
      writeFile(join(project, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Reviews changes\n---\n# Review\n'),
    ]);

    const script = [
      "import { startDevServer } from 'agent-bundle';",
      `const session = await startDevServer({ open: false, root: ${JSON.stringify(project)} });`,
      'try {',
      '  const response = await fetch(session.url);',
      '  console.log(JSON.stringify({ body: await response.text(), status: response.status }));',
      '} finally { await session.close(); }',
    ].join('\n');
    const served = await execFile(process.execPath, ['--input-type=module', '--eval', script], { cwd: consumer, env: installedEnvironment() });
    expect(JSON.parse(served.stdout)).toMatchObject({
      body: expect.stringContaining('Agent Bundle workbench'),
      status: 200,
    });
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 60_000);

it('packages both react-server render children and renders a route invocation from an installed tarball', async () => {
  await buildPackage();
  await expect(access(join(packageRoot, 'dist', 'lifecycle-render-child.js'))).resolves.toBeUndefined();
  await expect(access(join(packageRoot, 'dist', 'route-invocation-child.js'))).resolves.toBeUndefined();

  const [agentBundle, runtime, markdownStream] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
  ]);
  const listing = await execFile('tar', ['-tf', agentBundle.tarball]);
  expect(listing.stdout).toContain('package/dist/lifecycle-render-child.js');
  expect(listing.stdout).toContain('package/dist/route-invocation-child.js');

  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-route-invocation-consumer-'));
  const project = join(consumer, 'project');
  try {
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', ...cachedNpmInstallArguments,
      agentBundle.tarball,
      runtime.tarball,
      markdownStream.tarball,
      'react@19.2.8',
      'react-dom@19.2.8',
      'zod@4.4.3',
    ], { cwd: consumer, env: installedEnvironment() });
    await mkdir(join(project, 'src', 'mcp', 'status', 'tools'), { recursive: true });
    await Promise.all([
      writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(project, 'agent-bundle.config.ts'), "export default { plugin: { name: 'packed-route-invocation', version: '1.0.0' }, targets: ['claude'] };\n"),
      writeFile(join(project, 'src', 'mcp', 'status', 'tools', 'report.tsx'), [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        'export const inputSchema = z.object({ service: z.string().min(1) }).strict();',
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  return createElement(Agent.Result, { value: { service: input.service } }, createElement(Agent.Text, null, `Service ${input.service}`));',
        '}',
        '',
      ].join('\n')),
    ]);

    const script = [
      "import { startDevServer } from 'agent-bundle';",
      `const session = await startDevServer({ open: false, port: 0, root: ${JSON.stringify(project)} });`,
      'try {',
      "  const bootstrap = await fetch(`${session.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });",
      '  const { token } = await bootstrap.json();',
      "  const headers = { 'content-type': 'application/json', origin: session.url, 'x-agent-bundle-session': token };",
      '  const deadline = Date.now() + 60_000;',
      '  while ((await fetch(`${session.url}/api/routes/manifest`, { headers })).status !== 200) {',
      "    if (Date.now() > deadline) throw new Error('The route manifest never became available.');",
      '    await new Promise((resolve) => setTimeout(resolve, 250));',
      '  }',
      '  const response = await fetch(`${session.url}/api/routes/invocations`, {',
      "    body: JSON.stringify({ input: { service: 'catalog' }, routeId: 'tool:status/report' }),",
      '    headers,',
      "    method: 'POST',",
      '  });',
      '  console.log(JSON.stringify({ body: await response.json(), status: response.status }));',
      '} finally { await session.close(); }',
    ].join('\n');
    const invoked = await execFile(process.execPath, ['--input-type=module', '--eval', script], { cwd: consumer, env: installedEnvironment() });
    expect(JSON.parse(invoked.stdout)).toMatchObject({
      body: {
        invocation: {
          diagnostics: [],
          projection: { mcp: { structuredContent: { service: 'catalog' } } },
          result: { service: 'catalog' },
          status: 'succeeded',
        },
      },
      status: 200,
    });
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 180_000);

it('runs the Agent API from an omit-dev installed tarball with its runtime MCP dependencies', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-agent-api-consumer-'));
  const project = join(consumer, 'project');
  try {
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', '--omit=dev', ...cachedNpmInstallArguments, tarball], { cwd: consumer, env: installedEnvironment() });
    await mkdir(join(project, 'skills', 'review'), { recursive: true });
    await Promise.all([
      writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(project, 'agent-bundle.config.ts'), "export default { plugin: { name: 'packed-agent-api', version: '1.0.0' }, targets: ['portable'] };\n"),
      writeFile(join(project, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Reviews changes\n---\n# Review\n'),
    ]);
    const port = await availablePort();
    const script = [
      "import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
      "import { toNodeHandler } from '@modelcontextprotocol/node';",
      "import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';",
      "import { startDevServer } from 'agent-bundle';",
      `const session = await startDevServer({ agentApi: true, open: false, port: ${port}, root: ${JSON.stringify(project)} });`,
      "const client = new Client({ name: 'packed-agent-api-client', version: '1.0.0' });",
      "const transport = new StreamableHTTPClientTransport(new URL(`${session.url}/mcp`), { authProvider: { token: async () => process.env.AGENT_BUNDLE_AGENT_API_TOKEN } });",
      'try {',
      '  await client.connect(transport);',
      "  const status = await client.callTool({ name: 'project_status' });",
      '  console.log(JSON.stringify({',
      "    runtime: [typeof McpServer, typeof createMcpHandler, typeof toNodeHandler],",
      '    status: status.structuredContent,',
      '  }));',
      '} finally {',
      '  await client.close();',
      '  await session.close();',
      '}',
    ].join('\n');
    const result = await execFile(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: consumer,
      env: { ...installedEnvironment(), AGENT_BUNDLE_AGENT_API_TOKEN: 'packed-agent-api-token' },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      runtime: ['function', 'function', 'function'],
      status: expect.objectContaining({ status: expect.any(Object) }),
    });
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 60_000);
});
