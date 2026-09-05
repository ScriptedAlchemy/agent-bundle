import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import type { AgentBundleConfig } from '../src/core/types.ts';
import {
  classifyCliProjectionModule,
  extractCliProjection,
  isMisplacedCliProjectionModule,
} from '../src/routes/cli-projection.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import type { CompiledAgentRoute } from '../src/routes/types.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-cli-projection-')));
  roots.push(root);
  return root;
};

const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
};

const fixtureConfig = (extra: Readonly<Record<string, unknown>> = {}): AgentBundleConfig => ({
  plugin: { name: 'projection-fixture', version: '1.0.0' },
  ...extra,
});

const codesOf = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const toolModule = (options: {
  readonly config?: string;
  readonly schema?: string;
} = {}): string => [
  `export const config = ${options.config ?? "{ description: 'Submit work.' }"};`,
  `export const inputSchema = ${options.schema ?? 'z.object({ laneKey: z.string() }).strict()'};`,
  'export const resultSchema = z.object({ ok: z.boolean() });',
  'export default async function Tool() { return undefined; }',
  '',
].join('\n');

const cliModule = (config: string, mapInput?: string): string => [
  `export const config = ${config};`,
  ...(mapInput === undefined ? [] : [mapInput]),
  '',
].join('\n');

const projectionPath = 'src/mcp/demo/tools/submit.cli.ts';
const toolPath = 'src/mcp/demo/tools/submit.tsx';

const compileProjection = async (
  projection: string,
  options: {
    readonly config?: AgentBundleConfig;
    readonly extraFiles?: Readonly<Record<string, string>>;
    readonly tool?: string;
  } = {},
) => {
  const root = await createRoot();
  await writeTree(root, {
    [projectionPath]: projection,
    [toolPath]: options.tool ?? toolModule(),
    ...options.extraFiles,
  });
  return {
    graph: await compileRouteGraph(root, options.config ?? fixtureConfig()),
    root,
  };
};

const expectOnlyDiagnostic = (
  graph: Awaited<ReturnType<typeof compileRouteGraph>>,
  code: string,
  root: string,
  fragments: readonly string[],
  source = projectionPath,
): void => {
  expect(codesOf(graph.diagnostics)).toEqual([code]);
  expect(graph.diagnostics[0]).toMatchObject({
    severity: 'error',
    sourcePath: join(root, source),
  });
  for (const fragment of fragments) {
    expect(graph.diagnostics[0]!.message).toContain(fragment);
  }
};

