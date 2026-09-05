import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { build, inspect } from '../src/api.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import type {
  CompiledAgentRoute,
  CompiledCliCommand,
  CompiledRouteGraph,
  RouteInputSchema,
} from '../src/routes/types.ts';

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

type FixtureVariant = 'bare' | 'imported' | 'inline';

interface RouteContractView {
  readonly id: string;
  readonly input: RouteInputSchema;
  readonly origin: {
    readonly binding: string;
    readonly module: string;
  };
  readonly routes: readonly string[];
}

type RouteWithContract = CompiledAgentRoute & { readonly contract?: string };
type RouteContractGraph = CompiledRouteGraph & {
  readonly contracts?: readonly RouteContractView[];
};

const inputProperties = [
  "  laneKey: z.string().min(1).optional(),",
  "  limit: z.number().int().min(1).max(500).optional().describe('Recent rows'),",
  "  statuses: z.array(z.enum(['requested', 'queued', 'running', 'done'])).max(8).optional(),",
  "  tickets: z.array(z.string().min(1)).max(100).optional(),",
];

const inlineInputSchema = [
  'z.object({',
  ...inputProperties,
  '}).strict()',
].join('\n');

const importedProtocolSchemas = (variant: 'bare' | 'imported'): string => [
  "import { z } from 'zod';",
  variant === 'bare'
    ? "import { requestStatuses } from '@shared/protocol';"
    : "import { requestStatuses } from '../daemon/protocol.js';",
  '',
  'const requestStatusSchema = z.enum(requestStatuses);',
  'export const statusInputSchema = z.object({',
  "  laneKey: z.string().min(1).optional(),",
  "  limit: z.number().int().min(1).max(500).optional().describe('Recent rows'),",
  '  statuses: z.array(requestStatusSchema).max(8).optional(),',
  '  tickets: z.array(z.string().min(1)).max(100).optional(),',
  '}).strict();',
  "export const statusResultSchema = z.object({ filters: statusInputSchema, operation: z.literal('status') });",
  '',
].join('\n');

const cliRoute = (variant: FixtureVariant): string => variant === 'inline'
  ? [
      "import { z } from 'zod';",
      '',
      "export const config = { description: 'Show the queue.' };",
      `export const inputSchema = ${inlineInputSchema};`,
      "export const resultSchema = z.object({ filters: inputSchema, operation: z.literal('status') });",
      "export default async function status({ input }: { input: z.infer<typeof inputSchema> }) {",
      "  return { filters: input, operation: 'status' };",
      '}',
      '',
    ].join('\n')
  : [
      "import type { z } from 'zod';",
      '',
      "import { statusInputSchema, statusResultSchema } from '../lib/protocol-schemas.js';",
      '',
      "export const config = { description: 'Show the queue.' };",
      'export const inputSchema = statusInputSchema;',
      'export const resultSchema = statusResultSchema;',
      "export default async function status({ input }: { input: z.infer<typeof inputSchema> }) {",
      "  return { filters: input, operation: 'status' };",
      '}',
      '',
    ].join('\n');

const toolRoute = (variant: FixtureVariant): string => variant === 'inline'
  ? [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      '',
      "export const config = { description: 'Show the queue.' };",
      `export const inputSchema = ${inlineInputSchema};`,
      "export const resultSchema = z.object({ filters: inputSchema, operation: z.literal('status') });",
      'export default async function HaulerStatus({ input }: { input: z.infer<typeof inputSchema> }) {',
      "  const result = { filters: input, operation: 'status' };",
      '  return <Agent.Result value={result}><Agent.Text>Queue status.</Agent.Text></Agent.Result>;',
      '}',
      '',
    ].join('\n')
  : [
      "import { Agent } from '@agent-bundle/runtime';",
      "import type { z } from 'zod';",
      '',
      "import { statusInputSchema, statusResultSchema } from '../../../lib/protocol-schemas.js';",
      '',
      "export const config = { description: 'Show the queue.' };",
      'export const inputSchema = statusInputSchema;',
      'export const resultSchema = statusResultSchema;',
      'export default async function HaulerStatus({ input }: { input: z.infer<typeof inputSchema> }) {',
      "  const result = { filters: input, operation: 'status' };",
      '  return <Agent.Result value={result}><Agent.Text>Queue status.</Agent.Text></Agent.Result>;',
      '}',
      '',
    ].join('\n');

