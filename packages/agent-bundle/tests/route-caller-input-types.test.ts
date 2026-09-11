import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { build, validate } from '../src/api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const equality = [
  'type Equal<Left, Right> =',
  '  (<Value>() => Value extends Left ? 1 : 2) extends',
  '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
  'type Assert<Value extends true> = Value;',
];

/** The tool records every invocation it actually ran, so a rejected input provably ran nothing. */
const tool = (name: string, schema: string, result: string, body: string): string => [
  "import { Agent } from '@agent-bundle/runtime';",
  "import type { ToolRouteProps } from 'agent-bundle';",
  "import { appendFile } from 'node:fs/promises';",
  "import { createElement } from 'react';",
  "import { z } from 'zod';",
  `export const config = { description: '${name}' };`,
  `export const inputSchema = ${schema};`,
  `export const resultSchema = ${result};`,
  `export default async function Route({ input }: ToolRouteProps<typeof inputSchema>) {`,
  `  await appendFile(process.env['INVOCATIONS']!, JSON.stringify({ input, tool: '${name}' }) + '\\n');`,
  `  const value = ${body};`,
  "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, JSON.stringify(value)));",
  '}',
  '',
].join('\n');

const tsconfig = (include: readonly string[], lib: readonly string[]): string => `${JSON.stringify({
  compilerOptions: {
    composite: true,
    exactOptionalPropertyTypes: true,
    lib,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: 'ES2022',
    types: [],
  },
  include,
}, null, 2)}\n`;

/**
 * Type-checks one of the project's real tsconfig programs — the file set
 * `tsc -p <tsconfig>` compiles, resolved from the config on disk — optionally
 * with one extra entry added the way another `include` line would add it.
 */
const typecheckProgram = (root: string, tsconfigPath: string, extraEntry?: string): readonly string[] => {
  const read = ts.readConfigFile(join(root, tsconfigPath), ts.sys.readFile);
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, join(root, tsconfigPath));
  const program = ts.createProgram(
    [...parsed.fileNames, ...(extraEntry === undefined ? [] : [join(root, extraEntry)])],
    { ...parsed.options, composite: false, noEmit: true },
  );
  return ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};

