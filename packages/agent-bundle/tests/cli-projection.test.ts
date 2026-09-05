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
      '  verbose: z.boolean().default(false),',
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
          defaultValue: false,
          key: 'verbose',
          kind: 'boolean',
          option: 'verbose',
          repeated: false,
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
        defaults: { limit: 20 },
        mapInput: true,
        module: projectionPath,
        relaxed: ['cwd', 'limit'],
      },
      rendered: true,
      routeId: 'tool:demo/submit',
    }]);
  });

  it('records projection defaults apart from schema defaults, sorted, and omits the record without one', async () => {
    const schema = [
      'z.object({',
      "  mode: z.enum(['fast', 'full']).default('fast'),",
      '  retries: z.number().optional(),',
      '  tags: z.array(z.string()).optional(),',
      '}).strict()',
    ].join('\n');
    const projected = await compileProjection(
      cliModule("{ flags: { mode: { default: 'full' }, tags: { default: ['a', 'b'] } } }"),
      { tool: toolModule({ schema }) },
    );
    expect(projected.graph.diagnostics).toEqual([]);
    const command = projected.graph.cli!.commands![0]!;
    expect(command.projection).toEqual({
      defaults: { mode: 'full', tags: ['a', 'b'] },
      mapInput: false,
      module: projectionPath,
    });
    expect(Object.keys(command.projection!.defaults!)).toEqual(['mode', 'tags']);
    expect(command.options.find((option) => option.key === 'mode')).toMatchObject({ defaultValue: 'full', required: false });
    expect(command.options.find((option) => option.key === 'retries')).not.toHaveProperty('defaultValue');

    const schemaOnly = await compileProjection(cliModule('{}'), { tool: toolModule({ schema }) });
    expect(schemaOnly.graph.diagnostics).toEqual([]);
    expect(schemaOnly.graph.cli?.commands?.[0]?.projection).toEqual({ mapInput: false, module: projectionPath });
    expect(schemaOnly.graph.cli?.commands?.[0]?.options.find((option) => option.key === 'mode'))
      .toMatchObject({ defaultValue: 'fast' });
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

  it('reports AB4840 for orphan, duplicate, and misplaced projections while private projections stay parked', async () => {
    const orphanRoot = await createRoot();
    await writeTree(orphanRoot, {
      'src/mcp/demo/tools/ghost.cli.ts': cliModule('{}'),
    });
    const orphan = await compileRouteGraph(orphanRoot, fixtureConfig());
    expectOnlyDiagnostic(
      orphan,
      'AB4840',
      orphanRoot,
      ['CLI projection src/mcp/demo/tools/ghost.cli.ts for tool:demo/ghost: has no sibling tool route'],
      'src/mcp/demo/tools/ghost.cli.ts',
    );

    const duplicate = await compileProjection(cliModule('{}'), {
      extraFiles: { 'src/mcp/demo/tools/submit.cli.tsx': cliModule('{}') },
    });
    expectOnlyDiagnostic(
      duplicate.graph,
      'AB4840',
      duplicate.root,
      [
        'CLI projection src/mcp/demo/tools/submit.cli.tsx for tool:demo/submit: src/mcp/demo/tools/submit.cli.ts already projects this tool',
      ],
      'src/mcp/demo/tools/submit.cli.tsx',
    );
    expect(duplicate.graph.cli?.commands?.map((command) => command.projection?.module)).toEqual([projectionPath]);

    const misplacedRoot = await createRoot();
    await writeTree(misplacedRoot, {
      'src/mcp/demo/resources/submit.cli.ts': cliModule('{}'),
    });
    const misplaced = await compileRouteGraph(misplacedRoot, fixtureConfig());
    expectOnlyDiagnostic(
      misplaced,
      'AB4840',
      misplacedRoot,
      ['CLI projection src/mcp/demo/resources/submit.cli.ts: sits under resources/', 'tool'],
      'src/mcp/demo/resources/submit.cli.ts',
    );
    expect(misplaced.diagnostics[0]!.message).not.toContain(' for tool:');

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

  describe('mapInput must be a synchronous, non-generator function with a runtime binding', () => {
    const subject = `CLI projection ${projectionPath} for tool:demo/submit: mapInput`;

    const expectRejectedMapInput = async (mapInput: string, fragments: readonly string[]): Promise<void> => {
      const { graph, root } = await compileProjection(cliModule('{}', mapInput));
      expectOnlyDiagnostic(graph, 'AB4841', root, [subject, ...fragments]);
      expect(graph.diagnostics[0]!.recovery).toContain('synchronous, non-generator function');
      expect(graph.cli?.commands).toEqual([]);
      expect(graph.cli?.projectionSources).toBeUndefined();
    };

    it('rejects an ambient function declaration, which emits no runtime binding', async () => {
      await expectRejectedMapInput(
        'export declare function mapInput(input: { laneKey?: string }): { laneKey: string };',
        ['ambient declaration', 'declare function', 'no runtime binding'],
      );
    });

    it('rejects an ambient const declaration', async () => {
      await expectRejectedMapInput(
        'export declare const mapInput: (input: { laneKey?: string }) => { laneKey: string };',
        ['ambient declaration', 'declare const', 'no runtime binding'],
      );
    });

    it('rejects a locally declared ambient function exported by name', async () => {
      await expectRejectedMapInput(
        'declare function mapInput(input: { laneKey?: string }): { laneKey: string };\nexport { mapInput };',
        ['ambient declaration'],
      );
    });

    it('rejects a generator function', async () => {
      await expectRejectedMapInput(
        'export function* mapInput(input) { yield input; }',
        ['is a generator function', 'iterator instead of returning the mapped input'],
      );
    });

    it('rejects an async generator function', async () => {
      await expectRejectedMapInput(
        'export async function* mapInput(input) { yield input; }',
        ['is an async generator function', 'async iterator'],
      );
    });

    it('rejects a generator function expression', async () => {
      await expectRejectedMapInput(
        'export const mapInput = function* (input) { yield input; };',
        ['is a generator function'],
      );
    });

    it('rejects an async arrow function', async () => {
      await expectRejectedMapInput(
        'export const mapInput = async (input) => input;',
        ['is an async function', 'Promise', 'synchronously'],
      );
    });

    it('rejects an async function declaration', async () => {
      await expectRejectedMapInput(
        'export async function mapInput(input) { return input; }',
        ['is an async function', 'synchronously'],
      );
    });

    it('rejects a const that is not statically a function', async () => {
      await expectRejectedMapInput(
        'export const mapInput = pipe(identity);',
        ['is exported but is not statically a function'],
      );
    });

    it('rejects a re-export the scan cannot follow, and follows one it can', async () => {
      await expectRejectedMapInput(
        "export { mapInput } from 'mapper-package';",
        ['is re-exported from "mapper-package"', 'cannot be followed statically'],
      );
      await expectRejectedMapInput(
        "export { mapInput } from './missing-mapper.ts';",
        ['is re-exported from "./missing-mapper.ts"'],
      );

      // The shared module sits outside src/mcp so discovery never reads it as a route.
      const reExport = "export { mapInput } from '../../../shared/mapper.ts';";
      const declaredAmbient = await compileProjection(cliModule('{}', reExport), {
        extraFiles: { 'src/shared/mapper.ts': 'export declare function mapInput(input: unknown): unknown;\n' },
      });
      expectOnlyDiagnostic(declaredAmbient.graph, 'AB4841', declaredAmbient.root, [subject, 'ambient declaration']);
      expect(declaredAmbient.graph.cli?.commands).toEqual([]);

      const followed = await compileProjection(cliModule('{}', reExport), {
        extraFiles: { 'src/shared/mapper.ts': 'export const mapInput = (input) => input;\n' },
      });
      expect(followed.graph.diagnostics).toEqual([]);
      expect(followed.graph.cli?.commands?.[0]?.projection).toEqual({ mapInput: true, module: projectionPath });
    });

    it('accepts a function declaration, an arrow, a function expression, an exported alias, and an overloaded declaration', async () => {
      const accepted: readonly [form: string, mapInput: string][] = [
        ['function declaration', 'export function mapInput(input) { return input; }'],
        ['arrow', 'export const mapInput = (input) => input;'],
        ['function expression', 'export const mapInput = function (input) { return input; };'],
        ['parenthesized arrow with a satisfies clause', 'export const mapInput = ((input) => input) satisfies (input: unknown) => unknown;'],
        ['local function exported by name', 'function mapInput(input) { return input; }\nexport { mapInput };'],
        ['local arrow exported under the name', 'const toInput = (input) => input;\nexport { toInput as mapInput };'],
        [
          'overloaded function declaration',
          [
            'export function mapInput(input: string): { laneKey: string };',
            'export function mapInput(input: { laneKey?: string }): { laneKey: string };',
            'export function mapInput(input: unknown) { return input; }',
          ].join('\n'),
        ],
      ];
      for (const [form, mapInput] of accepted) {
        const { graph } = await compileProjection(cliModule('{}', mapInput));
        expect(graph.diagnostics, form).toEqual([]);
        expect(graph.cli?.commands?.[0]?.projection, form).toEqual({ mapInput: true, module: projectionPath });
      }
    });
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

  it('reports AB4842 when a confirming command projects a tool whose contract has a key yes, whatever its spelling', async () => {
    const confirming = toolModule({
      config: "{ annotations: { readOnlyHint: false }, description: 'Submit work.' }",
      schema: 'z.object({ laneKey: z.string(), yes: z.string() }).strict()',
    });
    for (const projection of [cliModule('{}'), cliModule("{ flags: { yes: { name: 'assent' } } }")]) {
      const result = await compileProjection(projection, { tool: confirming });
      expectOnlyDiagnostic(result.graph, 'AB4842', result.root, [
        `CLI projection ${projectionPath} for tool:demo/submit:`,
        'key "yes"',
        'confirming command reserves',
        'set confirm: false or rename the key',
      ]);
      expect(result.graph.diagnostics[0]!.recovery).toContain('confirm: false');
      expect(result.graph.cli?.commands).toEqual([]);
    }

    const unconfirmed = await compileProjection(cliModule('{ confirm: false }'), { tool: confirming });
    expect(unconfirmed.graph.diagnostics).toEqual([]);
    expect(unconfirmed.graph.cli?.commands?.[0]?.options.map((option) => option.option)).toEqual(['lane-key', 'yes']);
    expect(unconfirmed.graph.cli?.commands?.[0]?.options.find((option) => option.key === 'yes'))
      .toMatchObject({ kind: 'string', required: true });
  });

  it('rejects name and aliases on a positional key with AB4842 while description, default, and required stay legal', async () => {
    const schema = 'z.object({ argv: z.array(z.string()).min(1), cwd: z.string().optional() }).strict()';
    const rejected: readonly [projection: string, fragments: readonly string[]][] = [
      [cliModule("{ positionals: ['argv'], flags: { argv: { name: 'command' } } }"), ['config.flags.argv is positional; name does not apply']],
      [cliModule("{ positionals: ['argv'], flags: { argv: { aliases: ['command'] } } }"), ['config.flags.argv is positional; aliases do not apply']],
      [
        cliModule("{ positionals: ['argv'], flags: { argv: { aliases: ['command'], name: 'cmd' } } }"),
        ['config.flags.argv is positional; name and aliases do not apply'],
      ],
    ];
    for (const [projection, fragments] of rejected) {
      const result = await compileProjection(projection, { tool: toolModule({ schema }) });
      expectOnlyDiagnostic(result.graph, 'AB4842', result.root, fragments);
      expect(result.graph.diagnostics[0]!.recovery).toContain('config.positionals');
    }

    const legal = await compileProjection(
      cliModule(
        "{ positionals: ['argv'], flags: { argv: { default: ['ls'], description: 'The command line.', required: false } } }",
        'export const mapInput = (input) => input;',
      ),
      { tool: toolModule({ schema }) },
    );
    expect(legal.graph.diagnostics).toEqual([]);
    expect(legal.graph.cli?.commands?.[0]?.options.find((option) => option.key === 'argv')).toEqual({
      defaultValue: ['ls'],
      description: 'The command line.',
      key: 'argv',
      kind: 'string',
      option: 'argv',
      positional: 0,
      repeated: true,
      required: false,
    });
    expect(legal.graph.cli?.commands?.[0]?.projection).toEqual({
      defaults: { argv: ['ls'] },
      mapInput: true,
      module: projectionPath,
      relaxed: ['argv'],
    });
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