const writeFixture = async (variant: FixtureVariant): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-route-contract-${variant}-`));
  roots.push(root);
  await symlink(
    join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const name = `route-contract-${variant}-fixture`;
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name,
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      `  plugin: { description: 'Route contract fixture.', name: '${name}', version: '1.0.0' },`,
      '  routes: { mcpCommands: true },',
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(
      root,
      'src/daemon/protocol.ts',
      "export const requestStatuses = ['requested', 'queued', 'running', 'done'] as const;\n",
    ),
    ...(variant === 'inline'
      ? []
      : [writeProjectFile(
          root,
          'src/lib/protocol-schemas.ts',
          importedProtocolSchemas(variant),
        )]),
    writeProjectFile(root, 'src/cli/status.ts', cliRoute(variant)),
    writeProjectFile(root, 'src/mcp/hauler/tools/hauler_status.tsx', toolRoute(variant)),
  ]);
  return root;
};

const routeGraph = async (root: string): Promise<RouteContractGraph> => {
  const graph = await compileRouteGraph(root, {
    plugin: { name: 'route-contract-fixture', version: '1.0.0' },
    routes: { mcpCommands: true },
    targets: ['portable'],
  });
  expect(graph.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    sourcePath: diagnostic.sourcePath,
  }))).toEqual([]);
  return graph as RouteContractGraph;
};

const routeById = (graph: RouteContractGraph, id: string): RouteWithContract | undefined => [
  ...(graph.cli?.routes ?? []),
  ...graph.servers.flatMap((server) => server.routes),
].find((route) => route.id === id);

const commandById = (
  graph: RouteContractGraph,
  id: string,
): CompiledCliCommand | undefined => graph.cli?.commands?.find((command) => command.routeId === id);

const writeTypeProbe = async (root: string): Promise<void> => {
  await writeProjectFile(root, 'types-probe.ts', [
    "import type { RouteInput, RouteResult } from './.agent-bundle/routes.js';",
    '',
    'type Equals<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    "type Status = 'requested' | 'queued' | 'running' | 'done';",
    '',
    "const _input: Equals<RouteInput<'cli:status'>, RouteInput<'tool:hauler/hauler_status'>> = true;",
    "const _result: Equals<RouteResult<'cli:status'>, RouteResult<'tool:hauler/hauler_status'>> = true;",
    "const _statuses: Equals<Pick<RouteInput<'cli:status'>, 'statuses'>, { statuses?: Status[] | undefined }> = true;",
    'void _input; void _result; void _statuses;',
    '',
  ].join('\n'));
};

const typecheckProbe = (root: string): readonly string[] => {
  const program = ts.createProgram(
    [join(root, 'types-probe.ts'), join(root, '.agent-bundle', 'routes.d.ts')],
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

it('shares imported route contracts across graph, argv, runtime, and generated types', { timeout: 120_000 }, async () => {
  const [bareRoot, importedRoot, inlineRoot] = await Promise.all([
    writeFixture('bare'),
    writeFixture('imported'),
    writeFixture('inline'),
  ]);

  const [importedGraph, inlineGraph] = await Promise.all([
    routeGraph(importedRoot),
    routeGraph(inlineRoot),
  ]);
  expect(importedGraph.contracts).toHaveLength(1);
  expect(importedGraph.contracts?.[0]).toMatchObject({
    id: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
    origin: {
      binding: 'statusInputSchema',
      module: 'src/lib/protocol-schemas.ts',
    },
    routes: ['cli:status', 'tool:hauler/hauler_status'],
  });

  const importedCli = routeById(importedGraph, 'cli:status');
  const importedTool = routeById(importedGraph, 'tool:hauler/hauler_status');
  const inlineTool = routeById(inlineGraph, 'tool:hauler/hauler_status');
  expect(importedCli?.contract).toBe('contract:src/lib/protocol-schemas.ts#statusInputSchema');
  expect(importedTool?.contract).toBe('contract:src/lib/protocol-schemas.ts#statusInputSchema');
  expect(commandById(importedGraph, 'cli:status')?.options)
    .toEqual(commandById(inlineGraph, 'cli:status')?.options);
  expect(importedTool?.inputSchema).toEqual(inlineTool?.inputSchema);
  expect(importedCli?.inputSchema).toBe(importedTool?.inputSchema);

  const built = await build({ output: 'artifact', packageOutputs: true, root: importedRoot });
  expect(built.diagnostics).toEqual([]);
  const binPath = join(importedRoot, 'dist', 'bin', 'route-contract-imported-fixture.js');
  const help = await execFile(binPath, ['status', '--help']);
  for (const option of ['--lane-key', '--limit', '--statuses', '--tickets']) {
    expect(help.stdout).toContain(option);
  }
  for (const choice of ['requested', 'queued', 'running', 'done']) {
    expect(help.stdout).toContain(choice);
  }
  const status = await execFile(binPath, [
    'status',
    '--statuses', 'queued',
    '--statuses', 'done',
    '--limit', '3',
    '--json',
  ]);
  expect(JSON.parse(status.stdout)).toEqual({
    filters: {
      limit: 3,
      statuses: ['queued', 'done'],
    },
    operation: 'status',
  });
  await expect(execFile(binPath, ['status', '--statuses', 'bogus']))
    .rejects.toMatchObject({ code: 2 });

  const inlineInspection = await inspect({ focus: 'routes', root: inlineRoot });
  expect(inlineInspection.diagnostics).toEqual([]);
  await Promise.all([writeTypeProbe(importedRoot), writeTypeProbe(inlineRoot)]);
  const importedTypes = typecheckProbe(importedRoot);
  const inlineTypes = typecheckProbe(inlineRoot);
  expect(importedTypes).toEqual(inlineTypes);
  expect(importedTypes).toEqual([]);

  const bareGraph = await compileRouteGraph(bareRoot, {
    plugin: { name: 'route-contract-bare-fixture', version: '1.0.0' },
    routes: { mcpCommands: true },
    targets: ['portable'],
  }) as RouteContractGraph;
  expect(bareGraph.diagnostics).toEqual([
    expect.objectContaining({
      code: 'AB4838',
      message: expect.stringContaining(
        'inputSchema -> statusInputSchema (src/lib/protocol-schemas.ts) -> requestStatusSchema -> requestStatuses',
      ),
      sourcePath: join(bareRoot, 'src', 'cli', 'status.ts'),
    }),
  ]);
  expect(bareGraph.diagnostics[0]?.message).toContain('is not a relative module path');
  const bareCli = routeById(bareGraph, 'cli:status');
  const bareTool = routeById(bareGraph, 'tool:hauler/hauler_status');
  expect(bareCli).not.toHaveProperty('contract');
  expect(bareCli).not.toHaveProperty('inputSchema');
  expect(bareTool).not.toHaveProperty('contract');
  expect(bareTool).not.toHaveProperty('inputSchema');
});
