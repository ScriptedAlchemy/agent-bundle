import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

const requestStatus = ({
  headers,
  path,
  port,
}: {
  headers: Record<string, string>;
  path: string;
  port: number;
}): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest({ headers, hostname: '127.0.0.1', method: 'GET', path, port }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });

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
    args: [join(process.cwd(), 'dist/runtime/mcp/stdio.js')],
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
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/mcp/http.js')], {
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

    const localHost = `127.0.0.1:${startup.port}`;
    await expect(
      requestStatus({
        headers: { Host: localHost, Origin: `http://${localHost}` },
        path: '/health',
        port: startup.port,
      }),
    ).resolves.toBe(200);
    for (const path of ['/health', '/mcp']) {
      await expect(
        requestStatus({ headers: { Host: 'attacker.example' }, path, port: startup.port }),
      ).resolves.toBe(403);
      await expect(
        requestStatus({ headers: { Host: localHost, Origin: 'https://attacker.example' }, path, port: startup.port }),
      ).resolves.toBe(403);
    }
  } finally {
    await client.close();
    child.kill('SIGTERM');
    const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBe(0);
    expect(signal).toBeNull();
    await rm(join(stateFile, '..'), { force: true, recursive: true });
  }
});

test('built Streamable HTTP MCP accepts only explicitly allowed public tunnel origins', async () => {
  const stateFile = await createStateFile();
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/mcp/http.js')], {
    env: {
      ...process.env,
      AGENT_RUNTIME_ALLOWED_HOSTS: 'tunnel.example',
      AGENT_RUNTIME_ALLOWED_ORIGINS: 'https://tunnel.example',
      AGENT_RUNTIME_STATE_FILE: stateFile,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    await once(child.stderr, 'data');
    const startup = JSON.parse(stderr.trim()) as { port: number };
    await expect(
      requestStatus({
        headers: { Host: 'tunnel.example', Origin: 'https://tunnel.example' },
        path: '/health',
        port: startup.port,
      }),
    ).resolves.toBe(200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close');
    await rm(join(stateFile, '..'), { force: true, recursive: true });
  }
});

test('adds an explicit public MCP URL domain only to returned resource content', async () => {
  const stateFile = await createStateFile();
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/runtime/mcp/http.js')], {
    env: {
      ...process.env,
      AGENT_RUNTIME_PUBLIC_MCP_URL: 'https://example.com/mcp',
      AGENT_RUNTIME_STATE_FILE: stateFile,
      PORT: '0',
    },
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
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${startup.port}/mcp`)));
    const resources = await client.listResources();
    expect(resources.resources[0]._meta?.ui).not.toHaveProperty('domain');
    await expect(client.readResource({ uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' })).resolves.toMatchObject({
      contents: [{ _meta: { ui: { domain: 'c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com' } } }],
    });
  } finally {
    await client.close();
    child.kill('SIGTERM');
    await once(child, 'close');
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

test('runtime manifest declares every Node entry and dynamic chunk in its artifact root', async () => {
  const entries = ['hook/index.js', 'rsc/index.js', 'mcp/stdio.js', 'mcp/http.js'];
  const runtimeRoot = join(process.cwd(), 'dist/runtime');
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'runtime-assets.json'), 'utf8')) as {
    allFiles: string[];
  };
  const manifestFiles = manifest.allFiles.map((file) => file.replace(/^\//, ''));
  const dynamicChunkDependencies = (
    await Promise.all(
      entries.map(async (entry) => {
        const source = await readFile(join(runtimeRoot, entry), 'utf8');
        return [...source.matchAll(/__webpack_require__\.e\(\/\* import\(\) \*\/\s*(\d+)\)/g)].map((match) => ({
          chunkId: match[1],
          entry,
        }));
      }),
    )
  ).flat();

  expect(manifestFiles).toEqual(expect.arrayContaining(entries));
  expect(manifestFiles.some((file) => file.startsWith('chunks/'))).toBe(true);
  for (const file of manifestFiles) {
    await access(join(runtimeRoot, file));
  }
  for (const { chunkId } of dynamicChunkDependencies) {
    expect(manifestFiles).toContain(`chunks/${chunkId}.js`);
  }
});

test('a second multi-environment build removes stale app chunks', async () => {
  const staleAsset = join(process.cwd(), 'dist/app/static/js/async/stale.js');
  await mkdir(dirname(staleAsset), { recursive: true });
  await writeFile(staleAsset, 'stale artifact', 'utf8');

  try {
    const child = spawn('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'ignore' });
    const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBe(0);
    expect(signal).toBeNull();
    await expect(access(staleAsset)).rejects.toThrow();
    for (const name of ['edit-timeline-v1', 'standalone']) {
      const html = await readFile(join(process.cwd(), 'dist/app', `${name}.html`), 'utf8');
      expect(html).toContain('<style');
      expect(html).not.toMatch(/(?:src|href)=["'][^"']*\.(?:js|css)["']/);
    }
  } finally {
    await rm(staleAsset, { force: true });
  }
});
