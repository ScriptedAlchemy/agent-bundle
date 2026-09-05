import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { build } from '../src/api.ts';
import {
  eventRuntimeEndpoint,
  requestEventRuntime,
  requestEventRuntimeStatus,
} from '../src/events/ipc.ts';
import { eventuallyPasses } from './support/eventually.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const runHook = async (
  entry: string,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<NodeJS.ProcessEnv> = {},
): Promise<Readonly<Record<string, unknown>> | undefined> => new Promise((resolve, reject) => {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, [entry], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) {
      reject(new Error(stderr));
      return;
    }
    resolve(stdout === '' ? undefined : JSON.parse(stdout) as Readonly<Record<string, unknown>>);
  });
  child.stdin.end(JSON.stringify(input));
});

it('lists and calls a generated filesystem tool through final-only Flight', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-routes-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-routes-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-routes-fixture', version: '1.0.0' }, targets: ['portable'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/resources/catalog.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Read the catalog.', mimeType: 'application/json', uri: 'catalog://books' };",
      "export const inputSchema = z.object({ uri: z.string() }).strict();",
      "export const resultSchema = z.object({ contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })) }).strict();",
      'export default async function Catalog({ input }) {',
      "  const result = { contents: [{ mimeType: 'application/json', text: '{\"books\":1}', uri: input.uri }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Catalog ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/prompts/curate.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Curate one genre.' };",
      "export const inputSchema = z.object({ genre: z.string() }).strict();",
      "export const resultSchema = z.object({ messages: z.array(z.object({ content: z.object({ text: z.string(), type: z.literal('text') }), role: z.literal('user') })) }).strict();",
      'export default async function Curate({ input }) {',
      "  const result = { messages: [{ content: { text: `Curate ${input.genre}`, type: 'text' }, role: 'user' }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Prompt ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/apps/dashboard.ts', [
      "export const config = { resourceUri: 'ui://curator/dashboard.html' };",
      "document.body.textContent = 'Curator dashboard';",
      '',
    ].join('\n')),
    // Authored as JSX with no React import, the way the documented route
    // contract reads: the build has to select the automatic JSX runtime, or
    // the emitted module calls a `React` factory that is not in scope.
    writeProjectFile(root, 'src/mcp/curator/tools/inspect.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Inspect one source.' };",
      "export const inputSchema = z.object({ source: z.string() }).strict();",
      "export const resultSchema = z.object({ actor: z.unknown(), host: z.unknown(), invocationKind: z.literal('tool'), lineage: z.unknown(), session: z.unknown(), source: z.string(), workspace: z.unknown() }).strict();",
      'export default async function Inspect({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  const result = { actor: context.actor, host: context.host, invocationKind: context.invocation.kind, lineage: context.lineage, session: context.session, source: input.source, workspace: context.workspace };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Markdown>{`Inspected **${input.source}**.`}</Agent.Markdown>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const generatedTypes = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(generatedTypes).toContain('tool:curator/inspect');
  expect(generatedTypes).toContain('resource:curator/catalog');
  expect(generatedTypes).toContain('prompt:curator/curate');
  const server = compiled.model.mcpServers[0];
  expect(server).toMatchObject({ id: 'mcp:curator', name: 'curator' });
  const entry = join(output, server!.args![0]!);
  const worker = entry.replace(/\.mjs$/u, '-flight.mjs');
  const statelessSources = await Promise.all([entry, worker].map((path) => readFile(path, 'utf8')));
  for (const source of statelessSources) {
    for (const forbidden of [
      '@agent-bundle/runtime/mount',
      'createGeneratedRuntimeState',
      'node:sqlite',
      'createSqliteStateDriver',
      'noticeLedger: bindings.noticeLedger',
      '@agent-bundle/runtime/notices/inbox-route',
      'agent-bundle:notice-inbox',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  }
  const client = new Client({ name: 'generated-route-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
    }
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ annotations: { readOnlyHint: true }, description: 'Inspect one source.', name: 'inspect' }],
    });
    const inspected = await client.callTool({ arguments: { source: 'library' }, name: 'inspect' }, { signal: AbortSignal.timeout(10_000) });
    expect(inspected).toMatchObject({
      content: [{ text: 'Inspected **library**.', type: 'text' }],
      structuredContent: { invocationKind: 'tool', source: 'library' },
    });
    expect(inspected.structuredContent).toMatchObject({
      actor: { reason: 'not-provided', state: 'unavailable' },
      host: {
        source: 'native',
        state: 'available',
        value: { name: 'generated-route-test' },
      },
      // The built entry mounts a process-lifetime registry, but a portable
      // artifact has no subagent events to feed it and this client name maps
      // to no host, so the call is honestly unplaceable.
      lineage: { reason: 'id-not-resolvable', state: 'unavailable' },
      session: { reason: 'not-provided', state: 'unavailable' },
      workspace: {
        source: 'derived',
        state: 'available',
        value: { root: process.cwd() },
      },
    });
    const resources = await client.listResources();
    expect(resources).toMatchObject({ resources: [
      expect.objectContaining({ uri: 'catalog://books' }),
      expect.objectContaining({ uri: 'ui://curator/dashboard.html' }),
    ] });
    expect(resources.resources.map((resource) => resource.uri)).not.toContain('agent-bundle://notices/inbox');
    await expect(client.readResource({ uri: 'catalog://books' })).resolves.toEqual({
      contents: [{ mimeType: 'application/json', text: '{"books":1}', uri: 'catalog://books' }],
    });
    await expect(client.listPrompts()).resolves.toMatchObject({ prompts: [
      expect.objectContaining({ description: 'Curate one genre.', name: 'curate' }),
    ] });
    await expect(client.getPrompt({ arguments: { genre: 'mystery' }, name: 'curate' })).resolves.toEqual({
      messages: [{ content: { text: 'Curate mystery', type: 'text' }, role: 'user' }],
    });
  } finally {
    await client.close();
  }
});

const writeGeneratedProject = async (
  root: string,
  files: Readonly<Record<string, string>>,
  target: 'cursor' | 'portable' = 'portable',
): Promise<void> => {
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        'agent-bundle': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-routes-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      `export default defineConfig({ plugin: { name: 'generated-routes-fixture', version: '1.0.0' }, targets: ['${target}'] });`,
      '',
    ].join('\n')),
    ...Object.entries(files).map(([path, contents]) => writeProjectFile(root, path, contents)),
  ]);
};

interface GeneratedEntryConnection {
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly pid: number | undefined;
  /** Everything the server process wrote to stderr so far — stdout is the protocol wire. */
  readonly stderr: () => string;
}