describe('MCP tool CLI surface projections', () => {
  it('pairs a tool projection without creating a route or contract binding for the projection', async () => {
    expect(classifyCliProjectionModule(projectionPath)).toEqual({
      server: 'demo',
      siblingId: 'tool:demo/submit',
      stem: 'submit',
    });
    expect(classifyCliProjectionModule(toolPath)).toBeUndefined();
    expect(isMisplacedCliProjectionModule('src/mcp/demo/resources/submit.cli.ts')).toBe(true);
    expect(isMisplacedCliProjectionModule(projectionPath)).toBe(false);

    const { graph, root } = await compileProjection(cliModule('{}'));

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.commands).toHaveLength(1);
    expect(graph.cli?.commands?.[0]).toMatchObject({
      projection: { mapInput: false, module: projectionPath },
      routeId: 'tool:demo/submit',
    });
    expect(graph.cli?.routes.map((route) => route.id)).toEqual(['tool:demo/submit']);
    expect(graph.servers.flatMap((server) => server.routes).map((route) => route.id))
      .not.toContain('tool:demo/submit.cli');
    expect(graph.contracts?.flatMap((contract) => contract.routes)).toEqual(['tool:demo/submit']);
    expect(graph.cli?.projectionSources).toEqual({
      'tool:demo/submit': join(root, projectionPath),
    });
  });

  it('defaults the command to the tool name and accepts an explicit path with command aliases', async () => {
    const defaulted = await compileProjection(cliModule('{}'));
    expect(defaulted.graph.diagnostics).toEqual([]);
    expect(defaulted.graph.cli?.commands?.[0]).toMatchObject({
      aliases: [],
      path: ['submit'],
    });

    const explicit = await compileProjection(cliModule("{ aliases: ['send', 'ship'], command: ['req'] }"));
    expect(explicit.graph.diagnostics).toEqual([]);
    expect(explicit.graph.cli?.commands?.[0]).toMatchObject({
      aliases: ['send', 'ship'],
      path: ['req'],
    });
  });

  it('maps renamed, repeated, positional, aliased, defaulted, and relaxed options precisely', async () => {
    const schema = [
      'z.object({',
      '  argv: z.array(z.string()).min(1),',
      '  cwd: z.string(),',
      '  laneKey: z.string(),',
      '  limit: z.number(),',
      '  tickets: z.array(z.string()).optional(),',
      '}).strict()',
    ].join('\n');
    const projection = cliModule([
      '{',
      "  command: ['req'],",
      "  description: 'Submit from the CLI.',",
      "  positionals: ['argv'],",
      '  flags: {',
      "    cwd: { required: false },",
      "    laneKey: { aliases: ['lane-key'], description: 'Choose a lane.', name: 'lane' },",
      "    limit: { default: 20 },",
      "    tickets: { name: 'ticket' },",
      '  },',
      '}',
    ].join('\n'), 'export const mapInput = (input) => input;');
    const { graph } = await compileProjection(projection, { tool: toolModule({ schema }) });

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.commands).toEqual([{
      aliases: [],
      description: 'Submit from the CLI.',
      exitCode: 'zero',
      mcp: { confirm: true, server: 'demo', tool: 'submit' },
      options: [
        {
          key: 'argv',
          kind: 'string',
          option: 'argv',
          positional: 0,
          repeated: true,
          required: true,
        },
        {
          key: 'cwd',
          kind: 'string',
          option: 'cwd',
          repeated: false,
          required: false,
        },
        {
          aliases: ['lane-key'],
          description: 'Choose a lane.',
          key: 'laneKey',
          kind: 'string',
          option: 'lane',
          repeated: false,
          required: true,
        },
        {
          defaultValue: 20,
          key: 'limit',
          kind: 'number',
          option: 'limit',
          repeated: false,
          required: false,
        },
        {
          key: 'tickets',
          kind: 'string',
          option: 'ticket',
          repeated: true,
          required: false,
        },
        {
          description: 'Confirm running this mutation-capable MCP tool.',
          key: 'yes',
          kind: 'boolean',
          option: 'yes',
          repeated: false,
          required: false,
        },
      ],
      path: ['req'],
      projection: {
        mapInput: true,
        module: projectionPath,
        relaxed: ['cwd', 'limit'],
      },
      rendered: true,
      routeId: 'tool:demo/submit',
    }]);
  });

  it('derives confirmation and metadata defaults while honoring projection and tool overrides', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/demo/tools/override.cli.ts': cliModule('{ confirm: false }'),
      'src/mcp/demo/tools/override.tsx': toolModule({
        config: "{ description: 'Override confirmation.' }",
      }),
      'src/mcp/demo/tools/read.cli.ts': cliModule("{ exitCode: 'zero' }"),
      'src/mcp/demo/tools/read.tsx': toolModule({
        config: "{ annotations: { readOnlyHint: true }, description: 'Read safely.', exitCode: 'result', render: { maxElapsedMs: 120000 } }",
      }),
      'src/mcp/demo/tools/write.cli.ts': cliModule('{}'),
      'src/mcp/demo/tools/write.tsx': toolModule({
        config: "{ annotations: { readOnlyHint: false }, description: 'Write data.', exitCode: 'result' }",
      }),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());

    expect(graph.diagnostics).toEqual([]);
    const commands = Object.fromEntries(
      graph.cli!.commands!.map((command) => [command.routeId, command]),
    );
    expect(commands['tool:demo/read']).toMatchObject({
      description: 'Read safely.',
      exitCode: 'zero',
      mcp: { confirm: false, server: 'demo', tool: 'read' },
      render: { maxElapsedMs: 120_000 },
    });
    expect(commands['tool:demo/read']!.options.map((option) => option.option)).not.toContain('yes');
    expect(commands['tool:demo/write']).toMatchObject({
      description: 'Write data.',
      exitCode: 'result',
      mcp: { confirm: true, server: 'demo', tool: 'write' },
    });
    expect(commands['tool:demo/write']!.options).toContainEqual(
      expect.objectContaining({ key: 'yes', option: 'yes' }),
    );
    expect(commands['tool:demo/override']).toMatchObject({
      description: 'Override confirmation.',
      exitCode: 'zero',
      mcp: { confirm: false, server: 'demo', tool: 'override' },
    });
    expect(commands['tool:demo/override']!.options.map((option) => option.option)).not.toContain('yes');
  });

  it('reports AB4840 for orphan and misplaced projections while private projections stay parked', async () => {
    const orphanRoot = await createRoot();
    await writeTree(orphanRoot, {
      'src/mcp/demo/tools/ghost.cli.ts': cliModule('{}'),
    });
    const orphan = await compileRouteGraph(orphanRoot, fixtureConfig());
    expectOnlyDiagnostic(
      orphan,
      'AB4840',
      orphanRoot,
      ['CLI projection src/mcp/demo/tools/ghost.cli.ts', 'tool:demo/ghost', 'no sibling'],
      'src/mcp/demo/tools/ghost.cli.ts',
    );

    const misplacedRoot = await createRoot();
    await writeTree(misplacedRoot, {
      'src/mcp/demo/resources/submit.cli.ts': cliModule('{}'),
    });
    const misplaced = await compileRouteGraph(misplacedRoot, fixtureConfig());
    expectOnlyDiagnostic(
      misplaced,
      'AB4840',
      misplacedRoot,
      ['CLI projection src/mcp/demo/resources/submit.cli.ts', 'tool'],
      'src/mcp/demo/resources/submit.cli.ts',
    );

    const parkedRoot = await createRoot();
    await writeTree(parkedRoot, {
      'src/mcp/demo/tools/_parked.cli.ts': cliModule('{}'),
    });
    const parked = await compileRouteGraph(parkedRoot, fixtureConfig());
    expect(parked.diagnostics).toEqual([]);
    expect(parked.cli).toBeUndefined();
    expect(parked.servers).toEqual([]);
  });

  it('reports AB4841 for non-static config, closed-shape, mapper, and required-relaxation violations', async () => {
    const source = '/project/src/mcp/demo/tools/submit.cli.ts';
    const tool: CompiledAgentRoute = {
      config: {},
      id: 'tool:demo/submit',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: toolPath },
      serverId: 'mcp:demo',
      source: '/project/src/mcp/demo/tools/submit.tsx',
    };
    const extracted = extractCliProjection(
      'export const config = build();\n',
      projectionPath,
      source,
      undefined,
      tool,
      { projectRoot: '/project' },
    );
    expect(codesOf(extracted.diagnostics)).toEqual(['AB4841']);
    expect(extracted.diagnostics[0]).toMatchObject({ severity: 'error', sourcePath: source });
    expect(extracted.diagnostics[0]!.message).toContain(`CLI projection ${projectionPath}`);
    expect(extracted.diagnostics[0]!.message).toContain('config');

    const cases: readonly [projection: string, tool: string, fragments: readonly string[]][] = [
      [cliModule("{ render: { maxElapsedMs: 1000 } }"), toolModule(), ['config.render', 'unknown']],
      [cliModule("{ command: 'submit' }"), toolModule(), ['config.command', 'array']],
      [cliModule('{}', 'export const mapInput = pipe(identity);'), toolModule(), ['mapInput', 'function']],
      [
        cliModule("{ flags: { laneKey: { required: false } } }"),
        toolModule(),
        ['flags.laneKey.required', 'mapInput'],
      ],
      [
        cliModule("{ flags: { laneKey: { default: 'main' } } }"),
        toolModule(),
        ['flags.laneKey.default', 'mapInput'],
      ],
    ];
    for (const [projection, toolSource, fragments] of cases) {
      const result = await compileProjection(projection, { tool: toolSource });
      expectOnlyDiagnostic(result.graph, 'AB4841', result.root, fragments);
    }
  });

  it('reports AB4842 for unknown keys, invalid spellings, collisions, unsafe paths, and reserved yes', async () => {
    const twoKeys = toolModule({
      schema: 'z.object({ first: z.string().optional(), second: z.string().optional() }).strict()',
    });
    const cases: readonly [projection: string, tool: string, fragments: readonly string[]][] = [
      [cliModule("{ flags: { nope: {} } }"), toolModule(), ['flags.nope', 'input']],
      [cliModule("{ positionals: ['nope'] }"), toolModule(), ['positionals', 'nope']],
      [cliModule("{ flags: { laneKey: { name: 'json' } } }"), toolModule(), ['--json', 'reserved']],
      [cliModule("{ flags: { laneKey: { name: 'Lane' } } }"), toolModule(), ['Lane', 'kebab-case']],
      [
        cliModule("{ flags: { first: { name: 'same' }, second: { name: 'same' } } }"),
        twoKeys,
        ['--same', 'both'],
      ],
      [
        cliModule("{ flags: { first: { aliases: ['second'] } } }"),
        twoKeys,
        ['--second', 'collid'],
      ],
      [cliModule("{ command: ['bad segment!'] }"), toolModule(), ['bad segment!', 'safe']],
      [cliModule("{ flags: { laneKey: { name: 'yes' } } }"), toolModule(), ['--yes', 'reserved']],
    ];
    for (const [projection, toolSource, fragments] of cases) {
      const result = await compileProjection(projection, { tool: toolSource });
      expectOnlyDiagnostic(result.graph, 'AB4842', result.root, fragments);
    }
  });

  it('excludes explicit projections from bulk MCP commands and diagnoses projected-only includes', async () => {
    const all = await compileProjection(cliModule('{}'), {
      config: fixtureConfig({ routes: { mcpCommands: true } }),
    });
    expect(all.graph.diagnostics).toEqual([]);
    expect(all.graph.cli?.commands?.map((command) => ({
      path: command.path,
      projection: command.projection,
      routeId: command.routeId,
    }))).toEqual([{
      path: ['submit'],
      projection: { mapInput: false, module: projectionPath },
      routeId: 'tool:demo/submit',
    }]);
    expect(all.graph.cli?.commands?.map((command) => command.path.join(' ')))
      .not.toContain('demo submit');

    const selected = await compileProjection(cliModule('{}'), {
      config: fixtureConfig({
        routes: { mcpCommands: { include: ['demo:submit'] } },
      }),
    });
    expect(codesOf(selected.graph.diagnostics)).toEqual(['AB4822']);
    expect(selected.graph.diagnostics[0]!.message).toContain('demo:submit');
    expect(selected.graph.diagnostics[0]!.message).toContain(projectionPath);
    expect(selected.graph.cli?.commands?.filter((command) =>
      command.routeId === 'tool:demo/submit')).toHaveLength(1);
  });

  it('reports AB4813 when a projection command collides with a conventional CLI route', async () => {
    const { graph } = await compileProjection(cliModule("{ command: ['status'] }"), {
      extraFiles: {
        'src/cli/status.ts': [
          'export const inputSchema = z.object({}).strict();',
          'export const resultSchema = z.object({});',
          'export default async function Status() { return undefined; }',
          '',
        ].join('\n'),
      },
    });

    expect(codesOf(graph.diagnostics)).toEqual(['AB4813']);
    expect(graph.diagnostics[0]!.message).toContain('status');
    expect(graph.diagnostics[0]!.message).toContain(projectionPath);
    expect(graph.diagnostics[0]!.recovery).toContain(projectionPath);
    expect(graph.diagnostics[0]!.recovery).toContain('command');
  });

  it('relabels AB4814 and AB4838 for projected tools without a static contract', async () => {
    const nested = await compileProjection(cliModule('{}'), {
      tool: toolModule({
        schema: 'z.object({ nested: z.object({ a: z.string() }) }).strict()',
      }),
    });
    expectOnlyDiagnostic(
      nested.graph,
      'AB4814',
      nested.root,
      [`Tool route ${toolPath} (CLI projection ${projectionPath})`, 'z.object'],
      toolPath,
    );

    const external = await compileProjection(cliModule('{}'), {
      tool: [
        "import { external } from 'schema-package';",
        "export const config = { description: 'Submit work.' };",
        'export const inputSchema = external;',
        'export const resultSchema = z.object({ ok: z.boolean() });',
        'export default async function Tool() { return undefined; }',
        '',
      ].join('\n'),
    });
    expectOnlyDiagnostic(
      external.graph,
      'AB4838',
      external.root,
      [
        `Tool route ${toolPath} (CLI projection ${projectionPath})`,
        'inputSchema -> external',
        // The reason is input-schema.ts's existing AB4838 wording, relabelled.
        'imported from "schema-package", which is not a relative module path',
      ],
      toolPath,
    );
  });

  it('reports AB4837 when a projection value-imports the compiler-bearing API entry', async () => {
    const { graph, root } = await compileProjection([
      "import { defineConfig } from 'agent-bundle/api';",
      'void defineConfig;',
      'export const config = {};',
      '',
    ].join('\n'));

    expectOnlyDiagnostic(
      graph,
      'AB4837',
      root,
      ['CLI projection module', projectionPath, 'agent-bundle/api'],
    );
  });

  it('keeps absolute projection sources out of the digest and includes relative option policy', async () => {
    const first = await compileProjection(cliModule('{}'));
    const second = await compileProjection(cliModule('{}'));
    expect(first.root).not.toBe(second.root);
    expect(first.graph.cli?.projectionSources).not.toEqual(second.graph.cli?.projectionSources);
    expect(first.graph.digest).toBe(second.graph.digest);

    const renamed = await compileProjection(cliModule(
      "{ flags: { laneKey: { name: 'lane' } } }",
    ));
    expect(renamed.graph.diagnostics).toEqual([]);
    expect(renamed.graph.cli?.commands?.[0]?.options).toContainEqual(
      expect.objectContaining({ key: 'laneKey', option: 'lane' }),
    );
    expect(renamed.graph.digest).not.toBe(first.graph.digest);
  });

  it('silently skips a projection whose sibling belongs to a custom server override', async () => {
    const { graph } = await compileProjection(cliModule('{}'), {
      config: fixtureConfig({ routes: { servers: { demo: 'custom' } } }),
    });

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli).toBeUndefined();
    expect(graph.servers).toEqual([{
      id: 'mcp:demo',
      mode: 'custom',
      name: 'demo',
      routes: [],
    }]);
  });
});
