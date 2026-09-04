import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';

const execFile = promisify(executeFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const lookupRoute = [
  "import { Agent, agent } from '@agent-bundle/runtime';",
  "import { z } from 'zod';",
  "export const config = { annotations: { readOnlyHint: true }, description: 'Looks up one value.' };",
  'export const inputSchema = z.object({ message: z.string().default("ready") }).strict();',
  "export const resultSchema = z.object({ invocation: z.literal('tool'), message: z.string() }).strict();",
  'export default async function Lookup({ input }) {',
  '  const context = await agent();',
  '  const result = { invocation: context.invocation.kind, message: input.message };',
  '  return <Agent.Result metadata={{ from: "route" }} value={result}><Agent.Markdown>{`Lookup: ${input.message}`}</Agent.Markdown></Agent.Result>;',
  '}',
  '',
].join('\n');

const explodeRoute = [
  "import { z } from 'zod';",
  "export const config = { annotations: { readOnlyHint: true }, description: 'Throws before rendering.' };",
  'export const inputSchema = z.object({}).strict();',
  'export const resultSchema = z.object({ ok: z.boolean() }).strict();',
  'export default async function Explode() {',
  "  throw new Error('lookup exploded');",
  '}',
  '',
].join('\n');

/** Writes one project with a root layout, a `harness` server layout, an MCP server, a routed CLI, and a rendered script. */
const writeLayoutProject = async (root: string, layouts: Readonly<Record<string, string>>): Promise<void> => {
  // The audiobook example's installed tree supplies @agent-bundle/runtime, react, and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'layout-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { description: 'Layout fixture.', name: 'layout-fixture', version: '1.0.0' },",
      '  routes: { mcpCommands: true },',
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    ...Object.entries(layouts).map(([path, contents]) => writeProjectFile(root, path, contents)),
    writeProjectFile(root, 'src/mcp/harness/tools/lookup.tsx', lookupRoute),
    writeProjectFile(root, 'src/mcp/harness/tools/explode.tsx', explodeRoute),
    writeProjectFile(root, 'src/cli/report.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Render a library report.', positionals: ['root'] };",
      'export const inputSchema = z.object({ root: z.string().min(1) }).strict();',
      'export const resultSchema = z.object({ books: z.number(), root: z.string() }).strict();',
      'export default async function Report({ input }) {',
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'scanning', total: 1 });",
      '  const result = { books: 2, root: input.root };',
      '  return <Agent.Result value={result}><Agent.Markdown>{`Found **2** books under ${input.root}.`}</Agent.Markdown></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/scripts/summarize.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      'export default async function Summarize({ argv }) {',
      '  return <Agent.Result value={{ arguments: argv.length }}><Agent.Text>{`Summarized ${String(argv.length)} arguments.`}</Agent.Text></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
  ]);
};

const rootLayout = [
  "import { Agent, agent } from '@agent-bundle/runtime';",
  'export default async function Layout({ children, route }) {',
  '  const context = await agent();',
  '  return (',
  '    <Agent.Result metadata={{ invocation: context.invocation.kind, shell: "layout-fixture", wrapped: route.kind }}>',
  '      {children}',
  '      <Agent.Context>{`shell: ${route.kind} ${route.name}`}</Agent.Context>',
  '    </Agent.Result>',
  '  );',
  '}',
  '',
].join('\n');

const serverLayout = [
  "import { Agent } from '@agent-bundle/runtime';",
  'export default function HarnessLayout({ children, route }) {',
  '  return (',
  '    <Agent.Result metadata={{ layout: "harness", route: route.id }}>',
  '      <Agent.Text>{`server: ${route.serverId}`}</Agent.Text>',
  '      {children}',
  '    </Agent.Result>',
  '  );',
  '}',
  '',
].join('\n');