/** Spawns one built stdio entry and completes `initialize` against it. */
const connectGeneratedEntry = async (
  entry: string,
  name = 'generated-route-test',
): Promise<GeneratedEntryConnection> => {
  const client = new Client({ name, version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
  }
  let closing: Promise<void> | undefined;
  return {
    client,
    close: () => {
      closing ??= client.close();
      return closing;
    },
    pid: transport.pid ?? undefined,
    stderr: () => diagnostics,
  };
};

const connectGeneratedServer = async (
  root: string,
  target: 'cursor' | 'portable' = 'portable',
): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly endpointId: string;
}> => {
  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: [target] });
  const server = compiled.model.mcpServers[0];
  if (server?.args?.[0] === undefined) throw new Error('expected a generated MCP entry');
  const entry = join(output, server.args[0]);
  const connection = await connectGeneratedEntry(entry);
  return {
    client: connection.client,
    close: connection.close,
    endpointId: `${compiled.build.manifest.project.revision}:${dirname(dirname(resolve(entry)))}`,
  };
};

const callGeneratedTool = async (client: Client, name: string): Promise<unknown> => {
  try {
    return await client.callTool({ arguments: {}, name }, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return error;
  }
};

const expectFailClosed = (outcome: unknown, message: RegExp): void => {
  if (outcome instanceof Error) {
    expect(`${outcome.name} ${outcome.message}`).toMatch(message);
    return;
  }
  expect(outcome).toMatchObject({ isError: true });
  expect(JSON.stringify(outcome)).toMatch(message);
};

/**
 * Type-checks one generated-route App entry against the project's own
 * `.agent-bundle/routes.d.ts` — the `AppRegister` augmentation
 * `createAppClient().call` consumes. No manual `declare module`.
 */
const typecheckGeneratedApp = (root: string, entry: string): readonly string[] => {
  const program = ts.createProgram(
    [join(root, entry), join(root, '.agent-bundle', 'routes.d.ts')],
    {
      exactOptionalPropertyTypes: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    },
  );
  return ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};

const appRegisterEquality = [
  'type Equal<Left, Right> =',
  '  (<Value>() => Value extends Left ? 1 : 2) extends',
  '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
  'type Assert<Value extends true> = Value;',
];

const generatedAppClientSource = [
  "import { createAppClient } from 'agent-bundle/app';",
  "export const config = { resourceUri: 'ui://generated-routes-fixture/dashboard.html', template: './dashboard.html' };",
  "const state = document.querySelector('#state')!;",
  "const client = createAppClient({ appInfo: { name: 'generated-app-client', version: '1.0.0' } });",
  "client.onToolResult('tool:curator/ping', (result) => {",
  "  state.dataset.opened = result.note;",
  '});',
  'await client.connect();',
  "const called = await client.call('tool:curator/ping', { note: 'from-app' });",
  'state.textContent = JSON.stringify(called);',
  '',
].join('\n');

const generatedAppClientHtml = '<!doctype html><html><body><pre id="state">waiting</pre></body></html>\n';

const generatedPingTool = [
  "import { Agent } from '@agent-bundle/runtime';",
  "import { appResourceUri } from 'agent-bundle/routes';",
  "import { createElement } from 'react';",
  "import { z } from 'zod';",
  "export const config = { _meta: { ui: { resourceUri: appResourceUri('dashboard') } }, description: 'Ping from the App.' };",
  'export const inputSchema = z.object({ note: z.string() }).strict();',
  'export const resultSchema = z.object({ note: z.string() }).strict();',
  'export default async function Ping({ input }: { input: z.infer<typeof inputSchema> }) {',
  "  return createElement(Agent.Result, { value: { note: input.note } }, createElement(Agent.Text, null, input.note));",
  '}',
  '',
].join('\n');

it('augments a generated server from config and projects result _meta and text-only tools to the wire', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-augment-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-augment-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    // #380: the config block augments the route-generated server (env, args,
    // targets, a config-side App) without redeclaring its entry.
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      '  mcp: { servers: { curator: {',
      "    apps: { panel: { entry: './views/panel.ts', resourceUri: 'ui://generated-augment-fixture/panel.html' } },",
      "    args: ['--strict'],",
      "    env: { CURATOR_MODE: 'strict' },",
      '  } } },',
      "  plugin: { name: 'generated-augment-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'views/panel.ts', "document.body.textContent = 'Curator panel';\n"),
    // #383: `Agent.Result metadata` is the result-level `_meta`.
    writeProjectFile(root, 'src/mcp/curator/tools/annotated.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { _meta: { ui: { resourceUri: 'ui://generated-augment-fixture/panel.html' } }, description: 'Annotated result.' };",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ status: z.literal('ready') }).strict();",
      'export default async function Annotated() {',
      "  return createElement(Agent.Result, { metadata: { ui: { resourceUri: 'ui://generated-augment-fixture/panel.html' } }, value: { status: 'ready' } }, createElement(Agent.Text, null, 'ready'));",
      '}',
      '',
    ].join('\n')),
    // A text-only tool declares no object result, so it advertises no
    // outputSchema and returns no structuredContent.
    writeProjectFile(root, 'src/mcp/curator/tools/plain.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Text only.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.undefined();',
      'export default async function Plain() {',
      "  return createElement(Agent.Result, null, createElement(Agent.Text, null, 'plain text'));",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const server = compiled.model.mcpServers[0];
  expect(server).toMatchObject({
    args: [expect.stringMatching(/^mcp\/mcp-curator-[0-9a-f]+\.mjs$/u), '--strict'],
    env: { CURATOR_MODE: 'strict' },
    id: 'mcp:curator',
  });
  expect(compiled.model.mcpApps?.map((app) => app.id)).toEqual(['mcp-app:curator:panel']);
  const manifest = JSON.parse(await readFile(join(output, 'mcp.json'), 'utf8')) as {
    readonly mcpServers: { readonly curator: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } };
  };
  expect(manifest.mcpServers.curator.args[1]).toBe('--strict');
  expect(manifest.mcpServers.curator.env).toMatchObject({ CURATOR_MODE: 'strict' });

  const client = new Client({ name: 'generated-augment-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [join(output, server!.args![0]!)],
    command: process.execPath,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
    }
    const listed = await client.listTools();
    const annotated = listed.tools.find((tool) => tool.name === 'annotated');
    const plain = listed.tools.find((tool) => tool.name === 'plain');
    expect(annotated).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://generated-augment-fixture/panel.html' } },
      outputSchema: { type: 'object' },
    });
    expect(plain).toMatchObject({ description: 'Text only.' });
    expect(plain).not.toHaveProperty('outputSchema');

    const annotatedResult = await client.callTool({ arguments: {}, name: 'annotated' }, { signal: AbortSignal.timeout(10_000) });
    expect(annotatedResult).toEqual({
      _meta: { ui: { resourceUri: 'ui://generated-augment-fixture/panel.html' } },
      content: [{ text: 'ready', type: 'text' }],
      structuredContent: { status: 'ready' },
    });
    const plainResult = await client.callTool({ arguments: {}, name: 'plain' }, { signal: AbortSignal.timeout(10_000) });
    expect(plainResult).toEqual({ content: [{ text: 'plain text', type: 'text' }] });

    await expect(client.readResource({ uri: 'ui://generated-augment-fixture/panel.html' })).resolves.toMatchObject({
      contents: [{ text: expect.stringContaining('Curator panel'), uri: 'ui://generated-augment-fixture/panel.html' }],
    });
  } finally {
    await client.close();
  }
});

