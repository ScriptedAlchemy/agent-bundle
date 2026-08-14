import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@rstest/core';

import { createFileRuntimeKernel } from '../src/runtime/state-file.js';

const createStateFile = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-mcp-'));
  const stateFile = join(directory, 'events.jsonl');
  const kernel = createFileRuntimeKernel({
    stateFile,
    createId: () => 'seed-edit',
    now: () => new Date('2026-08-14T10:24:31.000Z'),
  });

  await kernel.recordEdit({
    host: 'claude',
    path: 'src/runtime/state.ts',
    sessionId: 'seed-session',
    toolName: 'Write',
  });
  return stateFile;
};

const createClient = (): Client =>
  new Client({ name: 'rsc-agent-runtime-test', version: '1.0.0' });

const expectStaticSurface = async (client: Client) => {
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual([
    'recent_edits',
    'render_edit_timeline',
    'runtime_status',
  ]);
  expect(tools.tools).toMatchObject([
    { name: 'recent_edits', _meta: {} },
    {
      name: 'render_edit_timeline',
      _meta: {
        'openai/outputTemplate': 'ui://rsc-agent-runtime/edit-timeline-v1.html',
        ui: { resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
      },
    },
    { name: 'runtime_status', _meta: {} },
  ]);

  const resources = await client.listResources();
  expect(resources.resources).toMatchObject([
    {
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        'openai/widgetDescription': 'Interactive timeline of file edits recorded by agent hooks.',
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          prefersBorder: true,
        },
      },
      uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
    },
  ]);
};

test('built stdio MCP serves static tools, file-backed data, Flight results, and inline widget', async () => {
  const stateFile = await createStateFile();
  const client = createClient();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/mcp/stdio.js')],
    env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    await expectStaticSurface(client);

    await expect(client.callTool({ name: 'recent_edits', arguments: { limit: 10 } })).resolves.toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { edits: [{ eventId: 'seed-edit' }], stateVersion: 1 },
    });
    await expect(client.callTool({ name: 'render_edit_timeline', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { edits: [{ eventId: 'seed-edit' }], stateVersion: 1 },
    });
    const runtimeStatus = await client.callTool({ name: 'runtime_status', arguments: {} });
    expect(runtimeStatus.structuredContent).toMatchObject({ editCount: 1, stateVersion: 1 });
    expect(runtimeStatus.content).toContainEqual({
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      mimeType: 'image/png',
      type: 'image',
    });
    await expect(
      client.readResource({ uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' }),
    ).resolves.toMatchObject({
      contents: [
        {
          mimeType: 'text/html;profile=mcp-app',
          _meta: {
            'openai/widgetDescription': 'Interactive timeline of file edits recorded by agent hooks.',
            ui: {
              csp: { connectDomains: [], resourceDomains: [] },
              prefersBorder: true,
            },
          },
          text: expect.stringContaining('<script'),
          uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
        },
      ],
    });
  } finally {
    await client.close();
    await rm(join(stateFile, '..'), { force: true, recursive: true });
  }
});

test('built Streamable HTTP MCP reports its one JSON startup line and closes cleanly', async () => {
  const stateFile = await createStateFile();
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/mcp/http.js')], {
    env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const client = createClient();
  try {
    await once(child.stderr, 'data');
    const startup = JSON.parse(stderr.trim()) as { port: number };
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${startup.port}/mcp`));
    await client.connect(transport);
    await expectStaticSurface(client);
  } finally {
    await client.close();
    child.kill('SIGTERM');
    const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBe(0);
    expect(signal).toBeNull();
    await rm(join(stateFile, '..'), { force: true, recursive: true });
  }
});

test('built widget HTML is self-contained without external app bundle assets', async () => {
  for (const name of ['edit-timeline-v1', 'standalone']) {
    const artifact = join(process.cwd(), 'dist/app', `${name}.html`);
    await access(artifact);
    const html = await readFile(artifact, 'utf8');
    expect(html).toContain('<script');
    expect(html).toContain('<style');
    expect(html).not.toMatch(/(?:src|href)=["'][^"']*\.js["']/);
    expect(html).not.toMatch(/(?:src|href)=["'][^"']*\.css["']/);
  }
});
