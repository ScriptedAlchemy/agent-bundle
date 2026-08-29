import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

import { createRsbuild } from '@rsbuild/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@rstest/core';

import { createFileRuntimeKernel } from '../src/runtime/state-file.js';
import { createRscRuntimeRsbuildConfig } from '../rsbuild.config.js';

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
    idempotencyKey: 'test:mcp-transport:seed-1',
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

test('implicit hook and MCP callers share one external workspace identity', async () => {
  const runtimeRoot = join(process.cwd(), 'dist/runtime');
  const workspace = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-shared-workspace-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-shared-state-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.AGENT_RUNTIME_STATE_FILE;
  environment.XDG_STATE_HOME = stateHome;

  const hook = spawn(process.execPath, [join(runtimeRoot, 'hook/index.js'), '--host', 'codex'], {
    cwd: workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hook.stdin.end(JSON.stringify({
    cwd: workspace,
    event_id: 'shared-fallback-event',
    hook_event_name: 'PostToolUse',
    session_id: 'shared-session',
    tool_input: { command: '*** Begin Patch\n*** Add File: shared.txt\n+shared\n*** End Patch' },
    tool_name: 'apply_patch',
  }));
  const hookStderr: Buffer[] = [];
  hook.stderr.on('data', (chunk: Buffer) => hookStderr.push(chunk));
  hook.stdout.resume();
  const [hookExit] = (await once(hook, 'close')) as [number | null, NodeJS.Signals | null];
  expect(hookExit, Buffer.concat(hookStderr).toString('utf8')).toBe(0);

  const client = createClient();
  const transport = new StdioClientTransport({
    args: [join(runtimeRoot, 'mcp/stdio.js')],
    command: process.execPath,
    cwd: workspace,
    env: environment,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await expect(client.callTool({ name: 'recent_edits', arguments: { limit: 10 } })).resolves.toMatchObject({
      structuredContent: {
        edits: [{ eventId: expect.any(String), path: join(workspace, 'shared.txt') }],
        stateVersion: 1,
      },
    });
    await expect(access(join(workspace, '.agent-runtime-demo'))).rejects.toThrow();
  } finally {
    await client.close();
    await Promise.all([
      rm(workspace, { force: true, recursive: true }),
      rm(stateHome, { force: true, recursive: true }),
    ]);
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

test('production and development runtime graphs exclude state test controls', async () => {
  const forbidden = [
    'state-file-test-support',
    'createFileRuntimeKernelForTesting',
    'RuntimeStateTestAdapter',
    'beforeAppend',
    'criticalSectionMs',
  ];
  const readRuntimeSources = async (root: string): Promise<string> => {
    const sources: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.map')) sources.push(await readFile(path, 'utf8'));
      }
    };
    await visit(root);
    return sources.join('\n');
  };
  const assertExcluded = (source: string): void => {
    for (const name of forbidden) expect(source).not.toContain(name);
  };

  assertExcluded(await readRuntimeSources(join(process.cwd(), 'dist/runtime')));
  for (const host of ['claude', 'codex']) {
    const packagedRuntime = join(process.cwd(), 'dist/plugins', host, 'runtime');
    assertExcluded(await readRuntimeSources(packagedRuntime));
    await expect(import(pathToFileURL(join(packagedRuntime, 'state-file-test-support.js')).href)).rejects.toThrow();
  }

  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-state-graph-'));
  const rsbuild = await createRsbuild({
    config: createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' }),
    cwd: process.cwd(),
  });
  let closeBuild = async (): Promise<void> => undefined;
  try {
    const result = await rsbuild.build();
    closeBuild = result.close;
    expect(result.stats).toBeDefined();
    assertExcluded(JSON.stringify(result.stats?.toJson({ all: false, children: true, modules: true, source: true })));
    assertExcluded(await readRuntimeSources(join(compilerRoot, 'rsc')));
  } finally {
    await closeBuild();
    await rm(compilerRoot, { force: true, recursive: true });
  }
});