it('compiles appResourceUri() and imported-const references to the App route resourceUri and a route-relative template (#388)', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-app-refs-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    // The one literal: the App route's own resourceUri, itself an imported const.
    'src/mcp/curator/constants.ts': "export const DASHBOARD_URI = 'ui://generated-routes-fixture/dashboard.html';\n",
    'src/mcp/curator/apps/dashboard.ts': [
      "import { DASHBOARD_URI } from '../constants.ts';",
      "export const config = { resourceUri: DASHBOARD_URI, template: './dashboard.html' };",
      "document.getElementById('shell').textContent = 'Curator dashboard';",
      '',
    ].join('\n'),
    // Route-relative template: resolves beside the route module like its imports.
    'src/mcp/curator/apps/dashboard.html': '<!doctype html><html><head><title>route-relative-shell</title></head><body><main id="shell"></main></body></html>\n',
    // The tool references the App through the compile-time helper (run-time
    // import from the light routes subpath, never the compiler root).
    'src/mcp/curator/tools/open.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { appResourceUri } from 'agent-bundle/routes';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { _meta: { ui: { resourceUri: appResourceUri('dashboard') } }, description: 'Open the dashboard.' };",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ status: z.literal('ready') }).strict();",
      'export default async function Open() {',
      "  return createElement(Agent.Result, { value: { status: 'ready' } }, createElement(Agent.Text, null, 'ready'));",
      '}',
      '',
    ].join('\n'),
    // The resource references the same constant module the App reads.
    'src/mcp/curator/resources/catalog.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "import { DASHBOARD_URI } from '../constants';",
      "export const config = { _meta: { ui: { resourceUri: DASHBOARD_URI } }, description: 'Read the catalog.', mimeType: 'application/json', uri: 'catalog://books' };",
      'export const inputSchema = z.object({ uri: z.string() }).strict();',
      'export const resultSchema = z.object({ contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })) }).strict();',
      'export default async function Catalog({ input }) {',
      "  return createElement(Agent.Result, { value: { contents: [{ mimeType: 'application/json', text: '{}', uri: input.uri }] } }, createElement(Agent.Text, null, 'Catalog ready.'));",
      '}',
      '',
    ].join('\n'),
  });

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  expect(compiled.model.mcpApps?.map((app) => ({ id: app.id, resourceUri: app.resourceUri, template: app.template }))).toEqual([{
    id: 'mcp-app:curator:dashboard',
    resourceUri: 'ui://generated-routes-fixture/dashboard.html',
    template: join(root, 'src/mcp/curator/apps/dashboard.html'),
  }]);
  const compiledTool = compiled.model.mcpServers[0]!.generatedRoutes!.find((route) => route.id === 'tool:curator/open');
  expect(compiledTool?.config).toEqual({
    _meta: { ui: { resourceUri: 'ui://generated-routes-fixture/dashboard.html' } },
    description: 'Open the dashboard.',
  });
  // The compiled App HTML came from the route-relative template.
  const html = await readFile(join(output, 'mcp-apps', 'dashboard.html'), 'utf8');
  expect(html).toContain('route-relative-shell');
  expect(html).toContain('Curator dashboard');

  const server = compiled.model.mcpServers[0]!;
  const client = new Client({ name: 'generated-app-refs-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [join(output, server.args![0]!)],
    command: process.execPath,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
    }
    const listed = await client.listTools();
    expect(listed.tools.find((tool) => tool.name === 'open')).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://generated-routes-fixture/dashboard.html' } },
    });
    const resources = await client.listResources();
    expect(resources.resources.find((resource) => resource.uri === 'catalog://books')).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://generated-routes-fixture/dashboard.html' } },
    });
    await expect(client.readResource({ uri: 'ui://generated-routes-fixture/dashboard.html' })).resolves.toMatchObject({
      contents: [{ text: expect.stringContaining('route-relative-shell'), uri: 'ui://generated-routes-fixture/dashboard.html' }],
    });
  } finally {
    await client.close();
  }
});

