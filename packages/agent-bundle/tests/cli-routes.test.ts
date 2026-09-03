import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { inspect } from '../src/api.ts';
import {
  CliInputError,
  projectCliDocumentToMarkdown,
  runGeneratedCliEntry,
  runGeneratedRenderedScript,
  type CliRenderedDocument,
  type CliRenderedEvent,
  type GeneratedCliRenderSession,
} from '../src/cli-entry.ts';
import { normalizePackageBuild } from '../src/config/normalize.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import { extractCliArgv } from '../src/routes/cli-argv.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import type { CompiledCliCommand, CompiledCliSurface } from '../src/routes/types.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-cli-routes-')));
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
  plugin: { name: 'cli-fixture', version: '1.0.0' },
  ...extra,
});

const codesOf = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const extract = (schema: string) => extractCliArgv(
  `export const inputSchema = ${schema};\n`,
  'src/cli/example.ts',
  '/project/src/cli/example.ts',
);

describe('static argv projection (bounded zod grammar)', () => {
  it('projects the supported scalar, enum, array, wrapper, and refinement forms', () => {
    const extracted = extract([
      'z.object({',
      "  format: z.enum(['json', 'table']).default('table'),",
      "  maxFiles: z.number().int().min(1).max(256).optional().describe('Bound the scan.'),",
      '  root: z.string().min(1),',
      '  sources: z.array(z.string().min(1)).min(1),',
      '  strict: z.boolean().default(false),',
      '}).strict()',
    ].join('\n'));

    expect(extracted.diagnostics).toEqual([]);
    // Options sort deterministically by projected option name.
    expect(extracted.options).toEqual([
      { choices: ['json', 'table'], defaultValue: 'table', key: 'format', kind: 'enum', option: 'format', repeated: false, required: false },
      { description: 'Bound the scan.', key: 'maxFiles', kind: 'number', option: 'max-files', repeated: false, required: false },
      { key: 'root', kind: 'string', option: 'root', repeated: false, required: true },
      { key: 'sources', kind: 'string', option: 'sources', repeated: true, required: true },
      { defaultValue: false, key: 'strict', kind: 'boolean', option: 'strict', repeated: false, required: false },
    ]);
  });

  it('accepts z.strictObject and substitution-free template describe strings', () => {
    const extracted = extract("z.strictObject({ name: z.string().describe(`The name.`) })");
    expect(extracted.diagnostics).toEqual([]);
    expect(extracted.options).toEqual([
      { description: 'The name.', key: 'name', kind: 'string', option: 'name', repeated: false, required: true },
    ]);
  });

  it('reports found: false when the module exports no inputSchema', () => {
    const extracted = extractCliArgv('export const other = 1;\n', 'src/cli/example.ts', '/p/example.ts');
    expect(extracted.found).toBe(false);
    expect(extracted.diagnostics).toEqual([]);
  });

  it.each([
    ['a shared schema identifier', 'z.object({ root: pathSchema })', 'pathSchema'],
    ['a union', 'z.object({ mode: z.union([z.string(), z.number()]) })', 'z.union'],
    ['a nested object', 'z.object({ nested: z.object({ a: z.string() }) })', 'z.object'],
    ['a transform', 'z.object({ root: z.string().transform((value) => value) })', '.transform()'],
    ['a coercion', 'z.object({ count: z.coerce.number() })', 'outside the z.<base>(...) chain form'],
    ['a dynamic default', 'z.object({ root: z.string().default(process.cwd()) })', '.default()'],
    ['a spread', 'z.object({ ...shared, root: z.string() })', 'property outside the argv grammar'],
    ['an enum with substitutions', 'z.object({ mode: z.enum([`a${1}`]) })', 'non-string-literal z.enum member'],
    ['a non-object top level', 'z.string()', 'top level must be z.object'],
    ['a passthrough top level', 'z.object({ a: z.string() }).passthrough()', '.passthrough()'],
  ])('rejects %s with AB4814 naming the construct', (_label, schema, fragment) => {
    const extracted = extract(schema);
    expect(codesOf(extracted.diagnostics)).toEqual(['AB4814']);
    expect(extracted.diagnostics[0]!.message).toContain(fragment);
    expect(extracted.options).toBeUndefined();
  });

  it('rejects required booleans, reserved options, and kebab-case collisions', () => {
    const requiredBoolean = extract('z.object({ strict: z.boolean() })');
    expect(codesOf(requiredBoolean.diagnostics)).toEqual(['AB4814']);
    expect(requiredBoolean.diagnostics[0]!.message).toContain('required boolean');

    const reserved = extract('z.object({ json: z.string() })');
    expect(codesOf(reserved.diagnostics)).toEqual(['AB4814']);
    expect(reserved.diagnostics[0]!.message).toContain('reserved option --json');

    const collision = extract("z.object({ 'max-files': z.string(), maxFiles: z.number() })");
    expect(codesOf(collision.diagnostics)).toEqual(['AB4814']);
    expect(collision.diagnostics[0]!.message).toContain('--max-files');
  });

  it('rejects indirect and mutable inputSchema declarations', () => {
    const indirect = extractCliArgv(
      'const inputSchema = z.object({});\nexport { inputSchema };\n',
      'src/cli/example.ts',
      '/p/example.ts',
    );
    expect(codesOf(indirect.diagnostics)).toEqual(['AB4814']);
    expect(indirect.diagnostics[0]!.message).toContain('indirect');

    const mutable = extractCliArgv('export let inputSchema = z.object({});\n', 'src/cli/example.ts', '/p/example.ts');
    expect(codesOf(mutable.diagnostics)).toEqual(['AB4814']);
    expect(mutable.diagnostics[0]!.message).toContain('mutable');
  });
});

