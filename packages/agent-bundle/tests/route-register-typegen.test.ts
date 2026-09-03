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

/**
 * The generated declarations register the project's route contracts on
 * `@agent-bundle/runtime`'s `Register` (TanStack Router's registration
 * pattern), so `renderRoute` narrows its id, `input`, and `result` from the
 * route modules' own schemas with no per-route declaration file — and the
 * same program without the generated file degrades to `string` / `unknown`.
 */
it('types renderRoute ids, inputs, and results from the generated route registration', { timeout: 60_000 }, async () => {
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
    writeProjectFile(root, 'src/events/tool/after.ts', [
      "import type { AgentEventRouteProps } from 'agent-bundle';",
      'export default async function ToolAfter(props: AgentEventRouteProps) { return props.canonical.event; }',
      '',
    ].join('\n')),
    writeProjectFile(root, 'assertions.ts', [
      "import type { AgentEventCanonicalIdentity, AgentEventNativePayload } from 'agent-bundle';",
      "import type { RegisteredRouteId, RegisteredRouteInput, RegisteredRouteResult } from '@agent-bundle/runtime';",
      "import { renderRoute, renderRouteEvents } from 'agent-bundle/test';",
      '',
      ...equalityHelpers,
      '',
      "export type Ids = Assert<Equal<RegisteredRouteId, 'event:tool/after' | 'tool:curator/find' | 'tool:curator/status'>>;",
      "export type FindInput = Assert<Equal<RegisteredRouteInput<'tool:curator/find'>, { query: string }>>;",
      "export type FindResult = Assert<Equal<RegisteredRouteResult<'tool:curator/find'>, { hits: number }>>;",
      "export type Unregistered = Assert<Equal<RegisteredRouteInput<'tool:curator/missing'>, unknown>>;",
      '// An event route registers the harness payload — the component props without the `signal` the harness',
      '// injects — and no result, since event modules export no resultSchema.',
      "export type EventInput = Assert<Equal<keyof RegisteredRouteInput<'event:tool/after'>, 'canonical' | 'native'>>;",
      "export type EventCanonical = Assert<Equal<RegisteredRouteInput<'event:tool/after'>['canonical'], AgentEventCanonicalIdentity>>;",
      "export type EventNative = Assert<Equal<RegisteredRouteInput<'event:tool/after'>['native'], AgentEventNativePayload>>;",
      "export type EventResult = Assert<Equal<RegisteredRouteResult<'event:tool/after'>, undefined>>;",
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
      '  void hits; void status; void none; void anything;',
      '};',
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
      "import type { RegisteredRouteId, RegisteredRouteResult } from '@agent-bundle/runtime';",
      "import { renderRoute } from 'agent-bundle/test';",
      '',
      ...equalityHelpers,
      '',
      '// Without the generated file in the program, ids are string and contracts are unknown.',
      'export type Ids = Assert<Equal<RegisteredRouteId, string>>;',
      "export type Result = Assert<Equal<RegisteredRouteResult<'tool:curator/find'>, unknown>>;",
      "export const anyId = renderRoute('tool:curator/missing', { input: { query: 7 } });",
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
  expect(wrongId[0]).toContain('Argument of type \'"tool:curator/missing"\' is not assignable to parameter of type \'"event:tool/after" | "tool:curator/find" | "tool:curator/status"\'');
  const wrongInput = typecheck(root, 'wrong-input.ts', true);
  expect(wrongInput).toHaveLength(1);
  expect(wrongInput[0]).toContain("Type 'number' is not assignable to type 'string'");
  const wrongEventInput = typecheck(root, 'wrong-event-input.ts', true);
  expect(wrongEventInput).toHaveLength(1);
  expect(wrongEventInput[0]).toContain("Type 'string' is not assignable to type 'AgentEventCanonicalIdentity'");
  const wrongResult = typecheck(root, 'wrong-result.ts', true);
  expect(wrongResult).toHaveLength(1);
  expect(wrongResult[0]).toContain("Type 'number | undefined' is not assignable to type 'string | undefined'");

  expect(typecheck(root, 'unregistered.ts', false)).toEqual([]);
});
