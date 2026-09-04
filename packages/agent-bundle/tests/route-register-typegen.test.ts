import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { inspect } from '../src/api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

/**
 * Type-checks one fixture entry against the real published `agent-bundle/test`
 * and `@agent-bundle/runtime` declarations. `registered` adds the generated
 * `.agent-bundle/routes.d.ts` to the program the way a project's `tsconfig.json`
 * `include` would; omitting it is the degraded, unregistered program.
 */
const typecheck = (root: string, entry: string, registered: boolean): readonly string[] => {
  const program = ts.createProgram(
    [join(root, entry), ...(registered ? [join(root, '.agent-bundle', 'routes.d.ts')] : [])],
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

const equalityHelpers = [
  'type Equal<Left, Right> =',
  '  (<Value>() => Value extends Left ? 1 : 2) extends',
  '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
  'type Assert<Value extends true> = Value;',
];

const registeredIds = [
  'cli:report',
  'event:tool/after',
  'prompt:curator/brief',
  'tool:curator/find',
  'tool:curator/status',
  'tool:shelf/find',
] as const;

/**
 * The generated declarations register the project's route contracts on
 * `@agent-bundle/runtime`'s `Register` (TanStack Router's registration
 * pattern), so every route-aware public surface — `renderRoute`, the wire
 * helpers `invokeMcpTool`/`getMcpPrompt`, the contract-matrix `fixtures`,
 * `invokeCli`'s reported `routeId`, and `agent-bundle/eval`'s
 * `expectMcpCall` — narrows its id or name, `input`, and `result` from the
 * route modules' own schemas with no per-route declaration file — and the
 * same program without the generated file degrades to `string` / `unknown`.
 */
it('types every route-aware public surface from the generated route registration', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-register-'));
  roots.push(root);
  // The audiobook example's installed tree supplies the built agent-bundle, @agent-bundle/runtime, and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'workspace:*', 'agent-bundle': 'workspace:*', zod: '4.4.3' },
      name: 'route-register-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { name: 'route-register-fixture', version: '1.0.0' },",
      "  targets: ['claude'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/tools/status.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ status: z.literal('ready') }).strict();",
      "export default async function Status() { return { status: 'ready' as const }; }",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/tools/find.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({ query: z.string() }).strict();',
      'export const resultSchema = z.object({ hits: z.number() }).strict();',
      'export default async function Find() { return { hits: 1 }; }',
      '',
    ].join('\n')),
    // A second server registering the same tool name: the wire helpers see the union of both inputs.
    writeProjectFile(root, 'src/mcp/shelf/tools/find.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({ isbn: z.string() }).strict();',
      'export const resultSchema = z.object({ shelved: z.boolean() }).strict();',
      'export default async function Find() { return { shelved: true }; }',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/prompts/brief.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({ topic: z.string() }).strict();',
      "export const resultSchema = z.object({ messages: z.array(z.object({ content: z.object({ text: z.string(), type: z.literal('text') }).strict(), role: z.literal('user') }).strict()) }).strict();",
      "export default async function Brief() { return { messages: [{ content: { text: 'brief', type: 'text' as const }, role: 'user' as const }] }; }",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/report.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({ verbose: z.boolean().optional() }).strict();',
      'export const resultSchema = z.object({ lines: z.number() }).strict();',
      'export default async function Report() { return { lines: 1 }; }',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.ts', [
      "import type { AgentEventRouteProps } from 'agent-bundle';",
      'export default async function ToolAfter(props: AgentEventRouteProps) { return props.canonical.event; }',
      '',
    ].join('\n')),
    writeProjectFile(root, 'assertions.ts', [
      "import type { AgentEventCanonicalIdentity, AgentEventNativePayload } from 'agent-bundle';",
      "import { expectMcpCall, expectNoMcpCall } from 'agent-bundle/eval';",
      'import type {',
      '  RegisteredMcpRouteId,',
      '  RegisteredMcpRouteName,',
      '  RegisteredMcpServerName,',
      '  RegisteredRouteId,',
      '  RegisteredRouteInput,',
      '  RegisteredRouteResult,',
      "} from '@agent-bundle/runtime';",
      'import {',
      '  getMcpPrompt,',
      '  invokeCli,',
      '  invokeMcpTool,',
      '  loadRouteModule,',
      '  renderRoute,',
      '  renderRouteEvents,',
      '  runContractMatrix,',
      '  runPackedContractMatrix,',
      '  type ContractRouteFixture,',
      '  type ContractRouteFixtures,',
      '  type McpRouteInput,',
      '  type PackedMcpSession,',
      '  type PackedContractMatrixOptions,',
      "} from 'agent-bundle/test';",
      '',
      ...equalityHelpers,
      '',
      `export type Ids = Assert<Equal<RegisteredRouteId, ${registeredIds.map((id) => `'${id}'`).join(' | ')}>>;`,
      "export type FindInput = Assert<Equal<RegisteredRouteInput<'tool:curator/find'>, { query: string }>>;",
      "export type FindResult = Assert<Equal<RegisteredRouteResult<'tool:curator/find'>, { hits: number }>>;",
      "export type Unregistered = Assert<Equal<RegisteredRouteInput<'tool:curator/missing'>, unknown>>;",
      '// An event route registers the harness payload — the component props without the `signal` the harness',
      '// injects — and no result, since event modules export no resultSchema.',
      "export type EventInput = Assert<Equal<keyof RegisteredRouteInput<'event:tool/after'>, 'canonical' | 'native'>>;",
      "export type EventCanonical = Assert<Equal<RegisteredRouteInput<'event:tool/after'>['canonical'], AgentEventCanonicalIdentity>>;",
      "export type EventNative = Assert<Equal<RegisteredRouteInput<'event:tool/after'>['native'], AgentEventNativePayload>>;",
      "export type EventResult = Assert<Equal<RegisteredRouteResult<'event:tool/after'>, undefined>>;",
      '// The MCP server and protocol names a registered id encodes (TanStack\'s `RoutesByPath` shape).',
      "export type Servers = Assert<Equal<RegisteredMcpServerName, 'curator' | 'shelf'>>;",
      "export type ToolNames = Assert<Equal<RegisteredMcpRouteName<'tool'>, 'find' | 'status'>>;",
      "export type ShelfToolNames = Assert<Equal<RegisteredMcpRouteName<'tool', 'shelf'>, 'find'>>;",
      "export type PromptNames = Assert<Equal<RegisteredMcpRouteName<'prompt'>, 'brief'>>;",
      "export type FindIds = Assert<Equal<RegisteredMcpRouteId<'tool', string, 'find'>, 'tool:curator/find' | 'tool:shelf/find'>>;",
      "export type FindWireInput = Assert<Equal<McpRouteInput<'find', 'tool'>, { query: string } | { isbn: string }>>;",
      "export type ShelfFindWireInput = Assert<Equal<McpRouteInput<'find', 'tool', 'shelf'>, { isbn: string }>>;",
      "export type DynamicWireInput = Assert<Equal<McpRouteInput<string, 'tool'>, unknown>>;",
      '',
      'export const typed = async (canonical: AgentEventCanonicalIdentity, native: AgentEventNativePayload): Promise<void> => {',
      "  const found = await renderRoute('tool:curator/find', { input: { query: 'dune' } });",
      '  // `result` is the route\'s own resultSchema output, no cast.',
      '  const hits: number | undefined = found.result?.hits;',
      "  const streamed = await renderRouteEvents('tool:curator/status');",
      "  const status: 'ready' | undefined = streamed.result?.status;",
      '  // A valid event-route call carries exactly `{ canonical, native }`; the harness supplies the signal.',
      "  const after = await renderRoute('event:tool/after', { input: { canonical, native } });",
      '  const none: undefined = after.result;',
      '  // A value typed string stays legal for dynamic lookups and observes unknown.',
      "  const dynamic: string = ['tool:curator/status'].join('');",
      '  const loose = await renderRoute(dynamic);',
      '  const anything: unknown = loose.result;',
      '  // The wire helpers take the protocol name; `input` is the registered input of every route with that name,',
      '  // or of the one route on a literal `server`.',
      "  await invokeMcpTool('status');",
      "  await invokeMcpTool('find', { input: { query: 'dune' } });",
      "  await invokeMcpTool('find', { input: { query: 'dune' }, server: 'curator' });",
      "  await invokeMcpTool('find', { input: { isbn: '9780441172719' }, server: 'shelf' });",
      "  await invokeMcpTool('find', { input: { isbn: '9780441172719' }, server: dynamic });",
      "  await invokeMcpTool(dynamic, { input: { anything: true }, server: dynamic });",
      "  await getMcpPrompt('brief', { input: { topic: 'dune' } });",
      "  await getMcpPrompt('brief', { input: { topic: 'dune' }, server: 'curator' });",
      '  // A contract-matrix fixture map types each registered key\'s inputs; unregistered keys (MCP App routes) stay legal.',
      '  const fixtures: ContractRouteFixtures = {',
      "    'tool:curator/find': { cancellation: { input: { query: 'slow' } }, input: { query: 'dune' }, inputs: [{ query: 'arrakis' }], resultCompat: 'closed' },",
      "    'tool:curator/status': { input: {}, resultCompat: 'closed' },",
      "    'prompt:curator/brief': { input: { topic: 'dune' } },",
      "    'app:curator/dashboard': { kind: 'resource' },",
      '  };',
      '  await runContractMatrix({ fixtures });',
      '  // A record built dynamically stays legal with unknown inputs.',
      '  const dynamicFixtures: Readonly<Record<string, ContractRouteFixture>> = {};',
      "  await runContractMatrix({ fixtures: dynamicFixtures, server: 'curator' });",
      '  const packed = (session: PackedMcpSession, manifest: PackedContractMatrixOptions[\'manifest\']) =>',
      "    runPackedContractMatrix({ fixtures: { 'tool:shelf/find': { input: { isbn: '1' }, resultCompat: 'additive' } }, manifest, session });",
      "  // `invokeCli` reports the executed route's registered id; argv itself is untyped.",
      "  const ran = await invokeCli(['report', '--verbose']);",
      '  const executed: RegisteredRouteId | undefined = ran.routeId;',
      "  const isReport: boolean = ran.routeId === 'cli:report';",
      '  // Eval assertions check a literal tool against the registered tools of that server; other servers stay free.',
      "  expectMcpCall({ server: 'curator', tool: 'find' });",
      "  expectMcpCall({ server: 'shelf', tool: 'find', atLeast: 2 });",
      "  expectNoMcpCall({ server: 'curator' });",
      "  expectNoMcpCall({ server: 'github', tool: 'search_issues' });",
      "  expectMcpCall({ server: dynamic, tool: dynamic });",
      '  // loadRouteModule checks its id the same way and types the schemas\' parsed values from the registration.',
      "  const found_module = await loadRouteModule('tool:curator/find');",
      "  const parsedQuery: string | undefined = found_module.inputSchema?.parse({ query: 'dune' }).query;",
      '  const parsedHits: number | undefined = found_module.resultSchema?.parse({ hits: 1 }).hits;',
      '  const looseModule = await loadRouteModule(dynamic);',
      '  const looseParsed: unknown = looseModule.resultSchema?.parse({});',
      '  // A conventional script is loadable by literal even though scripts are not registered.',
      "  const script = await loadRouteModule('script:anything');",
      '  const scriptParsed: unknown = script.resultSchema?.parse({});',
      '  void hits; void status; void none; void anything; void packed; void executed; void isReport;',
      '  void parsedQuery; void parsedHits; void looseParsed; void scriptParsed;',
      '};',
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-tool-name.ts', [
      "import { invokeMcpTool } from 'agent-bundle/test';",
      "export const missing = invokeMcpTool('missing');",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-tool-input.ts', [
      "import { invokeMcpTool } from 'agent-bundle/test';",
      "export const mistyped = invokeMcpTool('status', { input: { query: 'dune' } });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-prompt-input.ts', [
      "import { getMcpPrompt } from 'agent-bundle/test';",
      "export const mistyped = getMcpPrompt('brief', { input: { topic: 7 } });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-server-tool.ts', [
      "import { invokeMcpTool } from 'agent-bundle/test';",
      "export const elsewhere = invokeMcpTool('status', { server: 'shelf' });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-server-input.ts', [
      "import { invokeMcpTool } from 'agent-bundle/test';",
      "export const mistyped = invokeMcpTool('find', { input: { query: 'dune' }, server: 'shelf' });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-server-name.ts', [
      "import { getMcpPrompt } from 'agent-bundle/test';",
      "export const missing = getMcpPrompt('brief', { input: { topic: 'dune' }, server: 'librarian' });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-fixture-input.ts', [
      "import { runContractMatrix } from 'agent-bundle/test';",
      "export const mistyped = runContractMatrix({ fixtures: { 'tool:curator/find': { input: { query: 7 }, resultCompat: 'closed' } } });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-fixture-transition.ts', [
      "import { runContractMatrix } from 'agent-bundle/test';",
      'export const mistyped = runContractMatrix({ fixtures: {',
      "  'tool:curator/find': {",
      "    lifecycle: { transitionDriver: () => [{ expectedStructuredContent: {}, input: { isbn: '1' }, phase: 'terminal', progressNotifications: 0 }] },",
      "    resultCompat: 'closed',",
      '  },',
      '} });',
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-cli-route.ts', [
      "import { invokeCli } from 'agent-bundle/test';",
      "export const compared = async (): Promise<boolean> => (await invokeCli(['report'])).routeId === 'cli:missing';",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-eval-tool.ts', [
      "import { expectMcpCall } from 'agent-bundle/eval';",
      "export const mistyped = expectMcpCall({ server: 'shelf', tool: 'status' });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-event-input.ts', [
      "import { renderRoute } from 'agent-bundle/test';",
      "export const mistyped = renderRoute('event:tool/after', { input: { canonical: 'tool/after', native: {} } });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-id.ts', [
      "import { renderRoute } from 'agent-bundle/test';",
      "export const missing = renderRoute('tool:curator/missing');",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-load-id.ts', [
      "import { loadRouteModule } from 'agent-bundle/test';",
      "export const missing = loadRouteModule('tool:curator/missing');",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-input.ts', [
      "import { renderRoute } from 'agent-bundle/test';",
      "export const mistyped = renderRoute('tool:curator/find', { input: { query: 7 } });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'wrong-result.ts', [
      "import { renderRoute } from 'agent-bundle/test';",
      "export const narrowed = async (): Promise<string | undefined> => (await renderRoute('tool:curator/find')).result?.hits;",
      '',
    ].join('\n')),
    writeProjectFile(root, 'unregistered.ts', [
      "import { expectMcpCall } from 'agent-bundle/eval';",
      "import type { RegisteredMcpRouteName, RegisteredMcpServerName, RegisteredRouteId, RegisteredRouteResult } from '@agent-bundle/runtime';",
      "import { getMcpPrompt, invokeCli, invokeMcpTool, renderRoute, runContractMatrix, type McpRouteInput } from 'agent-bundle/test';",
      '',
      ...equalityHelpers,
      '',
      '// Without the generated file in the program, ids and names are string and contracts are unknown.',
      'export type Ids = Assert<Equal<RegisteredRouteId, string>>;',
      "export type Result = Assert<Equal<RegisteredRouteResult<'tool:curator/find'>, unknown>>;",
      'export type Servers = Assert<Equal<RegisteredMcpServerName, string>>;',
      "export type ToolNames = Assert<Equal<RegisteredMcpRouteName<'tool'>, string>>;",
      "export type WireInput = Assert<Equal<McpRouteInput<'find', 'tool'>, unknown>>;",
      "export const anyId = renderRoute('tool:curator/missing', { input: { query: 7 } });",
      "export const anyTool = invokeMcpTool('missing', { input: { query: 7 }, server: 'librarian' });",
      "export const anyPrompt = getMcpPrompt('missing', { input: { topic: 7 } });",
      "export const anyFixture = runContractMatrix({ fixtures: { 'tool:curator/missing': { input: { query: 7 }, resultCompat: 'closed' } } });",
      "export const anyRoute = async (): Promise<string | undefined> => (await invokeCli(['report'])).routeId;",
      "export const anyAssertion = expectMcpCall({ server: 'curator', tool: 'missing' });",
      '',
    ].join('\n')),
  ]);

  const result = await inspect({ root });
  expect(result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)).toEqual([]);
  expect(result.state).toBe('ready');
  const declarations = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(declarations).toContain("declare module '@agent-bundle/runtime' {\n  interface Register {\n    readonly routes: AgentBundleRouteContracts;\n  }\n}");

  expect(typecheck(root, 'assertions.ts', true)).toEqual([]);
  const wrongId = typecheck(root, 'wrong-id.ts', true);
  expect(wrongId).toHaveLength(1);
  // The rejection names the registered ids, not `never`.
  expect(wrongId[0]).toContain(`Argument of type '"tool:curator/missing"' is not assignable to parameter of type '${registeredIds.map((id) => `"${id}"`).join(' | ')}'`);
  const wrongLoadId = typecheck(root, 'wrong-load-id.ts', true);
  expect(wrongLoadId).toHaveLength(1);
  // Scripts are not registered, so a `script:` literal is admitted beside the registered ids.
  expect(wrongLoadId[0]).toContain(`Argument of type '"tool:curator/missing"' is not assignable to parameter of type '${registeredIds.map((id) => `"${id}"`).join(' | ')} | \`script:\${string}\`'`);
  const wrongInput = typecheck(root, 'wrong-input.ts', true);
  expect(wrongInput).toHaveLength(1);
  expect(wrongInput[0]).toContain("Type 'number' is not assignable to type 'string'");
  const wrongEventInput = typecheck(root, 'wrong-event-input.ts', true);
  expect(wrongEventInput).toHaveLength(1);
  expect(wrongEventInput[0]).toContain("Type 'string' is not assignable to type 'AgentEventCanonicalIdentity'");
  const wrongResult = typecheck(root, 'wrong-result.ts', true);
  expect(wrongResult).toHaveLength(1);
  expect(wrongResult[0]).toContain("Type 'number | undefined' is not assignable to type 'string | undefined'");

  // The wire helpers: a tool name is checked against the registered protocol names of that kind, and
  // `input` against the named route's own schema.
  const wrongToolName = typecheck(root, 'wrong-tool-name.ts', true);
  expect(wrongToolName).toHaveLength(1);
  expect(wrongToolName[0]).toContain('Argument of type \'"missing"\' is not assignable to parameter of type \'"find" | "status"\'');
  const wrongToolInput = typecheck(root, 'wrong-tool-input.ts', true);
  expect(wrongToolInput).toHaveLength(1);
  // `status` registers `z.object({}).strict()`, so a stray key is rejected against `Record<string, never>`.
  expect(wrongToolInput[0]).toContain("Type 'string' is not assignable to type 'never'");
  const wrongPromptInput = typecheck(root, 'wrong-prompt-input.ts', true);
  expect(wrongPromptInput).toHaveLength(1);
  expect(wrongPromptInput[0]).toContain("Type 'number' is not assignable to type 'string'");
  // A literal `server` binds the lookup to that server's routes, since the session mounts only those:
  // a name another server registers, and the other server's input, are rejected; an unknown server is
  // rejected on `server` itself, naming the compiled ones.
  const wrongServerTool = typecheck(root, 'wrong-server-tool.ts', true);
  expect(wrongServerTool).toHaveLength(1);
  expect(wrongServerTool[0]).toContain('Argument of type \'"status"\' is not assignable to parameter of type \'"find"\'');
  const wrongServerInput = typecheck(root, 'wrong-server-input.ts', true);
  expect(wrongServerInput).toHaveLength(1);
  expect(wrongServerInput[0]).toContain("'query' does not exist in type '{ isbn: string; }'");
  const wrongServerName = typecheck(root, 'wrong-server-name.ts', true);
  expect(wrongServerName).toHaveLength(1);
  expect(wrongServerName[0]).toContain('Type \'"librarian"\' is not assignable to type \'"curator" | "shelf" | undefined\'');

  // Contract-matrix fixtures: a registered key's `input` and lifecycle transitions carry that route's input.
  const wrongFixtureInput = typecheck(root, 'wrong-fixture-input.ts', true);
  expect(wrongFixtureInput).toHaveLength(1);
  expect(wrongFixtureInput[0]).toContain("Type 'number' is not assignable to type 'string'");
  const wrongFixtureTransition = typecheck(root, 'wrong-fixture-transition.ts', true);
  expect(wrongFixtureTransition).toHaveLength(1);
  expect(wrongFixtureTransition[0]).toContain("'isbn' does not exist in type '{ query: string; }'");

  // `invokeCli` reports a registered id, so comparing it with an unregistered literal is rejected.
  const wrongCliRoute = typecheck(root, 'wrong-cli-route.ts', true);
  expect(wrongCliRoute).toHaveLength(1);
  expect(wrongCliRoute[0]).toContain('This comparison appears to be unintentional');

  // Eval assertions: a literal tool is checked against the registered tools of that literal server.
  const wrongEvalTool = typecheck(root, 'wrong-eval-tool.ts', true);
  expect(wrongEvalTool).toHaveLength(1);
  expect(wrongEvalTool[0]).toContain('Type \'"status"\' is not assignable to type \'"find"\'');

  expect(typecheck(root, 'unregistered.ts', false)).toEqual([]);
});