const plainCommandModule = (options: {
  readonly config?: string;
  readonly schema?: string;
} = {}): string => [
  ...(options.config === undefined ? [] : [`export const config = ${options.config};`]),
  `export const inputSchema = ${options.schema ?? 'z.object({}).strict()'};`,
  'export const resultSchema = {};',
  'export default async () => undefined;',
  '',
].join('\n');

const toolModule = (config?: string): string => [
  ...(config === undefined ? [] : [`export const config = ${config};`]),
  'export const inputSchema = operation.inputSchema;',
  'export const resultSchema = operation.resultSchema;',
  'export default async function Tool() { return undefined; }',
  '',
].join('\n');

describe('compiled command graph', () => {
  it('compiles nesting, aliases, positionals, and the exit-code policy into graph.cli.commands', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli/doctor.ts': plainCommandModule({
        config: "{ aliases: ['health'], description: 'Inspect the runtime.' }",
        schema: 'z.object({ verbose: z.boolean().optional() })',
      }),
      'src/cli/library/audit.ts': plainCommandModule({
        config: "{ description: 'Audit sources.', exitCode: 'result', positionals: ['sources'] }",
        schema: 'z.object({ report: z.string(), sources: z.array(z.string()).min(1) }).strict()',
      }),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.mode).toBe('generated');
    expect(graph.cli?.commands).toEqual([
      {
        aliases: ['health'],
        description: 'Inspect the runtime.',
        exitCode: 'zero',
        options: [{ key: 'verbose', kind: 'boolean', option: 'verbose', repeated: false, required: false }],
        path: ['doctor'],
        rendered: false,
        routeId: 'cli:doctor',
      },
      {
        aliases: [],
        description: 'Audit sources.',
        exitCode: 'result',
        options: [
          { key: 'report', kind: 'string', option: 'report', repeated: false, required: true },
          { key: 'sources', kind: 'string', option: 'sources', positional: 0, repeated: true, required: true },
        ],
        path: ['library', 'audit'],
        rendered: false,
        routeId: 'cli:library/audit',
      },
    ]);
    expect(Object.isFrozen(graph.cli!.commands)).toBe(true);
  });

  it('errors with AB4813 when a command path is both a module and a group', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli/library.ts': plainCommandModule(),
      'src/cli/library/audit.ts': plainCommandModule(),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());
    expect(codesOf(graph.diagnostics)).toEqual(['AB4813']);
    expect(graph.diagnostics[0]!.message).toContain('command group');
  });

  it('errors with AB4813 on alias collisions across siblings, groups, and duplicates', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli/doctor.ts': plainCommandModule({ config: "{ aliases: ['inspect'] }" }),
      'src/cli/inspect.ts': plainCommandModule(),
      'src/cli/library/audit.ts': plainCommandModule(),
      'src/cli/status.ts': plainCommandModule({ config: "{ aliases: ['library'] }" }),
      'src/cli/verify.ts': plainCommandModule({ config: "{ aliases: ['check', 'check'] }" }),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());
    const messages = graph.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(codesOf(graph.diagnostics)).toEqual(['AB4813', 'AB4813', 'AB4813']);
    expect(messages).toContain('alias "inspect"');
    expect(messages).toContain('alias "library"');
    expect(messages).toContain('alias "check" twice');
  });

  it('errors with AB4815 on contract violations and malformed config fields', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli/bad-alias.ts': plainCommandModule({ config: "{ aliases: 'health' }" }),
      'src/cli/bad-exit.ts': plainCommandModule({ config: "{ exitCode: 'signal' }" }),
      'src/cli/no-result.ts': [
        'export const inputSchema = z.object({});',
        'export default async () => undefined;',
        '',
      ].join('\n'),
      'src/cli/sync-default.ts': [
        'export const inputSchema = z.object({});',
        'export const resultSchema = {};',
        'export default () => undefined;',
        '',
      ].join('\n'),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());
    expect(codesOf(graph.diagnostics)).toEqual(['AB4815', 'AB4815', 'AB4815', 'AB4815']);
    const messages = graph.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(messages).toContain('config.aliases');
    expect(messages).toContain('config.exitCode');
    expect(messages).toContain('missing named resultSchema');
    expect(messages).toContain('not an async function');
  });

  it('errors with AB4814 on positional policy violations', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli/copy.ts': plainCommandModule({
        config: "{ positionals: ['sources', 'destination'] }",
        schema: 'z.object({ destination: z.string(), sources: z.array(z.string()) }).strict()',
      }),
      'src/cli/pick.ts': plainCommandModule({
        config: "{ positionals: ['missing'] }",
      }),
      'src/cli/scan.ts': plainCommandModule({
        config: "{ positionals: ['root', 'depth'] }",
        schema: 'z.object({ depth: z.number(), root: z.string().optional() }).strict()',
      }),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());
    expect(codesOf(graph.diagnostics)).toEqual(['AB4814', 'AB4814', 'AB4814']);
    const messages = graph.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(messages).toContain('before the end');
    expect(messages).toContain('not a projected inputSchema key');
    expect(messages).toContain('after an optional one');
  });

  it('compiles rendered .tsx routes into rendered commands beside plain ones (#102 stage 3)', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'agent-bundle.config.ts': [
        "export default { plugin: { name: 'cli-fixture', version: '1.0.0' }, targets: ['portable'] };",
        '',
      ].join('\n'),
      'package.json': '{"type":"module"}\n',
      'src/cli/doctor.tsx': plainCommandModule(),
      'src/cli/inspect.ts': plainCommandModule(),
    });
    const graph = await compileRouteGraph(root, fixtureConfig());
    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.commands?.map((command) => [command.routeId, command.rendered])).toEqual([
      ['cli:doctor', true],
      ['cli:inspect', false],
    ]);

    // AB4816 (the stage-2 rendered-command gate) is retired: source
    // validation accepts the rendered surface.
    const result = await inspect({ root });
    expect(result.state).toBe('ready');
    expect(codesOf(result.diagnostics)).not.toContain('AB4816');
  });

  it('errors with AB4813 when an explicit bin entry claims the generated executable name', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'agent-bundle.config.ts': [
        'export default {',
        "  bin: { 'cli-fixture': './src/tool.ts' },",
        "  plugin: { name: 'cli-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"type":"module"}\n',
      'src/cli/inspect.ts': plainCommandModule(),
      'src/tool.ts': 'export const main = async () => 0;\n',
    });
    const result = await inspect({ root });
    expect(result.state).toBe('invalid');
    expect(codesOf(result.diagnostics)).toContain('AB4813');
  });

  it('projects generated MCP tools with deterministic JSON options and fail-closed confirmation metadata', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/tools/mutate_item.tsx': toolModule("{ description: 'Mutates one item.' }"),
      'src/mcp/alpha/tools/read_item.tsx': toolModule(
        "{ annotations: { readOnlyHint: true }, description: 'Reads one item.' }",
      ),
      'src/mcp/zeta/tools/inspect.tsx': toolModule(),
    });

    const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands: true } }));

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.mode).toBe('generated');
    expect(graph.cli?.commands).toEqual([
      {
        aliases: [],
        description: 'Mutates one item.',
        exitCode: 'zero',
        mcp: { confirm: true, server: 'alpha', tool: 'mutate_item' },
        options: [
          {
            description: 'Tool input as one JSON object.',
            key: 'input',
            kind: 'string',
            option: 'input',
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
        path: ['alpha', 'mutate_item'],
        rendered: true,
        routeId: 'tool:alpha/mutate_item',
      },
      {
        aliases: [],
        description: 'Reads one item.',
        exitCode: 'zero',
        mcp: { confirm: false, server: 'alpha', tool: 'read_item' },
        options: [{
          description: 'Tool input as one JSON object.',
          key: 'input',
          kind: 'string',
          option: 'input',
          repeated: false,
          required: false,
        }],
        path: ['alpha', 'read_item'],
        rendered: true,
        routeId: 'tool:alpha/read_item',
      },
      {
        aliases: [],
        exitCode: 'zero',
        mcp: { confirm: true, server: 'zeta', tool: 'inspect' },
        options: [
          expect.objectContaining({ key: 'input', option: 'input' }),
          expect.objectContaining({ key: 'yes', option: 'yes' }),
        ],
        path: ['zeta', 'inspect'],
        rendered: true,
        routeId: 'tool:zeta/inspect',
      },
    ]);
    expect(Object.isFrozen(graph.cli!.commands![0]!.mcp)).toBe(true);
  });

  it('preserves a projected MCP tool result exit-code policy', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/tools/audit.tsx': toolModule(
        "{ annotations: { readOnlyHint: true }, exitCode: 'result' }",
      ),
    });

    const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands: true } }));

    expect(graph.diagnostics).toEqual([]);
    expect(graph.cli?.commands).toEqual([
      expect.objectContaining({
        exitCode: 'result',
        routeId: 'tool:alpha/audit',
      }),
    ]);
  });

  it('selects projected tools with literal-star patterns and reports every unmatched pattern', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/tools/mutate_item.tsx': toolModule(),
      'src/mcp/alpha/tools/read_item.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
      'src/mcp/beta/tools/read_item.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
    });

    const selected = await compileRouteGraph(root, fixtureConfig({
      routes: {
        mcpCommands: {
          exclude: ['*:mutate_*'],
          include: ['alpha:*'],
        },
      },
    }));
    expect(selected.diagnostics).toEqual([]);
    expect(selected.cli?.commands?.map((command) => command.path.join('/'))).toEqual(['alpha/read_item']);

    const excludedAll = await compileRouteGraph(root, fixtureConfig({
      routes: { mcpCommands: { exclude: ['*:*'] } },
    }));
    expect(excludedAll.diagnostics).toEqual([]);
    expect(excludedAll.cli?.commands).toEqual([]);

    const unmatched = await compileRouteGraph(root, fixtureConfig({
      routes: {
        mcpCommands: {
          exclude: ['missing:*'],
          include: ['alpha:read_*', 'beta:missing'],
        },
      },
    }));
    expect(codesOf(unmatched.diagnostics)).toEqual(['AB4822', 'AB4822']);
    expect(unmatched.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('alpha:mutate_item');
    expect(unmatched.diagnostics.every((diagnostic) =>
      diagnostic.recovery?.includes('routes.mcpCommands') === true)).toBe(true);

    const emptyInclude = await compileRouteGraph(root, fixtureConfig({
      routes: { mcpCommands: { include: [] } },
    }));
    expect(codesOf(emptyInclude.diagnostics)).toEqual(['AB4822']);
  });

  it('rejects malformed routes.mcpCommands declarations with AB4804', async () => {
    const root = await createRoot();
    await writeTree(root, { 'src/mcp/alpha/tools/read.tsx': toolModule() });

    for (const mcpCommands of [
      false,
      'yes',
      { include: 'alpha:*' },
      { exclude: [42] },
      { extra: [] },
    ]) {
      const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands } }));
      expect(codesOf(graph.diagnostics), JSON.stringify(mcpCommands)).toEqual(['AB4804']);
      expect(graph.diagnostics[0]!.recovery).toContain('routes.mcpCommands');
    }
  });

  it('builds a standalone generated CLI surface from projected tools without src/cli routes', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/tools/read.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
    });

    const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands: true } }));

    expect(graph.cli).toMatchObject({
      commands: [expect.objectContaining({ routeId: 'tool:alpha/read' })],
      mode: 'generated',
    });
    expect(graph.cli?.routes.map((route) => route.id)).toEqual(['tool:alpha/read']);
  });

  it('reports selection errors beside a conventional CLI conflict', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/mcp/alpha/tools/read.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
    });

    const graph = await compileRouteGraph(root, fixtureConfig({
      routes: { mcpCommands: { include: ['missing:*'] } },
    }));

    expect(codesOf(graph.diagnostics)).toEqual(['AB4801', 'AB4822']);
    expect(graph.diagnostics[0]!.message).toContain('routes.mcpCommands');
  });

  it.each([
    ['server group', 'src/cli/alpha.ts', plainCommandModule()],
    ['projected command path', 'src/cli/alpha/read.ts', plainCommandModule()],
    ['alias at the server level', 'src/cli/status.ts', plainCommandModule({ config: "{ aliases: ['alpha'] }" })],
    ['alias at the tool level', 'src/cli/alpha/status.ts', plainCommandModule({ config: "{ aliases: ['read'] }" })],
  ])('reports an actionable AB4813 collision for a custom %s', async (_label, path, source) => {
    const root = await createRoot();
    await writeTree(root, {
      [path]: source,
      'src/mcp/alpha/tools/read.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
    });

    const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands: true } }));

    expect(codesOf(graph.diagnostics)).toContain('AB4813');
    const collision = graph.diagnostics.find((diagnostic) => diagnostic.code === 'AB4813')!;
    expect(collision.message).toContain('alpha:read');
    expect(collision.recovery).toContain('routes.mcpCommands.exclude');
    expect(collision.recovery).toContain('rename');
  });
});