it('compiles createAppClient().call against generated AppRegister contracts without a manual augmentation', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-app-client-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/apps/dashboard.html': generatedAppClientHtml,
    'src/mcp/curator/apps/dashboard.ts': generatedAppClientSource,
    'src/mcp/curator/tools/ping.ts': generatedPingTool,
    'src/app-client-call.ts': [
      "import { createAppClient, type AppRegister } from 'agent-bundle/app';",
      ...appRegisterEquality,
      "export type AppIds = Assert<Equal<keyof AppRegister['routes'], 'tool:curator/ping'>>;",
      "export type AppPing = Assert<Equal<AppRegister['routes']['tool:curator/ping'], Readonly<{ input: { note: string }; result: { note: string } }>>>;",
      'const client = createAppClient();',
      "export const called = client.call('tool:curator/ping', { note: 'from-app' });",
      '',
    ].join('\n'),
    'src/wrong-app-id.ts': [
      "import { createAppClient } from 'agent-bundle/app';",
      'const client = createAppClient();',
      "void client.call('tool:curator/missing', { note: 'from-app' });",
      '',
    ].join('\n'),
    'src/wrong-app-input.ts': [
      "import { createAppClient } from 'agent-bundle/app';",
      'const client = createAppClient();',
      "void client.call('tool:curator/ping', { note: 1 });",
      '',
    ].join('\n'),
  });

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const generatedTypes = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(generatedTypes).toContain('tool:curator/ping');
  expect(generatedTypes).toContain("declare module 'agent-bundle/app' {\n  interface AppRegister {\n    readonly routes: AgentBundleAppRouteContracts;\n  }\n}");
  expect(generatedAppClientSource).not.toContain('declare module');
  expect(generatedAppClientSource).not.toMatch(/\bzod\b/u);
  expect(generatedAppClientSource).not.toMatch(/@modelcontextprotocol\/server/u);
  expect(generatedTypes.split('\n').filter((line) => line.startsWith('import')).every((line) => line.startsWith('import type * as '))).toBe(true);

  expect(typecheckGeneratedApp(root, 'src/app-client-call.ts')).toEqual([]);
  const wrongId = typecheckGeneratedApp(root, 'src/wrong-app-id.ts');
  expect(wrongId).toHaveLength(1);
  expect(wrongId[0]).toMatch(/tool:curator\/missing/u);
  const wrongInput = typecheckGeneratedApp(root, 'src/wrong-app-input.ts');
  expect(wrongInput).toHaveLength(1);
  expect(wrongInput[0]).toMatch(/Type 'number' is not assignable to type 'string'/u);

  const html = await readFile(join(output, 'portable', 'mcp-apps', 'dashboard.html'), 'utf8');
  expect(html).toContain('2026-01-26');
  expect(html).toContain('from-app');
  expect([
    /\bnode:/u,
    /["']effect(?:\/|["'])/u,
    /["']zod(?:\/|["'])/u,
    /mcp-server-runtime|mcp-schema-projection/u,
  ].filter((pattern) => pattern.test(html))).toEqual([]);

  const server = compiled.model.mcpServers[0]!;
  const client = new Client({ name: 'generated-app-client-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [join(output, 'portable', server.args![0]!)],
    command: process.execPath,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated App client fixture failed to connect: ${diagnostics}`, { cause: error });
    }
    await expect(client.callTool({ arguments: { note: 'from-stdio' }, name: 'ping' }, { signal: AbortSignal.timeout(10_000) }))
      .resolves.toMatchObject({ structuredContent: { note: 'from-stdio' } });
    await expect(client.readResource({ uri: 'ui://generated-routes-fixture/dashboard.html' })).resolves.toMatchObject({
      contents: [{ text: expect.stringContaining('from-app'), uri: 'ui://generated-routes-fixture/dashboard.html' }],
    });
  } finally {
    await client.close();
  }
});

it('observes one process-lifetime provider across consecutive generated tool calls', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-warm-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/state.ts': [
      "import { defineState } from '@agent-bundle/runtime/state';",
      "import { z } from 'zod';",
      "export default defineState({",
      "  events: { changed: z.object({ value: z.string() }).strict() },",
      "  id: 'generated-routes/process-state',",
      '  initial: { value: "" },',
      "  lifetime: 'process',",
      '  reduce: (_state, event) => ({ value: event.payload.value }),',
      '  schema: z.object({ value: z.string() }).strict(),',
      '});',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/warmth.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Observe process lifetime.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ hits: z.number(), instanceId: z.string(), pid: z.number() }).strict();',
      'export default async function Warmth() {',
      '  const context = await agent();',
      '  const processLifetime = context.providers.processLifetime;',
      "  if (processLifetime === undefined || typeof processLifetime !== 'object' || processLifetime === null) {",
      "    throw new Error('process-lifetime provider was not installed');",
      '  }',
      '  const value = processLifetime as { hits: number; instanceId: string; pid: number };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `hit ${String(value.hits)}`));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    const first = await session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) });
    const second = await session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) });
    expect(first).toMatchObject({
      content: [{ text: 'hit 1', type: 'text' }],
      structuredContent: { hits: 1 },
    });
    expect(second).toMatchObject({
      content: [{ text: 'hit 2', type: 'text' }],
      structuredContent: { hits: 2 },
    });
    const firstId = (first.structuredContent as { instanceId: string }).instanceId;
    const secondContent = second.structuredContent as { instanceId: string; pid: number };
    expect(secondContent.instanceId).toBe(firstId);
    expect(secondContent.pid).toBe((first.structuredContent as { pid: number }).pid);
    await expect(session.client.listResources()).resolves.toMatchObject({
      resources: [expect.objectContaining({ uri: 'agent-bundle://notices/inbox' })],
    });
    await expect(session.client.readResource({ uri: 'agent-bundle://notices/inbox' })).resolves.toEqual({
      contents: [{
        mimeType: 'application/json',
        text: '{"notices":[]}',
        uri: 'agent-bundle://notices/inbox',
      }],
    });
  } finally {
    await session.close();
  }
});

it('emits notifications/resources/updated for the durable notice inbox to the subscribed stdio client', { retry: 2, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-inbox-updated-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/state.ts': [
      "import { defineState } from '@agent-bundle/runtime/state';",
      "import { z } from 'zod';",
      'export default defineState({',
      "  events: { changed: z.object({ value: z.string() }).strict() },",
      "  id: 'generated-routes/durable-state',",
      '  initial: { value: "" },',
      "  lifetime: 'workspace-durable',",
      '  reduce: (_state, event) => ({ value: event.payload.value }),',
      '  schema: z.object({ value: z.string() }).strict(),',
      '});',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/notify.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Publish a notice to a host-scoped recipient.' };",
      'export const inputSchema = z.object({ host: z.string(), message: z.string() }).strict();',
      "export const resultSchema = z.object({ noticeId: z.string(), state: z.literal('pending') }).strict();",
      'export default async function Notify({ input }) {',
      '  const context = await agent();',
      "  if (context.notices === undefined) throw new TypeError('notices unavailable');",
      '  const published = await context.notices.publish({',
      "    content: { root: { kind: 'text', text: input.message }, status: 'success', version: 1 },",
      "    priority: 'normal',",
      '    recipient: { host: { name: input.host } },',
      '  }, { idempotencyKey: `notice:${input.host}:${input.message}` });',
      '  const value = { noticeId: published.notice.id, state: published.notice.state };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `published ${value.noticeId}`));",
      '}',
      '',
    ].join('\n'),
  });
  const inboxUri = 'agent-bundle://notices/inbox';
  const session = await connectGeneratedServer(root);
  const updates: string[] = [];
  session.client.setNotificationHandler('notifications/resources/updated', (notification) => {
    updates.push(notification.params.uri);
  });
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  // The inbox observation is detached from the render that triggered it.
  const signalled = async (count: number): Promise<void> => {
    for (let i = 0; i < 500 && updates.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The availability receipt commits right after the wire write resolves.
    await settle();
  };
  const readInbox = async (): Promise<readonly Readonly<Record<string, unknown>>[]> => {
    const read = await session.client.readResource({ uri: inboxUri });
    const content = read.contents[0];
    if (content === undefined || !('text' in content)) throw new TypeError('Expected text inbox content');
    return (JSON.parse(content.text) as { notices: readonly Readonly<Record<string, unknown>>[] }).notices;
  };
  try {
    // The packed server process holds its own SQLite handle on the store the
    // Flight worker mounts, so it can honestly advertise inbox subscriptions.
    expect(session.client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
    await expect(session.client.subscribeResource({ uri: 'ui://curator/missing.html' })).rejects.toThrow(/does not support subscriptions/u);
    await session.client.subscribeResource({ uri: inboxUri });

    // stdio identity is transport-only: the client name is the one observed
    // axis, so a host-scoped notice reaches this connection and an
    // actor-scoped one cannot.
    await session.client.callTool({ arguments: { host: 'someone-else', message: 'not for you' }, name: 'notify' }, { signal: AbortSignal.timeout(10_000) });
    await settle();
    expect(updates).toEqual([]);
    await session.client.callTool({ arguments: { host: 'generated-route-test', message: 'for this client' }, name: 'notify' }, { signal: AbortSignal.timeout(10_000) });
    await signalled(1);
    expect(updates).toEqual([inboxUri]);

    const inbox = await readInbox();
    expect(inbox).toEqual([expect.objectContaining({
      availability: expect.objectContaining({ channel: 'mcp-resource-updated', count: 1 }),
      content: { root: { kind: 'text', text: 'for this client' }, status: 'success', version: 1 },
      exposure: expect.objectContaining({ channel: 'mcp-inbox', count: 1 }),
      state: 'pending',
    })]);
    // The re-read advanced the ledger without producing a further signal.
    await settle();
    expect(updates).toEqual([inboxUri]);

    await session.client.unsubscribeResource({ uri: inboxUri });
    await session.client.callTool({ arguments: { host: 'generated-route-test', message: 'after unsubscribe' }, name: 'notify' }, { signal: AbortSignal.timeout(10_000) });
    await settle();
    expect(updates).toEqual([inboxUri]);
    expect(await readInbox()).toHaveLength(2);
  } finally {
    await session.close();
  }
});

it('emits MCP progress notifications only when a progress token is supplied', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-progress-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/progress.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Report progress.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Progress() {',
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'halfway', total: 2 });",
      "  await context.progress.report({ completed: 2, message: 'done', total: 2 });",
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'finished'));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  const notifications: Array<{ readonly message?: string; readonly progress: number; readonly progressToken: string | number; readonly total?: number }> = [];
  session.client.setNotificationHandler('notifications/progress', (notification) => {
    notifications.push(notification.params);
  });
  try {
    await expect(session.client.callTool({ arguments: {}, name: 'progress' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      content: [{ text: 'finished', type: 'text' }],
      structuredContent: { ok: true },
    });
    expect(notifications).toEqual([]);
    await expect(session.client.callTool({
      arguments: {},
      name: 'progress',
      _meta: { progressToken: 'tok-1' },
    }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(notifications).toEqual([
      { message: 'halfway', progress: 1, progressToken: 'tok-1', total: 2 },
      { message: 'done', progress: 2, progressToken: 'tok-1', total: 2 },
    ]);
  } finally {
    await session.close();
  }
});

/**
 * #492: what a thrown (not represented) route error is on each MCP surface of
 * a real generated stdio server. A tool throw is the SDK's default tool error;
 * a prompt or resource throw is a JSON-RPC error the client rejects with. The
 * layout shell never wraps either, because no document exists.
 */
it('projects thrown route errors as the SDK tool error or a JSON-RPC error, never as a layout-wrapped document', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-thrown-'));
  roots.push(root);
  const throwing = (kind: string) => [
    "import { z } from 'zod';",
    `export const config = ${kind === 'resource' ? "{ mimeType: 'text/plain', uri: 'curator://broken' }" : "{ description: 'Throws.' }"};`,
    `export const inputSchema = ${kind === 'resource' ? 'z.object({ uri: z.string() })' : 'z.object({}).strict()'};`,
    'export const resultSchema = z.object({}).passthrough();',
    `export default async function Broken() { throw new Error('${kind} route threw'); }`,
    '',
  ].join('\n');
  await writeGeneratedProject(root, {
    // A layout that would stamp `_meta` on every document, to show it is absent when the route throws.
    'src/layout.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export default function Layout({ children, route }) { return createElement(Agent.Result, { metadata: { route: route.id } }, children); }",
      '',
    ].join('\n'),
    'src/mcp/curator/prompts/broken.ts': throwing('prompt'),
    'src/mcp/curator/resources/broken.ts': throwing('resource'),
    'src/mcp/curator/tools/broken.ts': throwing('tool'),
    'src/mcp/curator/tools/fine.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Renders.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      "export default async function Fine() { return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'fine')); }",
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    // The layout is live: a rendering tool carries its `_meta`.
    await expect(session.client.callTool({ arguments: {}, name: 'fine' }, { signal: AbortSignal.timeout(10_000) })).resolves.toEqual({
      _meta: { route: 'tool:curator/fine' },
      content: [{ text: 'fine', type: 'text' }],
      structuredContent: { ok: true },
    });

    // tools/call: @modelcontextprotocol/server `createToolError` — the thrown
    // message as one text block plus isError. No `_meta`, no
    // `structuredContent`, no `[code]` prefix: agent-bundle projected nothing.
    await expect(session.client.callTool({ arguments: {}, name: 'broken' }, { signal: AbortSignal.timeout(10_000) })).resolves.toEqual({
      content: [{ text: 'tool route threw', type: 'text' }],
      isError: true,
    });

    // prompts/get and resources/read have no isError channel: the throw is a
    // JSON-RPC error response and the client call rejects.
    await expect(session.client.getPrompt({ arguments: {}, name: 'broken' }, { signal: AbortSignal.timeout(10_000) }))
      .rejects.toMatchObject({ message: expect.stringContaining('prompt route threw') });
    await expect(session.client.readResource({ uri: 'curator://broken' }, { signal: AbortSignal.timeout(10_000) }))
      .rejects.toMatchObject({ message: expect.stringContaining('resource route threw') });

    // The server survived all three: the next call renders normally.
    await expect(session.client.callTool({ arguments: {}, name: 'fine' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
  } finally {
    await session.close();
  }
});

it('maps notifications/cancelled into the renderer AbortSignal', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-cancel-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/hang.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Hang until cancelled.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Hang({ signal }) {',
      '  await new Promise((_, reject) => {',
      "    const fail = () => reject(new DOMException('aborted', 'AbortError'));",
      '    if (signal.aborted) { fail(); return; }',
      "    signal.addEventListener('abort', fail, { once: true });",
      '  });',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'should not complete'));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    const controller = new AbortController();
    const pending = session.client.callTool({ arguments: {}, name: 'hang' }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  } finally {
    await session.close();
  }
});

it('fails closed when the generated runtime worker restarts', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-restart-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/warmth.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Observe process lifetime.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ hits: z.number(), instanceId: z.string(), pid: z.number() }).strict();',
      'export default async function Warmth() {',
      '  const context = await agent();',
      '  const value = context.providers.processLifetime as { hits: number; instanceId: string; pid: number };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `hit ${String(value.hits)}`));",
      '}',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/halt.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Halt the Flight worker.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Halt() {',
      '  process.exit(1);',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'halted'));",
      '}',
      '',
    ].join('\n'),
    'src/events/session/start.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['cursor'] };",
      "export default async function SessionStart() { return createElement(Agent.Text, null, 'ready'); }",
      '',
    ].join('\n'),
  }, 'cursor');
  const session = await connectGeneratedServer(root, 'cursor');
  try {
    await expect(session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      structuredContent: { hits: 1 },
    });
    const beforeRestart = await requestEventRuntimeStatus({ endpointId: session.endpointId, timeoutMs: 1_000 });
    expect(beforeRestart).toMatchObject({ availability: 'available', status: 'available' });
    const halted = await callGeneratedTool(session.client, 'halt');
    expectFailClosed(halted, /unavailable|restarted|exited/i);
    await expect(requestEventRuntimeStatus({ endpointId: session.endpointId, timeoutMs: 1_000 })).resolves.toMatchObject({
      availability: 'runtime-restarted',
      instanceId: beforeRestart.status === 'available' ? beforeRestart.instanceId : undefined,
      status: 'available',
    });
    const afterRestart = await callGeneratedTool(session.client, 'warmth');
    expectFailClosed(afterRestart, /unavailable|restarted|exited|connection closed/i);
    expect(afterRestart).not.toMatchObject({ structuredContent: { hits: 2 } });
  } finally {
    await session.close();
  }
});

it('keeps a second generated server from the same install alive while the first owns the event runtime socket, then hands the socket over', { retry: 2, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-standby-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/ping.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Answer from this process.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ pid: z.number() }).strict();',
      'export default async function Ping() {',
      "  return createElement(Agent.Result, { value: { pid: process.pid } }, createElement(Agent.Text, null, 'pong'));",
      '}',
      '',
    ].join('\n'),
    'src/events/session/start.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['cursor'] };",
      "export default async function SessionStart() { return createElement(Agent.Text, null, 'ready'); }",
      '',
    ].join('\n'),
  }, 'cursor');
  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['cursor'] });
  const server = compiled.model.mcpServers[0];
  if (server?.args?.[0] === undefined) throw new Error('expected a generated MCP entry');
  const entry = join(output, server.args[0]);
  const endpointId = `${compiled.build.manifest.project.revision}:${dirname(dirname(resolve(entry)))}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const status = (): Promise<unknown> => requestEventRuntimeStatus({ endpointId, timeoutMs: 1_000 });

  // Two host sessions launch the same plugin from the same install root: the
  // second finds the event runtime socket owned and must still come up.
  const first = await connectGeneratedEntry(entry, 'generated-standby-first');
  let second: GeneratedEntryConnection | undefined;
  try {
    second = await connectGeneratedEntry(entry, 'generated-standby-second');
    const [firstTools, secondTools] = await Promise.all([first.client.listTools(), second.client.listTools()]);
    expect(firstTools.tools.map((tool) => tool.name)).toEqual(['ping']);
    expect(secondTools.tools.map((tool) => tool.name)).toEqual(['ping']);
    await expect(second.client.callTool({ arguments: {}, name: 'ping' }, { signal: AbortSignal.timeout(10_000) }))
      .resolves.toMatchObject({ structuredContent: { pid: second.pid } });
    await eventuallyPasses(() => {
      expect(second!.stderr()).toContain(`agent-bundle event runtime: ${endpoint} is owned by another process; standing by`);
    }, { attempts: 100, delayMs: 50 });
    expect(first.stderr()).not.toContain('standing by');
    await expect(status()).resolves.toMatchObject({ pid: first.pid, status: 'available' });

    // The owner exits; the standby takes the socket over without restarting.
    await first.close();
    await eventuallyPasses(async () => {
      await expect(status()).resolves.toMatchObject({ pid: second!.pid, status: 'available' });
    }, { attempts: 100, delayMs: 100 });
    expect(second.stderr()).toContain(`agent-bundle event runtime: ${endpoint} was released by its owner; took it over`);
    await expect(second.client.callTool({ arguments: {}, name: 'ping' }, { signal: AbortSignal.timeout(10_000) }))
      .resolves.toMatchObject({ structuredContent: { pid: second.pid } });
  } finally {
    await first.close();
    await second?.close();
  }
  // The last owner out removes the socket it bound.
  await eventuallyPasses(async () => {
    await expect(stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  }, { attempts: 100, delayMs: 50 });
});

it('renders one tool/after event route through two native thin clients', { retry: 2, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-events-fixture', version: '1.0.0' }, targets: ['claude', 'cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/runtime/tools/status.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ providerKind: z.literal('tool'), providersFrozen: z.literal(true) }).strict();",
      'export default async function Status() {',
      '  const context = await agent();',
      '  const requestValue = context.providers.requestValue as { kind: string };',
      '  const value = { providerKind: requestValue.kind, providersFrozen: Object.isFrozen(context.providers) };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `provider:${requestValue.kind}`));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/runtime/tools/explode.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Explode() {',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'unreachable'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/request-value.ts', [
      "import type { AgentProviderFactory } from 'agent-bundle';",
      'const provideRequest: AgentProviderFactory = ({ invocation }) => Object.freeze({ kind: invocation.kind });',
      'export default provideRequest;',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/throwing.ts', [
      "import type { AgentProviderFactory } from 'agent-bundle';",
      'const provideFailure: AgentProviderFactory = ({ invocation }) => {',
      "  if (invocation.kind === 'tool' && invocation.props.operationId.endsWith('/explode')) {",
      "    throw new Error('provider exploded');",
      '  }',
      "  return 'ready';",
      '};',
      'export default provideFailure;',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['claude', 'cursor'], tools: ['file.write'], timeoutMs: 5000 };",
      'export default async function AfterTool({ canonical, native }) {',
      '  const context = await agent();',
      '  const requestValue = context.providers.requestValue as { kind: string };',
      '  // The canonical payload names the tool through the host key it came from and, on Cursor, the',
      '  // parsed tool_output; `native` keeps the raw string (#466).',
      '  const payloadTool = canonical.payload.toolName;',
      '  const response = canonical.payload.toolResponse;',
      '  const tool = payloadTool === undefined || typeof native.tool_name !== "string" || native.tool_name !== payloadTool.value',
      '    ? "unknown"',
      '    : `${payloadTool.value}@${payloadTool.nativeKey}/${response?.nativeKey ?? "none"}=${JSON.stringify(response?.value)}/${typeof native[response?.nativeKey ?? ""]}`;',
      "  const actor = context.actor.state === 'unavailable' ? `unavailable:${context.actor.reason}` : `available:${context.actor.value.id}`;",
      "  const host = context.host.state === 'unavailable' ? `unavailable:${context.host.reason}` : `available:${context.host.source}:${context.host.value.name}`;",
      "  const session = context.session.state === 'unavailable' ? `unavailable:${context.session.reason}` : `available:${context.session.source}:${context.session.value.sessionId}`;",
      "  const workspace = context.workspace.state === 'unavailable' ? `unavailable:${context.workspace.reason}` : `available:${context.workspace.source}:${context.workspace.value.root}`;",
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${canonical.provenance.host}:${tool}:${requestValue.kind}:${String(Object.isFrozen(context.providers))}:host:${host}:session:${session}:workspace:${workspace}:actor:${actor}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/workspace/open.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['cursor'] };",
      'export default async function WorkspaceOpen({ native }) {',
      '  const workspace = (await agent()).workspace;',
      '  if (workspace.state !== "available" || workspace.value.root !== native.workspace_roots[0]) {',
      '    throw new Error(`workspace identity mismatch: ${JSON.stringify(workspace)}`);',
      '  }',
      '  return createElement(Agent.Result);',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude', 'cursor'] });
  expect(compiled.model.hooks.filter((hook) => hook.eventRoute !== undefined)).toHaveLength(2);
  expect(compiled.build.compiledHooks.filter((hook) => hook.id === 'hook:event-route:tool-after')).toHaveLength(2);

  // One generated server serves the composite root; each host's thin client
  // is its own suffixed wrapper in the shared hooks/ folder.
  const mcp = compiled.build.compiledMcpEntries.find((entry) => entry.target === 'claude+cursor')!;
  await expect(readFile(mcp.output, 'utf8')).resolves.toContain('agent-bundle-event-');
  const client = new Client({ name: 'generated-event-composite', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [mcp.output], command: process.execPath, stderr: 'pipe' });
  await client.connect(transport);
  try {
    await expect(client.callTool({ arguments: {}, name: 'status' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      content: [{ text: 'provider:tool', type: 'text' }],
      structuredContent: { providerKind: 'tool', providersFrozen: true },
    });
    const exploded = await callGeneratedTool(client, 'explode');
    expectFailClosed(exploded, /throwing.*src[/\\]providers[/\\]throwing\.ts.*provider exploded/iu);

    // The endpoint is the artifact's alone — epoch and root — however many
    // projections the root carries (#592); the invoking host rides each request.
    const endpointId = `${compiled.build.manifest.project.revision}:${dirname(dirname(resolve(mcp.output)))}`;
    const expectedEndpoint = eventRuntimeEndpoint(endpointId);
    await expect(stat(expectedEndpoint)).resolves.toMatchObject({ mode: expect.any(Number) });
    const firstStatus = await requestEventRuntimeStatus({ endpointId, timeoutMs: 1_000 });
    const secondStatus = await requestEventRuntimeStatus({ endpointId, timeoutMs: 1_000 });
    expect(firstStatus).toMatchObject({
      artifactEpoch: 'generated-events-fixture@1.0.0',
      availability: 'available',
      status: 'available',
    });
    expect(secondStatus).toMatchObject({
      instanceId: firstStatus.status === 'available' ? firstStatus.instanceId : undefined,
      status: 'available',
    });

    for (const target of ['claude', 'cursor'] as const) {
      const hook = compiled.build.compiledHooks.find((entry) => entry.target === target && entry.event === 'afterTool')!;
      expect(hook.output.endsWith(`.${target}.mjs`)).toBe(true);
      const native = target === 'cursor'
        ? {
            conversation_id: 'conversation-1',
            cwd: root,
            hook_event_name: 'postToolUse',
            session_id: 'session-1',
            tool_input: { file_path: 'demo.ts' },
            tool_name: 'Write',
            tool_output: '{"ok":true}',
            tool_use_id: 'tool-1',
          }
        : {
            cwd: root,
            hook_event_name: 'PostToolUse',
            session_id: 'session-1',
            tool_input: { file_path: 'demo.ts' },
            tool_name: 'Write',
            tool_response: { ok: true },
            tool_use_id: 'tool-1',
            transcript_path: join(root, 'transcript.jsonl'),
          };
      const response = await runHook(hook.output, native);
      expect(response).toEqual(target === 'cursor'
        ? { additional_context: `cursor:Write@tool_name/tool_output={"ok":true}/string:event:true:host:available:native:cursor:session:available:native:session-1:workspace:available:native:${root}:actor:unavailable:not-provided` }
        : {
            hookSpecificOutput: {
              additionalContext: `claude:Write@tool_name/tool_response={"ok":true}/object:event:true:host:available:native:claude:session:available:native:session-1:workspace:available:native:${root}:actor:unavailable:not-provided`,
              hookEventName: 'PostToolUse',
            },
          });
    }
    const workspaceOpen = compiled.build.compiledHooks.find((entry) =>
      entry.target === 'cursor' && entry.event === 'workspaceOpen');
    expect(workspaceOpen).toBeDefined();
    await expect(runHook(workspaceOpen!.output, {
      cursor_version: '1.7.2',
      hook_event_name: 'workspaceOpen',
      user_email: null,
      workspace_roots: [root, join(root, 'secondary')],
    })).resolves.toBeUndefined();
  } finally {
    await client.close();
  }
});

