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

const typecheck = (root: string, entry: string): readonly string[] => {
  const program = ts.createProgram([join(root, entry), join(root, '.agent-bundle', 'routes.d.ts')], {
    exactOptionalPropertyTypes: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  });
  return ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};

/**
 * #95 acceptance: a project-defined provider adds a typed context property
 * without a compiler change. The compiler publishes `.agent-bundle/routes.d.ts`
 * with `AgentBundleProviders` and a `@agent-bundle/runtime` augmentation, so
 * `(await agent()).providers.<key>` observes the provider factory's resolved
 * return type against the real published runtime declarations.
 */
it('types (await agent()).providers.<key> from the generated provider declarations', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-provider-typegen-'));
  roots.push(root);
  // The audiobook example's installed tree supplies the built @agent-bundle/runtime and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'workspace:*', zod: '4.4.3' },
      name: 'provider-typegen-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { name: 'provider-typegen-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/library.ts', [
      "import type { AgentProviderContext } from 'agent-bundle';",
      'export interface LibraryContext { readonly stages: readonly string[]; readonly surface: string; }',
      'export default async function library({ invocation }: AgentProviderContext): Promise<LibraryContext> {',
      "  return { stages: ['discover'], surface: invocation.kind };",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/build-number.ts', [
      'export default function buildNumber(): number {',
      '  return 7;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/tools/status.ts', [
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ status: z.literal('ready') }).strict();",
      "export default async function Status() { return { status: 'ready' as const }; }",
      '',
    ].join('\n')),
    writeProjectFile(root, 'assertions.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      "import type { ProviderKey, ProviderValue } from './.agent-bundle/routes.js';",
      "import type { LibraryContext } from './src/providers/library.js';",
      '',
      'type Equal<Left, Right> =',
      '  (<Value>() => Value extends Left ? 1 : 2) extends',
      '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
      'type Assert<Value extends true> = Value;',
      '',
      "export type Keys = Assert<Equal<ProviderKey, 'buildNumber' | 'library'>>;",
      "export type Library = Assert<Equal<ProviderValue<'library'>, LibraryContext>>;",
      "export type Sync = Assert<Equal<ProviderValue<'buildNumber'>, number>>;",
      '',
      'export const stages = async (): Promise<readonly string[]> => {',
      '  const context = await agent();',
      '  // Augmented: no cast, no runtime guard needed for declared providers.',
      '  const library: LibraryContext = context.providers.library;',
      '  const build: number = context.providers.buildNumber;',
      '  const lifetime: number | undefined = context.providers.processLifetime?.hits;',
      '  // Undeclared keys stay unknown.',
      '  const unknownValue: unknown = context.providers.somethingElse;',
      '  void build; void lifetime; void unknownValue;',
      '  return library.stages;',
      '};',
      '',
    ].join('\n')),
    writeProjectFile(root, 'mismatch.ts', [
      "import { agent } from '@agent-bundle/runtime';",
      'export const wrong = async (): Promise<number> => (await agent()).providers.library;',
      '',
    ].join('\n')),
    // Contexts that do not run src/providers/* — a custom runAgentRequest host
    // or a route-unit fixture — must supply the declared keys, or the handler's
    // typed `providers.library` would dereference undefined at runtime.
    writeProjectFile(root, 'custom-scope.ts', [
      "import { runAgentRequest } from '@agent-bundle/runtime';",
      "import { renderRoute } from 'agent-bundle/test';",
      "import type { LibraryContext } from './src/providers/library.js';",
      '',
      "const library: LibraryContext = { stages: ['discover'], surface: 'tool' };",
      'export const complete = async (): Promise<void> => {',
      "  await runAgentRequest({ invocation: { kind: 'tool' }, providers: { buildNumber: 7, library } }, async () => undefined);",
      "  await renderRoute('tool:curator/status', { context: { providers: { buildNumber: 7, library } } });",
      '};',
      '',
    ].join('\n')),
    writeProjectFile(root, 'missing-providers.ts', [
      "import { runAgentRequest } from '@agent-bundle/runtime';",
      "export const omitted = runAgentRequest({ invocation: { kind: 'tool' } }, async () => undefined);",
      '',
    ].join('\n')),
    writeProjectFile(root, 'missing-fixture.ts', [
      "import { renderRoute } from 'agent-bundle/test';",
      "import type { LibraryContext } from './src/providers/library.js';",
      "const library: LibraryContext = { stages: ['discover'], surface: 'tool' };",
      "export const partial = renderRoute('tool:curator/status', { context: { providers: { library } } });",
      "export const absent = renderRoute('tool:curator/status');",
      '',
    ].join('\n')),
  ]);

  const result = await inspect({ root });
  expect(result.state).toBe('ready');
  const declarations = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(declarations).toContain('readonly "buildNumber": ProviderValueOf<typeof provider0.default>;');
  expect(declarations).toContain('readonly "library": ProviderValueOf<typeof provider1.default>;');
  expect(declarations).toContain("declare module '@agent-bundle/runtime'");

  expect(typecheck(root, 'assertions.ts')).toEqual([]);
  const mismatch = typecheck(root, 'mismatch.ts');
  expect(mismatch).toHaveLength(1);
  expect(mismatch[0]).toContain("Type 'LibraryContext' is not assignable to type 'number'");

  expect(typecheck(root, 'custom-scope.ts')).toEqual([]);
  const missingProviders = typecheck(root, 'missing-providers.ts');
  expect(missingProviders).toHaveLength(1);
  expect(missingProviders[0]).toContain("Property 'providers' is missing");
  const missingFixture = typecheck(root, 'missing-fixture.ts');
  expect(missingFixture).toHaveLength(2);
  expect(missingFixture[0]).toContain("Property '\"buildNumber\"' is missing");
  expect(missingFixture[1]).toContain('Expected 2 arguments, but got 1.');
});