describe('generated bin normalization', () => {
  const command: CompiledCliCommand = {
    aliases: [],
    exitCode: 'zero',
    options: [],
    path: ['inspect'],
    rendered: false,
    routeId: 'cli:inspect',
  };
  const surface = (overrides: Partial<CompiledCliSurface> = {}): CompiledCliSurface => ({
    commands: [command],
    mode: 'generated',
    routes: [{
      config: {},
      id: 'cli:inspect',
      kind: 'cli',
      provenance: { kind: 'conventional', relativePath: 'src/cli/inspect.ts' },
      source: '/project/src/cli/inspect.ts',
    }],
    ...overrides,
  });

  it('feeds the generated command surface into one package bin named after the plugin', () => {
    const packageBuild = normalizePackageBuild(fixtureConfig(), '/project', '/project/agent-bundle.config.ts', surface());
    expect(packageBuild?.bins).toEqual([{
      generatedCli: { commands: [command], routes: surface().routes },
      id: 'bin:cli-fixture',
      name: 'cli-fixture',
      provenance: { kind: 'conventional', sourcePath: '/project/src/cli/inspect.ts' },
      source: '/project/src/cli/inspect.ts',
    }]);
  });

  it('keeps explicit bins authoritative: a claimed name shadows the generated CLI, others coexist', () => {
    const shadowed = normalizePackageBuild(
      fixtureConfig({ bin: { 'cli-fixture': './src/tool.ts' } }),
      '/project',
      '/project/agent-bundle.config.ts',
      surface(),
    );
    expect(shadowed?.bins.map((bin) => [bin.name, bin.generatedCli === undefined])).toEqual([['cli-fixture', true]]);

    const coexisting = normalizePackageBuild(
      fixtureConfig({ bin: { 'other-tool': './src/tool.ts' } }),
      '/project',
      '/project/agent-bundle.config.ts',
      surface(),
    );
    expect(coexisting?.bins.map((bin) => [bin.name, bin.generatedCli === undefined])).toEqual([
      ['cli-fixture', false],
      ['other-tool', true],
    ]);
  });

  it('honors bin: false and compiles nothing for command-free or non-generated surfaces', () => {
    expect(normalizePackageBuild(
      fixtureConfig({ bin: false }),
      '/project',
      '/project/agent-bundle.config.ts',
      surface(),
    )).toBeUndefined();
    expect(normalizePackageBuild(
      fixtureConfig(),
      '/project',
      '/project/agent-bundle.config.ts',
      surface({ commands: [] }),
    )).toBeUndefined();
    expect(normalizePackageBuild(
      fixtureConfig(),
      '/project',
      '/project/agent-bundle.config.ts',
      surface({ commands: undefined, mode: 'conflict' }),
    )).toBeUndefined();
  });
});

