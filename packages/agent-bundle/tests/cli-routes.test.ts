import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import { inspect } from '../src/api.ts';
import {
  CliInputError,
  cliInputError,
  projectCliDocumentToMarkdown,
  runGeneratedCliEntry,
  runGeneratedRenderedScript,
  type AgentTerminal,
  type CliRenderedDocument,
  type CliRenderedEvent,
  type GeneratedCliRenderSession,
  type GeneratedCliWebCommand,
  type GeneratedCliWebContext,
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

  it('rejects an unresolvable identifier reference with AB4838 naming the chain and reason', () => {
    const extracted = extract('z.object({ root: pathSchema })');
    expect(codesOf(extracted.diagnostics)).toEqual(['AB4838']);
    expect(extracted.diagnostics[0]).toMatchObject({
      severity: 'error',
      sourcePath: '/project/src/cli/example.ts',
    });
    expect(extracted.diagnostics[0]!.message).toContain('inputSchema -> pathSchema');
    expect(extracted.diagnostics[0]!.message).toContain(
      'which is neither a top-level const in this module nor a named import from a relative module',
    );
    expect(extracted.diagnostics[0]!.recovery).toContain('relative');
    expect(extracted.diagnostics[0]!.recovery).toContain('export const');
    expect(extracted.diagnostics[0]!.recovery).toContain('inspect again');
    expect(extracted.options).toBeUndefined();
  });

  it('rejects a cyclic inputSchema reference with AB4839', () => {
    const files = new Map<string, string>([
      ['/project/src/lib/a.ts', "import { y } from './b.js';\nexport const x = y;\n"],
      ['/project/src/lib/b.ts', "import { x } from './a.js';\nexport const y = x;\n"],
    ]);
    const extracted = extractCliArgv(
      "import { x } from '../lib/a.js';\nexport const inputSchema = x;\n",
      'src/cli/example.ts',
      '/project/src/cli/example.ts',
      {
        projectRoot: '/project',
        readModule: (path) => files.get(path),
        source: '/project/src/cli/example.ts',
      },
    );
    expect(codesOf(extracted.diagnostics)).toEqual(['AB4839']);
    expect(extracted.diagnostics[0]).toMatchObject({
      severity: 'error',
      sourcePath: '/project/src/cli/example.ts',
    });
    expect(extracted.diagnostics[0]!.message).toContain(
      'inputSchema -> x (src/lib/a.ts) -> y (src/lib/b.ts) -> x (src/lib/a.ts)',
    );
    expect(extracted.diagnostics[0]!.message).toContain('is a reference cycle.');
    expect(extracted.diagnostics[0]!.recovery).toContain('relative');
    expect(extracted.diagnostics[0]!.recovery).toContain('export const');
    expect(extracted.diagnostics[0]!.recovery).toContain('inspect again');
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

  it('projects an imported schema onto the same CompiledCliOption[] as its inline twin', async () => {
    const schema = [
      'z.object({',
      '  limit: z.number().int().min(1).optional(),',
      '  name: z.string().min(1),',
      '}).strict()',
    ].join('\n');
    const commandModule = (inputSchema: string): string => [
      `export const inputSchema = ${inputSchema};`,
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n');
    const inlineRoot = await createRoot();
    await writeTree(inlineRoot, {
      'src/cli/status.ts': commandModule(schema),
    });
    const importedRoot = await createRoot();
    await writeTree(importedRoot, {
      'src/cli/status.ts': commandModule('statusInputSchema').replace(
        'export const inputSchema',
        "import { statusInputSchema } from '../lib/protocol-schemas.js';\nexport const inputSchema",
      ),
      'src/lib/protocol-schemas.ts': `export const statusInputSchema = ${schema};\n`,
    });
    const inline = await compileRouteGraph(inlineRoot, fixtureConfig());
    const imported = await compileRouteGraph(importedRoot, fixtureConfig());
    expect(inline.diagnostics).toEqual([]);
    expect(imported.diagnostics).toEqual([]);
    expect(imported.cli?.commands?.[0]?.options).toEqual(inline.cli?.commands?.[0]?.options);
    expect(imported.cli?.commands?.[0]?.options).toEqual([
      { key: 'limit', kind: 'number', option: 'limit', repeated: false, required: false },
      { key: 'name', kind: 'string', option: 'name', repeated: false, required: true },
    ]);
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

  describe('the render budget a route declares in config.render (#454)', () => {
    const renderedCommandModule = (config: string): string => [
      `export const config = ${config};`,
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n');

    it('carries a valid budget on the compiled command, and a projected MCP command inherits its tool budget', async () => {
      const root = await createRoot();
      await writeTree(root, {
        'src/cli/await.tsx': renderedCommandModule('{ render: { maxElapsedMs: 7_200_000 } }'),
        'src/cli/plain.ts': plainCommandModule(),
        'src/mcp/alpha/tools/poll.tsx': toolModule("{ annotations: { readOnlyHint: true }, render: { maxElapsedMs: 120000 } }"),
        'src/mcp/alpha/tools/quick.tsx': toolModule("{ annotations: { readOnlyHint: true } }"),
      });

      const graph = await compileRouteGraph(root, fixtureConfig({ routes: { mcpCommands: true } }));

      expect(graph.diagnostics).toEqual([]);
      expect(graph.cli?.commands?.map((command) => [command.path.join(' '), command.render, command.rendered])).toEqual([
        ['alpha poll', { maxElapsedMs: 120_000 }, true],
        ['alpha quick', undefined, true],
        ['await', { maxElapsedMs: 7_200_000 }, true],
        ['plain', undefined, false],
      ]);
      // Absent budgets are absent keys, so pre-#454 graphs digest unchanged.
      expect(graph.cli?.commands?.map((command) => Object.hasOwn(command, 'render'))).toEqual([true, false, true, false]);
      // The compiled tool config keeps the budget for the generated server to read.
      expect(graph.servers[0]!.routes.find((route) => route.id === 'tool:alpha/poll')?.config).toEqual({
        annotations: { readOnlyHint: true },
        render: { maxElapsedMs: 120_000 },
      });
    });

    it('errors with AB4835 on a malformed budget, one over the 24-hour ceiling, or one on a plain command', async () => {
      const root = await createRoot();
      await writeTree(root, {
        'src/cli/ceiling.tsx': renderedCommandModule('{ render: { maxElapsedMs: 86_400_001 } }'),
        'src/cli/fraction.tsx': renderedCommandModule('{ render: { maxElapsedMs: 1.5 } }'),
        'src/cli/negative.tsx': renderedCommandModule('{ render: { maxElapsedMs: -1 } }'),
        'src/cli/plain.ts': plainCommandModule({ config: '{ render: { maxElapsedMs: 1000 } }' }),
        // Type-valid but meaningless on a plain command: the declaration itself is the defect.
        'src/cli/plain-empty.ts': plainCommandModule({ config: '{ render: {} }' }),
        'src/cli/shape.tsx': renderedCommandModule("{ render: 'long' }"),
        'src/cli/unknown.tsx': renderedCommandModule('{ render: { timeoutMs: 1000 } }'),
        'src/mcp/alpha/tools/text.tsx': toolModule("{ render: { maxElapsedMs: '60000' } }"),
      });

      const graph = await compileRouteGraph(root, fixtureConfig());

      expect(codesOf(graph.diagnostics)).toEqual(['AB4835', 'AB4835', 'AB4835', 'AB4835', 'AB4835', 'AB4835', 'AB4835', 'AB4835']);
      const messages = graph.diagnostics.map((diagnostic) => diagnostic.message);
      // Server routes are validated with their server, before the CLI surface compiles.
      expect(messages).toEqual([
        expect.stringContaining('MCP route src/mcp/alpha/tools/text.tsx config.render.maxElapsedMs must be a positive integer of milliseconds'),
        expect.stringContaining('CLI route src/cli/ceiling.tsx config.render.maxElapsedMs 86400001 exceeds the framework ceiling of 86400000 (24 hours)'),
        expect.stringContaining('CLI route src/cli/fraction.tsx config.render.maxElapsedMs must be a positive integer of milliseconds'),
        expect.stringContaining('CLI route src/cli/negative.tsx config.render.maxElapsedMs must be a positive integer of milliseconds'),
        expect.stringContaining('CLI route src/cli/plain.ts declares config.render, but a plain .ts command executes without a render session'),
        expect.stringContaining('CLI route src/cli/plain-empty.ts declares config.render, but a plain .ts command executes without a render session'),
        expect.stringContaining('CLI route src/cli/shape.tsx config.render must be an object'),
        expect.stringContaining('CLI route src/cli/unknown.tsx config.render declares unknown key "timeoutMs"'),
      ]);
      expect(graph.diagnostics[0]!.recovery).toContain('maxElapsedMs');
      expect(graph.diagnostics[0]!.sourcePath).toBe(join(root, 'src/mcp/alpha/tools/text.tsx'));
      // A route with a rejected config compiles no command; the route stays in the graph.
      expect(graph.cli?.commands).toEqual([]);
      expect(graph.cli?.routes.map((route) => route.id)).toContain('cli:plain');
    });
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
      readonly commands?: readonly CompiledCliCommand[];
      readonly result?: unknown;
      readonly signal?: AbortSignal;
      readonly throws?: Error;
      readonly web?: GeneratedCliWebCommand;
    } = {},
  ): Promise<RunResult> => {
    const calls: RunResult['calls'] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGeneratedCliEntry({
      argv,
      commands: options.commands ?? commands,
      description: 'Curate audiobooks.',
      execute: async (command, input, context) => {
        calls.push({ command, input, json: context.json });
        if (options.throws !== undefined) throw options.throws;
        return Object.hasOwn(options, 'result') ? options.result : { ok: true };
      },
      name: 'curator',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      version: '1.2.3',
      ...(options.web === undefined ? {} : { web: options.web }),
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

  describe('the framework-owned web command (#564)', () => {
    const webRow = "  web                Open one of the plugin's MCP Apps in a browser.";
    const recording = () => {
      const invocations: { argv: readonly string[]; context: GeneratedCliWebContext }[] = [];
      const web: GeneratedCliWebCommand = {
        run: async (argv, context) => {
          invocations.push({ argv, context });
          context.writeOut('MCP App status/status at http://127.0.0.1:4321/ (tool show_status; Ctrl-C stops the server)\n');
          return 7;
        },
      };
      return { invocations, web };
    };

    it('dispatches web with the arguments after it before consulting the authored tree', async () => {
      const { invocations, web } = recording();
      const controller = new AbortController();
      const result = await run(['web', 'status/status', '--json'], { signal: controller.signal, web });
      expect(result.code).toBe(7);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('MCP App status/status at http://127.0.0.1:4321/ (tool show_status; Ctrl-C stops the server)\n');
      expect(result.stderr).toBe('');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.argv).toEqual(['status/status', '--json']);
      expect(invocations[0]!.context.name).toBe('curator');
      expect(invocations[0]!.context.signal).toBe(controller.signal);
    });

    it('lists web among the root commands only when the executable carries it, and only at the root', async () => {
      const { web } = recording();
      const withWeb = await run(['--help'], { web });
      expect(withWeb.code).toBe(0);
      expect(withWeb.stdout).toContain('\nCommands:\n  doctor             Inspect the runtime.\n  library <command>\n  offset             Apply a signed offset.\n' + `${webRow}\n`);
      expect((await run([], { web })).stdout).toBe(withWeb.stdout);
      expect((await run(['--help'])).stdout).not.toContain('MCP Apps');
      expect((await run(['library', '--help'], { web })).stdout).not.toContain('MCP Apps');
    });

    it('prints the help listing web for an executable with no authored command', async () => {
      const { web } = recording();
      const help = await run(['--help'], { commands: [], web });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('Usage: curator <command> [options]');
      expect(help.stdout).toContain(`\nCommands:\n  web  Open one of the plugin's MCP Apps in a browser.\n`);
      expect(help.stderr).toBe('');
      expect((await run([], { commands: [], web })).stdout).toBe(help.stdout);
    });

    it('keeps --version ahead of web and web unknown without the hook', async () => {
      const { invocations, web } = recording();
      expect(await run(['--version'], { web })).toMatchObject({ code: 0, stdout: 'curator 1.2.3\n' });
      expect(invocations).toEqual([]);
      const unknown = await run(['web', 'status/status']);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain('Unknown command: web.');
    });
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

  describe('input-validation failures (#465)', () => {
    const doctor = commands[0]!;
    const audit = commands[1]!;
    const doctorSchema = z.object({
      maxFiles: z.number().int().max(55_000).default(8),
      root: z.string().min(1),
      verbose: z.boolean().optional(),
    }).strict();
    const failure = (schema: z.ZodType, input: Readonly<Record<string, unknown>>): unknown => {
      const result = schema.safeParse(input);
      if (result.success) throw new Error('fixture input unexpectedly valid');
      return result.error;
    };

    it('spells each zod issue as the CLI argument, the expectation, and the received value', () => {
      const error = cliInputError(doctor, { maxFiles: 300_000, root: '/library' }, failure(doctorSchema, { maxFiles: 300_000, root: '/library' }));
      expect(error).toBeInstanceOf(CliInputError);
      expect(error.issues).toEqual([{
        expected: 'number <= 55000',
        message: expect.stringContaining('55000'),
        received: 300_000,
        target: '--max-files',
      }]);
      expect(error.message).toBe('Invalid value for --max-files: expected number <= 55000; received 300000.');
      expect(error.message).not.toContain('"code"');

      const positional = cliInputError(doctor, { root: '' }, failure(doctorSchema, { root: '' }));
      expect(positional.message).toBe('Invalid value for <root>: expected non-empty string; received "".');

      const missing = cliInputError(doctor, {}, failure(doctorSchema, {}));
      expect(missing.issues).toEqual([{ expected: 'string', message: expect.any(String), target: '<root>' }]);
      expect(missing.message).toBe('Invalid value for <root>: expected string; received nothing.');

      const type = cliInputError(doctor, { maxFiles: 'many', root: '/library' }, failure(doctorSchema, { maxFiles: 'many', root: '/library' }));
      expect(type.message).toBe('Invalid value for --max-files: expected number; received "many".');
    });

    it('maps enum, length, unknown-key, and multi-issue failures one line per issue', () => {
      const auditSchema = z.object({
        format: z.enum(['json', 'table']).optional(),
        report: z.string(),
        sources: z.array(z.string()).max(2),
      }).strict();
      const input = { extra: true, format: 'xml', report: 'r', sources: ['a', 'b', 'c'] };
      const error = cliInputError(audit, input, failure(auditSchema, input));
      expect(error.issues.map((issue) => issue.target)).toEqual(['--format', '<sources>', 'input']);
      expect(error.message.split('\n')).toEqual([
        'Invalid value for --format: expected one of: "json", "table"; received "xml".',
        'Invalid value for <sources>: expected array with at most 2 items; received ["a","b","c"].',
        'Invalid value for input: expected no unknown key "extra"; received {"extra":true,"format":"xml","report":"r","sources":["a","b","c"]}.',
      ]);
    });

    it('keeps the operand of every string refinement in the bounded grammar', () => {
      const cases: readonly [schema: z.ZodType, value: string, expected: string][] = [
        [z.object({ root: z.string().startsWith('/') }), 'relative', 'string starting with "/"'],
        [z.object({ root: z.string().endsWith('.json') }), 'config.yaml', 'string ending with ".json"'],
        [z.object({ root: z.string().includes('@') }), 'nobody', 'string containing "@"'],
        [z.object({ root: z.string().regex(/^[a-z]+$/u) }), 'Nope', 'string matching /^[a-z]+$/u'],
        [z.object({ root: z.string().length(4) }), 'abc', 'string with exactly 4 characters'],
        [z.object({ root: z.url() }), 'not a url', 'URL'],
      ];
      for (const [schema, value, expected] of cases) {
        const error = cliInputError(doctor, { root: value }, failure(schema, { root: value }));
        expect(error.message).toBe(`Invalid value for <root>: expected ${expected}; received ${JSON.stringify(value)}.`);
      }
    });

    it('spells a projected MCP command path as --input.<path>', () => {
      const schema = z.object({ message: z.string(), nested: z.object({ count: z.number() }).optional() });
      const input = { message: 42, nested: { count: 'x' } };
      const error = cliInputError(readOnlyTool, input, failure(schema, input));
      expect(error.message.split('\n')).toEqual([
        'Invalid value for --input.message: expected string; received 42.',
        'Invalid value for --input.nested.count: expected number; received "x".',
      ]);
    });

    it('keeps a non-schema failure message-only', () => {
      const error = cliInputError(doctor, {}, new Error('root must be absolute'));
      expect(error.issues).toEqual([]);
      expect(error.message).toBe('root must be absolute');
    });

    it('prints one line per issue, the exact usage line, and the help hint; exit 2', async () => {
      const input = { maxFiles: 300_000, root: '/library' };
      const invalid = await run(['doctor', '/library', '--max-files', '300000'], {
        throws: cliInputError(doctor, input, failure(doctorSchema, input)),
      });
      expect(invalid.code).toBe(2);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toBe([
        'Invalid value for --max-files: expected number <= 55000; received 300000.',
        'Usage: curator doctor [options] <root>',
        "Run 'curator doctor --help' for usage.",
        '',
      ].join('\n'));
    });

    it('emits one canonical error object on stderr under --json and keeps stdout empty', async () => {
      const input = { maxFiles: 300_000, root: '/library' };
      const invalid = await run(['doctor', '/library', '--max-files', '300000', '--json'], {
        throws: cliInputError(doctor, input, failure(doctorSchema, input)),
      });
      expect(invalid.code).toBe(2);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr.endsWith('\n')).toBe(true);
      expect(invalid.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(JSON.parse(invalid.stderr)).toEqual({
        error: {
          code: 'CLI_INPUT_INVALID',
          issues: [{
            expected: 'number <= 55000',
            message: expect.stringContaining('55000'),
            received: 300_000,
            target: '--max-files',
          }],
          usage: 'Usage: curator doctor [options] <root>',
        },
      });
    });
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

  it('selects the output mode from the same terminal capability it hands the render host (#511)', async () => {
    const terminal: AgentTerminal = {
      hostSurface: 'cli',
      sharesTarget: true,
      stderr: { color: '256', columns: 132, kind: 'tty', rows: 50 },
      stdout: { color: '256', columns: 132, kind: 'tty', rows: 50 },
    };
    const seen: AgentTerminal[] = [];
    const stdout: string[] = [];
    const code = await runGeneratedCliEntry({
      argv: ['report', '/library'],
      commands: [renderedCommand],
      execute: async () => {
        throw new Error('plain execute must not run for a rendered command');
      },
      name: 'curator',
      render: (_command, _input, context) => {
        seen.push(context.terminal);
        return { close: async () => undefined, events: () => eventStream(events), validate: (value) => value };
      },
      terminal,
      version: '1.2.3',
      writeErr: () => undefined,
      writeOut: (text) => void stdout.push(text),
    });
    expect(code).toBe(0);
    // An explicit capability wins over probing and drives the interactive mode.
    expect(seen).toEqual([terminal]);
    expect(stdout.join('')).toBe('\r\u001B[2Kauditing (1/2)\r\u001B[2KFound **2** books.\n');

    // `--json` changes what stdout carries, never what the terminal is.
    seen.length = 0;
    await runGeneratedCliEntry({
      argv: ['report', '/library', '--json'],
      commands: [renderedCommand],
      execute: async () => undefined,
      name: 'curator',
      render: (_command, _input, context) => {
        seen.push(context.terminal);
        return { close: async () => undefined, events: () => eventStream(events), validate: (value) => value };
      },
      terminal,
      version: '1.2.3',
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    expect(seen).toEqual([terminal]);

    // The legacy `isTty` knob still shapes a consistent capability for stdout.
    const legacy: AgentTerminal[] = [];
    await runGeneratedCliEntry({
      argv: ['report', '/library'],
      commands: [renderedCommand],
      execute: async () => undefined,
      isTty: () => false,
      name: 'curator',
      render: (_command, _input, context) => {
        legacy.push(context.terminal);
        return { close: async () => undefined, events: () => eventStream(events), validate: (value) => value };
      },
      version: '1.2.3',
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    expect(legacy[0]?.hostSurface).toBe('cli');
    expect(legacy[0]?.stdout.kind).not.toBe('tty');
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