it('renders composite root events through each selected host in one warm runtime', { retry: 2, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-plugin-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-plugin-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-plugin-events-fixture', version: '1.0.0' }, targets: ['claude', 'codex', 'cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/runtime/tools/status.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Keep the shared event runtime warm.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Status() {',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'ready'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['claude', 'codex', 'cursor'], tools: ['file.write'] };",
      'export default async function AfterTool() {',
      '  const context = await agent();',
      '  const processLifetime = context.providers.processLifetime as { hits: number; instanceId: string };',
      '  const host = context.host.state === "available" ? context.host.value.name : "unavailable";',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${host}:${context.invocation.operationId}|${context.invocation.surface}:${String(processLifetime.hits)}:${processLifetime.instanceId}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/session/start.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['claude', 'codex', 'cursor'] };",
      'export default async function SessionStart() {',
      '  const context = await agent();',
      '  const processLifetime = context.providers.processLifetime as { hits: number; instanceId: string };',
      '  const host = context.host.state === "available" ? context.host.value.name : "unavailable";',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${host}:session/start:${String(processLifetime.hits)}:${processLifetime.instanceId}`));',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['cursor', 'codex', 'claude'] });
  // One generated server serves the whole composite root under its sorted identity.
  const mcp = compiled.build.compiledMcpEntries.find((entry) => entry.target === 'claude+codex+cursor')!;
  const hookFor = (event: string, host: string) => compiled.build.compiledHooks.find((entry) =>
    entry.event === event && entry.output.endsWith(`.${host}.mjs`))!;
  const claudeAfter = hookFor('afterTool', 'claude');
  const codexAfter = hookFor('afterTool', 'codex');
  const cursorAfter = hookFor('afterTool', 'cursor');
  const codexSession = hookFor('sessionStart', 'codex');
  const client = new Client({ name: 'generated-event-plugin', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [mcp.output], command: process.execPath, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const endpointId = `${compiled.build.manifest.project.revision}:${dirname(dirname(resolve(mcp.output)))}`;
    await expect(requestEventRuntime({
      artifactEpoch: compiled.build.manifest.project.revision,
      endpointId,
      event: 'tool/after',
      hostContractRevision: 'test',
      native: {},
      signal: AbortSignal.timeout(10_000),
      target: 'portable',
      timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: 'runtime-failed' });

    const claude = await runHook(claudeAfter.output, {
      cwd: root,
      hook_event_name: 'PostToolUse',
      session_id: 'session-claude',
      tool_input: { file_path: 'demo.ts' },
      tool_name: 'Write',
      tool_response: { ok: true },
      tool_use_id: 'tool-claude',
      transcript_path: join(root, 'transcript.jsonl'),
    }, { PLUGIN_ROOT: undefined });
    const firstContext = (claude as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    // The worker mounts the compiled route id as `operationId` and the
    // canonical event as `surface` — the same pair the hook shell, the
    // lifecycle replay, and `renderRoute` record for this route.
    const instanceId = firstContext.slice('claude:event:tool/after|tool/after:1:'.length);
    expect(instanceId).not.toBe('');
    expect(claude).toEqual({
      hookSpecificOutput: {
        additionalContext: `claude:event:tool/after|tool/after:1:${instanceId}`,
        hookEventName: 'PostToolUse',
      },
    });

    await expect(runHook(codexAfter.output, {
      cwd: root,
      hook_event_name: 'PostToolUse',
      session_id: 'session-codex',
      tool_input: { command: '*** Begin Patch\n*** End Patch' },
      tool_name: 'apply_patch',
      tool_response: { ok: true },
      tool_use_id: 'tool-codex',
      transcript_path: null,
    }, { PLUGIN_ROOT: output })).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `codex:event:tool/after|tool/after:2:${instanceId}`,
        hookEventName: 'PostToolUse',
      },
    });

    await expect(runHook(cursorAfter.output, {
      conversation_id: 'conversation-cursor',
      cwd: root,
      hook_event_name: 'postToolUse',
      session_id: 'session-cursor',
      tool_input: { file_path: 'demo.ts' },
      tool_name: 'Write',
      tool_output: '{"ok":true}',
      tool_use_id: 'tool-cursor',
    }, { PLUGIN_ROOT: undefined })).resolves.toEqual({
      additional_context: `cursor:event:tool/after|tool/after:3:${instanceId}`,
    });

    await expect(runHook(codexSession.output, {
      cwd: root,
      hook_event_name: 'SessionStart',
      session_id: 'session-codex',
      source: 'startup',
      transcript_path: null,
    }, { PLUGIN_ROOT: output })).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `codex:session/start:4:${instanceId}`,
        hookEventName: 'SessionStart',
      },
    });
  } finally {
    await client.close();
  }
});

it('runs an explicitly standalone event route without a shared runtime', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-standalone-event-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'standalone-event-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'standalone-event-fixture', version: '1.0.0' }, targets: ['cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement, Suspense } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['cursor'] };",
      'const wait = () => new Promise((resolve) => setTimeout(resolve, 5));',
      'const Context = async ({ tool }) => createElement(Agent.Context, null, `standalone:${tool}`);',
      'export default async function AfterTool({ native }) {',
      '  await wait();',
      "  return createElement(Agent.Result, null, createElement(Suspense, { fallback: createElement(Agent.Context, null, 'loading') }, createElement(Context, { tool: native.tool_name })));",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['cursor'] });
  expect(compiled.build.compiledMcpEntries).toHaveLength(0);
  const hook = compiled.build.compiledHooks.find((entry) => entry.event === 'afterTool');
  expect(hook).toBeDefined();
  const response = await runHook(hook!.output, {
    conversation_id: 'conversation-1',
    cwd: root,
    hook_event_name: 'postToolUse',
    session_id: 'session-1',
    tool_input: { file_path: 'demo.ts' },
    tool_name: 'Write',
    tool_output: '{"ok":true}',
    tool_use_id: 'tool-1',
  });
  expect(response).toEqual({ additional_context: 'standalone:Write' });
});

/**
 * #492: a thrown event route never reaches `projectEventDocument`. The
 * generated wrapper writes the message to stderr, nothing to stdout, and exits
 * 1 — which every supported host documents as a non-blocking error, so the
 * pending action proceeds exactly as a pass-through would.
 */
it('exits 1 with the message on stderr and no stdout when a standalone event route throws', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-thrown-event-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'workspace:*', react: '19.2.8' },
      name: 'thrown-event-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'thrown-event-fixture', version: '1.0.0' }, targets: ['cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/before.tsx', [
      "export const config = { runtime: 'standalone', targets: ['cursor'] };",
      "export default async function BeforeTool() { throw new Error('before-tool route exploded'); }",
      '',
    ].join('\n')),
  ]);

  const compiled = await build({ output: join(root, 'artifact'), root, targets: ['cursor'] });
  const hook = compiled.build.compiledHooks.find((entry) => entry.event === 'beforeTool');
  expect(hook).toBeDefined();
  const run = await new Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [hook!.output], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => { resolvePromise({ code, stderr, stdout }); });
    child.stdin.end(JSON.stringify({
      conversation_id: 'conversation-1',
      cwd: root,
      hook_event_name: 'preToolUse',
      session_id: 'session-1',
      tool_input: { command: 'ls' },
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
    }));
  });

  expect(run.code).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('before-tool route exploded');
});

it('replays Claude and Codex subagent fixtures through standalone event-route wrappers', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-subagent-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'subagent-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'subagent-events-fixture', version: '1.0.0' }, targets: ['claude', 'codex'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/start.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStart({ native }) {',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${native.session_id}:${native.agent_id}:${native.agent_type}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/stop.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStop({ native }) {',
      "  return createElement(Agent.Result, { value: { outcome: 'deny', reason: `Review ${native.agent_id} once more.` } });",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude', 'codex'] });
  expect(compiled.build.compiledHooks.filter((hook) => hook.event === 'agentStart')).toHaveLength(2);
  expect(compiled.build.compiledHooks.filter((hook) => hook.event === 'agentStop')).toHaveLength(2);

  for (const target of ['claude', 'codex'] as const) {
    const start = compiled.build.compiledHooks.find((hook) => hook.target === target && hook.event === 'agentStart')!;
    const stop = compiled.build.compiledHooks.find((hook) => hook.target === target && hook.event === 'agentStop')!;
    const startInput = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-start.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    const stopInput = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-stop.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;

    await expect(runHook(start.output, startInput)).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `${String(startInput.session_id)}:${String(startInput.agent_id)}:${String(startInput.agent_type)}`,
        hookEventName: 'SubagentStart',
      },
    });
    await expect(runHook(stop.output, stopInput)).resolves.toEqual({
      decision: 'block',
      reason: `Review ${String(stopInput.agent_id)} once more.`,
    });
  }
});

it('dispatches shared event routes through the invoking host contract', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-plugin-subagent-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'plugin-subagent-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'plugin-subagent-events-fixture', version: '1.0.0' }, targets: ['claude', 'codex'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/start.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStart({ canonical, native }) {',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${canonical.provenance.host}:${native.agent_id}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/stop.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStop() {',
      "  return createElement(Agent.Result, null, createElement(Agent.Context, null, 'Check the final result.'));",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude', 'codex'] });
  // Both hosts share hooks/, so each host's wrapper carries its suffix.
  const hookFor = (event: string, host: string) => compiled.build.compiledHooks.find((hook) =>
    hook.event === event && hook.output.endsWith(`.${host}.mjs`))!;

  for (const target of ['claude', 'codex'] as const) {
    const input = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-start.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    if (target === 'codex') input.transcript_path = null;
    const env = target === 'codex'
      ? { PLUGIN_ROOT: output }
      : { PLUGIN_ROOT: undefined };
    await expect(runHook(hookFor('agentStart', target).output, input, env)).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `${target}:${String(input.agent_id)}`,
        hookEventName: 'SubagentStart',
      },
    });
  }

  const claudeStop = JSON.parse(await readFile(
    new URL('./fixtures/events/claude-subagent-stop.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  await expect(runHook(hookFor('agentStop', 'claude').output, claudeStop, {
    PLUGIN_ROOT: undefined,
  })).resolves.toEqual({
    hookSpecificOutput: {
      additionalContext: 'Check the final result.',
      hookEventName: 'SubagentStop',
    },
  });

  const codexStop = JSON.parse(await readFile(
    new URL('./fixtures/events/codex-subagent-stop.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  codexStop.transcript_path = null;
  await expect(runHook(hookFor('agentStop', 'codex').output, codexStop, {
    PLUGIN_ROOT: output,
  })).rejects.toThrow(/not supported by the Codex SubagentStop output schema/u);
});