const callTool = async (client: Client, name: string, input: Record<string, unknown>): Promise<unknown> => {
  try {
    return await client.callTool({ arguments: input, name }, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return error;
  }
};

/**
 * #752: the generated declarations type a caller by each schema's input and
 * the component by its output, so a defaulted field is optional to the App
 * and a transformed field is spelled as the wire carries it — proved in the
 * project's own browser and server tsconfig programs, then at run time
 * through the generated MCP server. #748: those programs are the ones
 * the consumer TypeScript check compiles.
 */
it('types callers by schema input and components by schema output in a clean generated project', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-caller-input-types-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  const invocations = join(root, 'invocations.ndjson');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'workspace:*', 'agent-bundle': 'workspace:*', react: '19.2.8', zod: '4.4.3' },
      name: 'caller-input-types-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'caller-input-types-fixture', version: '1.0.0' }, targets: ['portable'] });",
      '',
    ].join('\n')),
    // A defaulted field: optional to the caller, present for the component.
    writeProjectFile(root, 'src/mcp/curator/tools/page.ts', tool(
      'page',
      'z.object({ limit: z.number().default(10) }).strict()',
      'z.object({ limit: z.number() }).strict()',
      '{ limit: input.limit }',
    )),
    // A transformed field: the caller sends the string the wire carries, the component receives the number.
    writeProjectFile(root, 'src/mcp/curator/tools/measure.ts', tool(
      'measure',
      'z.object({ text: z.string().transform((value) => value.trim().length) }).strict()',
      'z.object({ length: z.number() }).strict()',
      '{ length: input.text }',
    )),
    writeProjectFile(root, 'src/mcp/curator/apps/dashboard.html', '<!doctype html><html><body><pre id="state"></pre></body></html>\n'),
    // The browser program: the App itself, compiled against the generated `AppRegister` augmentation.
    writeProjectFile(root, 'src/mcp/curator/apps/dashboard.ts', [
      "import { createAppClient, type AppRegister, type AppRouteInput, type AppRouteResult } from 'agent-bundle/app';",
      "export const config = { resourceUri: 'ui://caller-input-types-fixture/dashboard.html', template: './dashboard.html' };",
      ...equality,
      "export type PageInput = Assert<Equal<AppRouteInput<'tool:curator/page'>, { limit?: number | undefined }>>;",
      "export type PageResult = Assert<Equal<AppRouteResult<'tool:curator/page'>, { limit: number }>>;",
      "export type MeasureInput = Assert<Equal<AppRouteInput<'tool:curator/measure'>, { text: string }>>;",
      "export type Registered = Assert<Equal<AppRegister['routes']['tool:curator/measure'], Readonly<{ input: { text: string }; result: { length: number } }>>>;",
      "const client = createAppClient({ appInfo: { name: 'dashboard', version: '1.0.0' } });",
      '// The opening input is the host\'s payload, before the server parses it: the default may be absent.',
      "client.onToolInput('tool:curator/page', (input) => { const limit: number | undefined = input.limit; void limit; });",
      'await client.connect();',
      "export const defaulted = await client.call('tool:curator/page', {});",
      "export const explicit = await client.call('tool:curator/page', { limit: 5 });",
      "export const measured = await client.call('tool:curator/measure', { text: '  hi  ' });",
      "document.querySelector('#state')!.textContent = String(defaulted.limit + explicit.limit + measured.length);",
      '',
    ].join('\n')),
    // The server program: the component sees the parsed output.
    writeProjectFile(root, 'src/handler-types.ts', [
      "import type { ToolRouteProps } from 'agent-bundle';",
      "import type { RegisteredRouteInput, RegisteredRouteParsedInput } from '@agent-bundle/runtime';",
      "import type { inputSchema as measureSchema } from './mcp/curator/tools/measure.js';",
      "import type { inputSchema as pageSchema } from './mcp/curator/tools/page.js';",
      ...equality,
      "export type PageProps = Assert<Equal<ToolRouteProps<typeof pageSchema>['input'], { limit: number }>>;",
      "export type MeasureProps = Assert<Equal<ToolRouteProps<typeof measureSchema>['input'], { text: number }>>;",
      '// The registration carries both sides: what a caller sends and what the component receives.',
      "export type PageCaller = Assert<Equal<RegisteredRouteInput<'tool:curator/page'>, { limit?: number | undefined }>>;",
      "export type PageParsed = Assert<Equal<RegisteredRouteParsedInput<'tool:curator/page'>, { limit: number }>>;",
      "export type MeasureParsed = Assert<Equal<RegisteredRouteParsedInput<'tool:curator/measure'>, { text: number }>>;",
      '',
    ].join('\n')),
    // Negative cases, each its own entry so one program reports exactly one rejection.
    writeProjectFile(root, 'negative/wrong-id.ts', [
      "import { createAppClient } from 'agent-bundle/app';",
      "void createAppClient().call('tool:curator/missing', {});",
      '',
    ].join('\n')),
    writeProjectFile(root, 'negative/missing-required.ts', [
      "import { createAppClient } from 'agent-bundle/app';",
      "void createAppClient().call('tool:curator/measure', {});",
      '',
    ].join('\n')),
    writeProjectFile(root, 'negative/wrong-primitive.ts', [
      "import { createAppClient } from 'agent-bundle/app';",
      "void createAppClient().call('tool:curator/page', { limit: 'ten' });",
      '',
    ].join('\n')),
    // The reverse mismatch: the component's parsed number is not what the caller sends.
    writeProjectFile(root, 'negative/parsed-as-caller.ts', [
      "import { createAppClient } from 'agent-bundle/app';",
      "void createAppClient().call('tool:curator/measure', { text: 4 });",
      '',
    ].join('\n')),
    // A solution-style root: one browser program, one server program, each judged on its own.
    writeProjectFile(root, 'tsconfig.json', `${JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }, null, 2)}\n`),
    writeProjectFile(root, 'tsconfig.app.json', tsconfig(['src/mcp/**/apps/*.ts', '.agent-bundle/routes.d.ts'], ['DOM', 'ES2022'])),
    writeProjectFile(root, 'tsconfig.node.json', tsconfig(['src/**/tools/*.ts', 'src/handler-types.ts', '.agent-bundle/routes.d.ts'], ['ES2022'])),
  ]);

  // The documented entry: `validate` publishes the declaration for a clean checkout, before the consumer checks both programs.
  const validated = await validate({ root });
  expect(validated.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const generated = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(generated).toContain('input: SchemaInput<InputSchema>;');
  expect(generated.split('\n').filter((line) => line.startsWith('import')).every((line) => line.startsWith('import type * as '))).toBe(true);

  expect(typecheckProgram(root, 'tsconfig.app.json')).toEqual([]);
  expect(typecheckProgram(root, 'tsconfig.node.json')).toEqual([]);
  const wrongId = typecheckProgram(root, 'tsconfig.app.json', 'negative/wrong-id.ts');
  expect(wrongId).toHaveLength(1);
  expect(wrongId[0]).toMatch(/tool:curator\/missing/u);
  const missingRequired = typecheckProgram(root, 'tsconfig.app.json', 'negative/missing-required.ts');
  expect(missingRequired).toHaveLength(1);
  expect(missingRequired[0]).toMatch(/Property 'text' is missing/u);
  const wrongPrimitive = typecheckProgram(root, 'tsconfig.app.json', 'negative/wrong-primitive.ts');
  expect(wrongPrimitive).toHaveLength(1);
  expect(wrongPrimitive[0]).toMatch(/Type 'string' is not assignable to type 'number'/u);
  const parsedAsCaller = typecheckProgram(root, 'tsconfig.app.json', 'negative/parsed-as-caller.ts');
  expect(parsedAsCaller).toHaveLength(1);
  expect(parsedAsCaller[0]).toMatch(/Type 'number' is not assignable to type 'string'/u);

  // The consumer compiler, rather than framework validation, proves declaration inclusion.
  await writeProjectFile(root, 'tsconfig.app.json', tsconfig(['src/mcp/**/apps/*.ts'], ['DOM', 'ES2022']));
  expect((await validate({ root })).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  expect(typecheckProgram(root, 'tsconfig.app.json')).not.toEqual([]);
  await writeProjectFile(root, 'tsconfig.app.json', tsconfig(['src/mcp/**/apps/*.ts', '.agent-bundle/routes.d.ts'], ['DOM', 'ES2022']));

  // The same schema at run time, through the generated server: the default is applied once, the transform once,
  // and an input the schema rejects never reaches the component.
  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const server = compiled.model.mcpServers[0];
  if (server?.args?.[0] === undefined) throw new Error('expected a generated MCP entry');
  const client = new Client({ name: 'caller-input-types', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [join(output, server.args[0])],
    command: process.execPath,
    env: { ...process.env, INVOCATIONS: invocations },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    expect(await callTool(client, 'page', {})).toMatchObject({ structuredContent: { limit: 10 } });
    expect(await callTool(client, 'page', { limit: 5 })).toMatchObject({ structuredContent: { limit: 5 } });
    expect(await callTool(client, 'measure', { text: '  hi  ' })).toMatchObject({ structuredContent: { length: 2 } });
    const rejected = await callTool(client, 'page', { limit: 'ten' });
    expect(rejected instanceof Error ? rejected.message : JSON.stringify(rejected)).toMatch(/limit|invalid/iu);
    const missing = await callTool(client, 'measure', {});
    expect(missing instanceof Error ? missing.message : JSON.stringify(missing)).toMatch(/text|invalid/iu);
  } finally {
    await client.close();
  }
  expect((await readFile(invocations, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
    { input: { limit: 10 }, tool: 'page' },
    { input: { limit: 5 }, tool: 'page' },
    { input: { text: 2 }, tool: 'measure' },
  ]);
});