const connectServer = async (root: string, entry: string): Promise<{ readonly client: Client; readonly close: () => Promise<void> }> => {
  const client = new Client({ name: 'layout-build-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
  }
  return { client, close: async () => { await client.close(); } };
};

/**
 * The shared layout convention (#312) at the built-artifact level: the root
 * `src/layout.tsx` and the `src/mcp/harness/layout.tsx` server layout compose
 * around every rendered surface one build ships — the generated MCP server,
 * the routed CLI executable, its projected MCP commands, and a rendered
 * script — while every route keeps its own result value and a throwing route
 * still fails closed.
 */
it('composes the root and server layouts around every rendered surface of one build', { retry: 2, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-layout-build-'));
  roots.push(root);
  await writeLayoutProject(root, {
    'src/layout.tsx': rootLayout,
    'src/mcp/harness/layout.tsx': serverLayout,
  });

  const output = join(root, 'artifact');
  const result = await build({ output, packageOutputs: true, root });
  expect(result.model.layouts?.map((layout) => layout.id)).toEqual(['layout:root', 'layout:mcp:harness']);
  // Layout modules are source inputs of every worker that composes them.
  const binEvidence = result.packageBuild!.files.find((file) => file.path === 'bin/layout-fixture-flight.mjs');
  expect(binEvidence?.sourceInputs).toEqual(expect.arrayContaining(['src/layout.tsx', 'src/mcp/harness/layout.tsx']));

  // The generated MCP server composes root + server layout around a tool and
  // keeps the route's value as structuredContent.
  const server = result.model.mcpServers[0];
  if (server?.args?.[0] === undefined) throw new Error('expected a generated MCP entry');
  const session = await connectServer(root, join(output, 'portable', server.args[0]));
  try {
    const lookup = await session.client.callTool({ arguments: { message: 'wired' }, name: 'lookup' }, { signal: AbortSignal.timeout(20_000) });
    expect(lookup).toMatchObject({
      content: [
        { text: 'server: mcp:harness', type: 'text' },
        { text: 'Lookup: wired', type: 'text' },
        { text: 'shell: tool lookup', type: 'text' },
      ],
      structuredContent: { invocation: 'tool', message: 'wired' },
    });
    expect(lookup.isError).toBeFalsy();
    // A throwing route under a layout fails closed exactly like a throwing root.
    const exploded = await session.client.callTool({ arguments: {}, name: 'explode' }, { signal: AbortSignal.timeout(20_000) })
      .catch((error: unknown) => error);
    const rendered = exploded instanceof Error ? `${exploded.name} ${exploded.message}` : JSON.stringify(exploded);
    expect(rendered).toContain('lookup exploded');
    expect(rendered).not.toContain('shell: tool explode');
  } finally {
    await session.close();
  }

  // The routed CLI: a rendered command takes only the root layout.
  const binPath = join(root, 'dist', 'bin', 'layout-fixture.js');
  const piped = await execFile(binPath, ['report', '/library']);
  expect(piped.stdout).toBe('Found **2** books under /library.\n\n> shell: cli report\n');
  const reportJson = await execFile(binPath, ['report', '/library', '--json']);
  expect(JSON.parse(reportJson.stdout)).toEqual({ books: 2, root: '/library' });
  const reportEvents = await execFile(binPath, ['report', '/library', '--ndjson']);
  const complete = reportEvents.stdout.trimEnd().split('\n')
    .map((line) => JSON.parse(line) as { document?: { root: { kind: string; metadata?: unknown }; value?: unknown }; type: string })
    .findLast((event) => event.type === 'complete');
  expect(complete?.document).toMatchObject({
    root: { kind: 'result', metadata: { invocation: 'cli', shell: 'layout-fixture', wrapped: 'cli' } },
    value: { books: 2, root: '/library' },
  });

  // A projected MCP command keeps its tool route's server layout, and the
  // route's own metadata merges beneath both layouts.
  const projected = await execFile(binPath, ['harness', 'lookup', '--input', '{"message":"projected"}']);
  expect(projected.stdout).toBe('server: mcp:harness\n\nLookup: projected\n\n> shell: tool lookup\n');
  const projectedEvents = await execFile(binPath, ['harness', 'lookup', '--input', '{"message":"events"}', '--ndjson']);
  const projectedComplete = projectedEvents.stdout.trimEnd().split('\n')
    .map((line) => JSON.parse(line) as { document?: { root: { metadata?: unknown }; value?: unknown }; type: string })
    .findLast((event) => event.type === 'complete');
  expect(projectedComplete?.document).toMatchObject({
    root: {
      metadata: { from: 'route', invocation: 'tool', layout: 'harness', route: 'tool:harness/lookup', shell: 'layout-fixture', wrapped: 'tool' },
    },
    value: { invocation: 'tool', message: 'events' },
  });
  await expect(execFile(binPath, ['harness', 'explode', '--input', '{}'])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('lookup exploded'),
    stdout: '',
  });

  // The artifact-hosted executable (`<target>/bin/<name>.mjs`) composes the
  // same chains as the package-built one, and its worker lists the layouts
  // among its source inputs.
  const hostedBin = result.build.compiledCliBins.find((bin) => bin.target === 'portable');
  expect(hostedBin?.workerSourceInputs).toEqual(expect.arrayContaining([
    join(root, 'src/layout.tsx'),
    join(root, 'src/mcp/harness/layout.tsx'),
  ]));
  const hostedBinPath = join(output, 'portable', 'bin', 'layout-fixture.mjs');
  const hostedReport = await execFile(process.execPath, [hostedBinPath, 'report', '/library']);
  expect(hostedReport.stdout).toBe(piped.stdout);
  const hostedProjected = await execFile(process.execPath, [hostedBinPath, 'harness', 'lookup', '--input', '{"message":"projected"}']);
  expect(hostedProjected.stdout).toBe(projected.stdout);

  // A rendered script takes the root layout.
  const scriptPath = join(output, 'portable', 'scripts', 'summarize.mjs');
  const scriptMarkdown = await execFile(process.execPath, [scriptPath, 'alpha', 'beta']);
  expect(scriptMarkdown.stdout).toBe('Summarized 2 arguments.\n\n> shell: script summarize\n');
  const scriptJson = await execFile(process.execPath, [scriptPath, 'alpha', '--json']);
  expect(JSON.parse(scriptJson.stdout)).toEqual({ arguments: 1 });
});

it('ships byte-identical surfaces when no layout exists and refuses an invalid layout module before building', { retry: 2, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-layout-free-'));
  roots.push(root);
  await writeLayoutProject(root, {});

  const output = join(root, 'artifact');
  const result = await build({ output, packageOutputs: true, root });
  expect(result.model.layouts).toBeUndefined();
  const binPath = join(root, 'dist', 'bin', 'layout-fixture.js');
  const piped = await execFile(binPath, ['report', '/library']);
  expect(piped.stdout).toBe('Found **2** books under /library.\n');
  const projected = await execFile(binPath, ['harness', 'lookup', '--input', '{"message":"plain"}']);
  expect(projected.stdout).toBe('Lookup: plain\n');
  const scriptMarkdown = await execFile(process.execPath, [join(output, 'portable', 'scripts', 'summarize.mjs'), 'alpha']);
  expect(scriptMarkdown.stdout).toBe('Summarized 1 arguments.\n');

  // An invalid layout module is a compile-time error (AB4830), never a runtime surprise.
  await writeProjectFile(root, 'src/layout.tsx', 'export default { children: undefined };\n');
  await expect(build({ output, packageOutputs: true, root })).rejects.toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB4830', severity: 'error' })],
    name: 'DiagnosticError',
  });
});