describe('generated CLI shell', () => {
  const commands: readonly CompiledCliCommand[] = [
    {
      aliases: ['health'],
      description: 'Inspect the runtime.',
      exitCode: 'zero',
      options: [
        { defaultValue: 8, description: 'Bound the scan.', key: 'maxFiles', kind: 'number', option: 'max-files', repeated: false, required: false },
        { key: 'root', kind: 'string', option: 'root', positional: 0, repeated: false, required: true },
        { key: 'verbose', kind: 'boolean', option: 'verbose', repeated: false, required: false },
      ],
      path: ['doctor'],
      rendered: false,
      routeId: 'cli:doctor',
    },
    {
      aliases: [],
      description: 'Audit sources.',
      exitCode: 'result',
      options: [
        { choices: ['json', 'table'], key: 'format', kind: 'enum', option: 'format', repeated: false, required: false },
        { key: 'report', kind: 'string', option: 'report', repeated: false, required: true },
        { key: 'sources', kind: 'string', option: 'sources', positional: 0, repeated: true, required: true },
      ],
      path: ['library', 'audit'],
      rendered: false,
      routeId: 'cli:library/audit',
    },
    {
      aliases: [],
      description: 'Apply a signed offset.',
      exitCode: 'zero',
      options: [
        { key: 'offset', kind: 'number', option: 'offset', positional: 0, repeated: false, required: true },
      ],
      path: ['offset'],
      rendered: false,
      routeId: 'cli:offset',
    },
  ];

  interface RunResult {
    readonly calls: { command: CompiledCliCommand; input: Readonly<Record<string, unknown>>; json: boolean }[];
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
  }

  const run = async (
    argv: readonly string[],
    options: {
      readonly result?: unknown;
      readonly signal?: AbortSignal;
      readonly throws?: Error;
    } = {},
  ): Promise<RunResult> => {
    const calls: RunResult['calls'] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGeneratedCliEntry({
      argv,
      commands,
      description: 'Curate audiobooks.',
      execute: async (command, input, context) => {
        calls.push({ command, input, json: context.json });
        if (options.throws !== undefined) throw options.throws;
        return Object.hasOwn(options, 'result') ? options.result : { ok: true };
      },
      name: 'curator',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      version: '1.2.3',
      writeErr: (text) => void stderr.push(text),
      writeOut: (text) => void stdout.push(text),
    });
    return { calls, code, stderr: stderr.join(''), stdout: stdout.join('') };
  };

  const mutationTool: CompiledCliCommand = {
    aliases: [],
    description: 'Mutates one item.',
    exitCode: 'zero',
    mcp: { confirm: true, server: 'curator', tool: 'apply_item' },
    options: [
      {
        description: 'Tool input as one JSON object.',
        key: 'input',
        kind: 'string',
        option: 'input',
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
    path: ['curator', 'apply_item'],
    rendered: true,
    routeId: 'tool:curator/apply_item',
  };
  const readOnlyTool: CompiledCliCommand = {
    ...mutationTool,
    mcp: { confirm: false, server: 'curator', tool: 'read_item' },
    options: [mutationTool.options[0]!],
    path: ['curator', 'read_item'],
    routeId: 'tool:curator/read_item',
  };
  const runMcp = async (
    argv: readonly string[],
  ): Promise<RunResult> => {
    const calls: RunResult['calls'] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGeneratedCliEntry({
      argv,
      commands: [mutationTool, readOnlyTool],
      execute: async () => {
        throw new Error('plain execute must not run for an MCP command');
      },
      isTty: () => false,
      name: 'curator',
      render: (command, input) => {
        calls.push({ command, input, json: argv.includes('--json') });
        return {
          close: async () => undefined,
          events: () => eventStream([{
            document: completeDocument('success', input, [{ kind: 'json', value: input }]),
            sequence: 0,
            type: 'complete',
          }]),
          validate: (value) => value,
        };
      },
      version: '1.2.3',
      writeErr: (text) => void stderr.push(text),
      writeOut: (text) => void stdout.push(text),
    });
    return { calls, code, stderr: stderr.join(''), stdout: stdout.join('') };
  };

  it('prints root help on bare invocation and --help, and the version on --version', async () => {
    const bare = await run([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('curator 1.2.3');
    expect(bare.stdout).toContain('Curate audiobooks.');
    expect(bare.stdout).toContain('doctor');
    expect(bare.stdout).toContain('library <command>');
    expect(bare.stdout).toContain('Inspect the runtime.');
    expect((await run(['--help'])).stdout).toBe(bare.stdout);

    const version = await run(['--version']);
    expect(version).toMatchObject({ code: 0, stdout: 'curator 1.2.3\n' });
  });

  it('prints command help with usage, aliases, arguments, defaults, and choices', async () => {
    const help = await run(['doctor', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: curator doctor [options] <root>');
    expect(help.stdout).toContain('Aliases: health');
    expect(help.stdout).toContain('--max-files <number>');
    expect(help.stdout).toContain('[default: 8]');
    expect(help.stdout).toContain('--verbose');

    const audit = await run(['library', 'audit', '-h']);
    expect(audit.stdout).toContain('Usage: curator library audit [options] <sources...>');
    expect(audit.stdout).toContain('--format <json|table>');
    expect(audit.stdout).toContain('(required)');

    const group = await run(['library', '--help']);
    expect(group.code).toBe(0);
    expect(group.stdout).toContain('Usage: curator library <command> [options]');
    expect(group.stdout).toContain('audit');
  });

  it('parses options, positionals, coercions, flags, aliases, and --json, then prints one JSON line', async () => {
    const result = await run(
      ['doctor', '/library', '--max-files', '3', '--verbose', '--json'],
      { result: { status: 'ready' } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"status":"ready"}\n');
    expect(result.calls).toEqual([{
      command: commands[0],
      input: { maxFiles: 3, root: '/library', verbose: true },
      json: true,
    }]);

    const aliased = await run(['health', '/media'], { result: { status: 'ready' } });
    expect(aliased.calls[0]!.input).toEqual({ root: '/media' });

    const variadic = await run(
      ['library', 'audit', '--report', 'out.json', '--format', 'json', 'a', '--', '--b'],
      { result: { exitCode: 0 } },
    );
    expect(variadic.code).toBe(0);
    expect(variadic.calls[0]!.input).toEqual({ format: 'json', report: 'out.json', sources: ['a', '--b'] });
  });

  it('accepts negative numeric positionals without weakening single-dash option handling', async () => {
    const negative = await run(['offset', '-5']);
    expect(negative.code).toBe(0);
    expect(negative.calls[0]!.input).toEqual({ offset: -5 });

    const unknown = await run(['offset', '-x']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown option: -x.');
    expect(unknown.calls).toEqual([]);

    const escaped = await run(['offset', '--', '-5']);
    expect(escaped.code).toBe(0);
    expect(escaped.calls[0]!.input).toEqual({ offset: -5 });
  });

  it('writes undefined results as canonical JSON null', async () => {
    const result = await run(['doctor', '/library'], { result: undefined });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('null\n');

    const ordered = await run(['doctor', '/library'], { result: { z: 1, a: 2 } });
    expect(ordered.stdout).toBe('{"a":2,"z":1}\n');
  });

  it('maps usage failures to exit 2 with a help hint on stderr', async () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['unknown'], 'Unknown command: unknown.'],
      [['library', 'unknown'], 'Unknown command: library unknown.'],
      [['library'], 'Missing command: curator library <command>.'],
      [['doctor', '/library', '--bogus'], 'Unknown option: --bogus.'],
      [['doctor', '/library', '--max-files', 'many'], '--max-files requires a number'],
      [['doctor', '/library', '--max-files'], '--max-files requires a value.'],
      [['doctor', '/library', '--verbose=true'], '--verbose is a flag'],
      [['doctor', '/library', '--verbose', '--verbose'], 'Duplicate option: --verbose.'],
      [['doctor'], 'Missing required argument: <root>.'],
      [['doctor', '/library', 'extra'], 'Unexpected argument: "extra".'],
      [['library', 'audit', '--report', 'r', '--format', 'yaml', 'a'], '--format must be one of: json, table.'],
      [['library', 'audit', 'a'], 'Missing required option: --report.'],
      [['library', 'audit', '--report', 'r'], 'Missing required argument: <sources...>.'],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("--help' for usage.");
      expect(result.calls).toEqual([]);
    }
  });

  it('maps execution failures to exit 1 without a usage hint and input failures to exit 2', async () => {
    const failed = await run(['doctor', '/library'], { throws: new Error('backend unavailable') });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('backend unavailable');
    expect(failed.stderr).not.toContain('for usage');

    const invalid = await run(['doctor', '/library'], { throws: new CliInputError('root must be absolute') });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('root must be absolute');
    expect(invalid.stderr).toContain('for usage');
  });

  it('adopts the validated result exitCode under the result policy and fails closed otherwise', async () => {
    const three = await run(['library', 'audit', '--report', 'r', 'a'], { result: { exitCode: 3 } });
    expect(three.code).toBe(3);
    expect(three.stdout).toBe('{"exitCode":3}\n');

    const missing = await run(['library', 'audit', '--report', 'r', 'a'], { result: { ok: true } });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('exitCode result policy');
  });

  it('reports an aborted invocation on stderr with exit 1', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const aborted = await run(['doctor', '/library'], { signal: controller.signal });
    expect(aborted.code).toBe(1);
    expect(aborted.stderr).toBe('Aborted.\n');
    expect(aborted.calls).toEqual([]);
  });

  it('rejects --ndjson on a plain command as a usage failure', async () => {
    const result = await run(['doctor', '/library', '--ndjson']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--ndjson requires a rendered command.');
  });

  it('shows projected MCP provenance, JSON input, and fail-closed safety in command help', async () => {
    const gated = await runMcp(['curator', 'apply_item', '--help']);
    expect(gated.code).toBe(0);
    expect(gated.stdout).toContain('MCP tool: curator:apply_item');
    expect(gated.stdout).toContain('Mutation-capable; requires --yes.');
    expect(gated.stdout).toContain('--input <string>');
    expect(gated.stdout).toContain('--yes');
    expect(gated.stdout).toContain('--ndjson');

    const readOnly = await runMcp(['curator', 'read_item', '--help']);
    expect(readOnly.stdout).toContain('MCP tool: curator:read_item');
    expect(readOnly.stdout).not.toContain('Mutation-capable');
  });

  it('parses exactly one JSON object for MCP input and strips only synthesized argv keys', async () => {
    const document = { input: 'document field', nested: { count: 2 }, yes: 'document field' };
    const supplied = await runMcp([
      'curator',
      'apply_item',
      '--input',
      JSON.stringify(document),
      '--yes',
      '--json',
    ]);
    expect(supplied.code).toBe(0);
    expect(supplied.calls).toEqual([{
      command: mutationTool,
      input: document,
      json: true,
    }]);
    expect(JSON.parse(supplied.stdout)).toEqual(document);

    const absent = await runMcp(['curator', 'read_item', '--json']);
    expect(absent.code).toBe(0);
    expect(absent.calls[0]!.input).toEqual({});
  });

  it('fails closed before rendering a mutation-capable MCP command without --yes', async () => {
    const denied = await runMcp(['curator', 'apply_item', '--input', '{"id":"one"}']);
    expect(denied.code).toBe(2);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('mutation-capable');
    expect(denied.stderr).toContain('requires --yes');
    expect(denied.calls).toEqual([]);
  });

  it.each([
    ['{', 'valid JSON object'],
    ['[]', 'JSON object'],
    ['null', 'JSON object'],
    ['1', 'JSON object'],
    ['"text"', 'JSON object'],
  ])('rejects MCP --input %s as a usage failure', async (input, message) => {
    const invalid = await runMcp(['curator', 'read_item', '--input', input]);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain(message);
    expect(invalid.calls).toEqual([]);
  });
});

const completeDocument = (
  status: CliRenderedDocument['status'],
  value: unknown,
  children: readonly CliRenderedDocument['root'][] = [],
): CliRenderedDocument => ({
  root: { children: [...children], kind: 'result' },
  status,
  value,
  version: 1,
});

const eventStream = (events: readonly CliRenderedEvent[]): ReadableStream<CliRenderedEvent> =>
  new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });

describe('rendered command projection (#102 stage 3)', () => {
  const renderedCommand: CompiledCliCommand = {
    aliases: [],
    description: 'Render a report.',
    exitCode: 'zero',
    options: [{ key: 'root', kind: 'string', option: 'root', positional: 0, repeated: false, required: true }],
    path: ['report'],
    rendered: true,
    routeId: 'cli:report',
  };
  const document = completeDocument('success', { books: 2 }, [
    { kind: 'markdown', text: 'Found **2** books.' },
    { completed: 2, kind: 'progress', total: 2 },
  ]);
  const events: readonly CliRenderedEvent[] = [
    { document: completeDocument('success', undefined), sequence: 0, type: 'shell' },
    { completed: 1, message: 'auditing', sequence: 1, total: 2, type: 'progress' },
    { document, sequence: 2, type: 'complete' },
  ];

  interface RenderedRun {
    readonly closed: number;
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
  }

  const runRendered = async (
    argv: readonly string[],
    options: {
      readonly events?: readonly CliRenderedEvent[];
      readonly isTty?: boolean;
      readonly validate?: (value: unknown) => unknown;
    } = {},
  ): Promise<RenderedRun> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let closed = 0;
    const session: GeneratedCliRenderSession = {
      close: async () => {
        closed += 1;
      },
      events: () => eventStream(options.events ?? events),
      validate: options.validate ?? ((value) => value),
    };
    const code = await runGeneratedCliEntry({
      argv,
      commands: [renderedCommand],
      execute: async () => {
        throw new Error('plain execute must not run for a rendered command');
      },
      isTty: () => options.isTty ?? false,
      name: 'curator',
      render: () => session,
      version: '1.2.3',
      writeErr: (text) => void stderr.push(text),
      writeOut: (text) => void stdout.push(text),
    });
    return { closed, code, stderr: stderr.join(''), stdout: stdout.join('') };
  };

  it('emits one final Markdown document when piped, with no partial fallbacks', async () => {
    const piped = await runRendered(['report', '/library']);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toBe('Found **2** books.\n');
    expect(piped.stderr).toBe('');
    expect(piped.closed).toBe(1);
  });

  it('updates progress in place on a TTY before the final document', async () => {
    const tty = await runRendered(['report', '/library'], { isTty: true });
    expect(tty.code).toBe(0);
    expect(tty.stdout).toBe('\r\u001B[2Kauditing (1/2)\r\u001B[2KFound **2** books.\n');
  });

  it('emits the canonical validated final value under --json', async () => {
    const json = await runRendered(['report', '/library', '--json'], {
      validate: (value) => ({ ...(value as Record<string, unknown>), validated: true }),
    });
    expect(json.code).toBe(0);
    expect(json.stdout).toBe('{"books":2,"validated":true}\n');
  });

  it('emits the sequence-numbered render-event stream under --ndjson', async () => {
    const ndjson = await runRendered(['report', '/library', '--ndjson']);
    expect(ndjson.code).toBe(0);
    const lines = ndjson.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { sequence: number; type: string });
    expect(lines.map((line) => [line.sequence, line.type])).toEqual([
      [0, 'shell'],
      [1, 'progress'],
      [2, 'complete'],
    ]);
  });

  it('maps non-success documents, validation failures, and missing completion to exit 1', async () => {
    const represented = await runRendered(['report', '/library'], {
      events: [{ document: completeDocument('represented-error', { ok: false }), sequence: 0, type: 'complete' }],
    });
    expect(represented.code).toBe(1);

    const invalid = await runRendered(['report', '/library'], {
      validate: () => {
        throw new Error('result contract violated');
      },
    });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('result contract violated');

    const incomplete = await runRendered(['report', '/library'], {
      events: [{ document: completeDocument('success', undefined), sequence: 0, type: 'shell' }],
    });
    expect(incomplete.code).toBe(1);
    expect(incomplete.stderr).toContain('without a complete document');
  });

  it('rejects --json combined with --ndjson', async () => {
    const both = await runRendered(['report', '/library', '--json', '--ndjson']);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('Use either --json or --ndjson, not both.');
  });
});

describe('rendered script projection (#102 stage 3)', () => {
  it('reserves --json/--ndjson, passes the rest as argv, and derives exit codes from status', async () => {
    const stdout: string[] = [];
    const captured: (readonly string[])[] = [];
    const document = completeDocument('success', { ok: true }, [{ kind: 'text', text: 'Summarized.' }]);
    const code = await runGeneratedRenderedScript({
      argv: ['--json', 'a', '--', '--ndjson'],
      createSession: (argv) => {
        captured.push(argv);
        return {
          close: async () => undefined,
          events: () => eventStream([{ document, sequence: 0, type: 'complete' }]),
          validate: (value) => value,
        };
      },
      isTty: () => false,
      name: 'summarize',
      writeErr: () => undefined,
      writeOut: (text) => void stdout.push(text),
    });
    expect(code).toBe(0);
    // --json is the framework dialect; the -- terminator and everything
    // after it pass through untouched (the script owns its own argv).
    expect(captured).toEqual([['a', '--', '--ndjson']]);
    expect(stdout.join('')).toBe('{"ok":true}\n');

    const failed = await runGeneratedRenderedScript({
      argv: [],
      createSession: () => ({
        close: async () => undefined,
        events: () => eventStream([{ document: completeDocument('failed', undefined), sequence: 0, type: 'complete' }]),
        validate: (value) => value,
      }),
      isTty: () => false,
      name: 'summarize',
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    expect(failed).toBe(1);
  });
});

describe('final document Markdown projection', () => {
  it('projects every node kind onto stable Markdown and omits transient progress', () => {
    const markdown = projectCliDocumentToMarkdown({
      root: {
        children: [
          { kind: 'markdown', text: '# Report' },
          { kind: 'text', text: 'Two books found.' },
          { kind: 'context', text: 'Guidance line.' },
          { kind: 'json', value: { books: 2 } },
          { completed: 2, kind: 'progress', total: 2 },
          { kind: 'resource', name: 'receipt', uri: 'file:///tmp/receipt.json' },
          { code: 'partial', kind: 'error', message: 'one source skipped' },
        ],
        kind: 'result',
      },
      status: 'success',
      value: { books: 2 },
      version: 1,
    });
    expect(markdown).toBe([
      '# Report',
      '',
      'Two books found.',
      '',
      '> Guidance line.',
      '',
      '```json\n{\n  "books": 2\n}\n```',
      '',
      '[receipt](file:///tmp/receipt.json)',
      '',
      '**[partial]** one source skipped',
      '',
    ].join('\n'));
  });
});
