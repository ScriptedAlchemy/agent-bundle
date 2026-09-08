import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { inspect, validate } from '../src/api.ts';
import { routeTypesProgramDiagnostics } from '../src/routes/typegen-program.ts';
import { routeTypesRelativePath } from '../src/routes/typegen.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// A route module consumes the registration through `@agent-bundle/runtime` (provider values).
const routeModule = [
  "import { agent } from '@agent-bundle/runtime';",
  "import { z } from 'zod';",
  'export const inputSchema = z.object({ service: z.string() });',
  'export const resultSchema = z.object({ status: z.string() });',
  'export default async () => { await agent(); return undefined; };',
  '',
].join('\n');

// An App view consumes it through `agent-bundle/app`; it lives in the browser program.
const appModule = [
  "import { createAppClient } from 'agent-bundle/app';",
  "export const config = { resourceUri: 'ui://routes-fixture/panel.html', template: './panel.html' };",
  "void createAppClient().call('tool:status/report', { service: 'compiler' });",
  '',
].join('\n');

// A build-only script imports none of the augmented modules: not a consumer.
const scriptModule = "export const main = async (): Promise<void> => { console.log('build'); };\n";

const tsconfig = (include: readonly string[], extra: Readonly<Record<string, unknown>> = {}): string =>
  `${JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true }, include, ...extra }, null, 2)}\n`;

const createProject = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-route-types-program-')));
  roots.push(root);
  for (const [path, contents] of Object.entries({
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    ...files,
  })) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
};

const codesOf = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

describe('AB4834 generated route declarations outside the TypeScript program', () => {
  it('warns from validate when tsconfig.json leaves the published declaration out of the program', async () => {
    const root = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.json': tsconfig(['agent-bundle.config.ts', 'src/**/*.ts', 'tests/**/*.ts']),
    });

    const result = await validate({ root });
    // `validate` published the declaration first; the warning is about that file.
    expect(existsSync(join(root, routeTypesRelativePath))).toBe(true);
    const warnings = result.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4834');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining('tsconfig.json imports agent-bundle/app, agent-bundle/test, agent-bundle/eval, or @agent-bundle/runtime but does not include the generated .agent-bundle/routes.d.ts'),
      recovery: expect.stringContaining('Add ".agent-bundle/routes.d.ts" to the "include" array of tsconfig.json'),
      severity: 'warning',
      sourcePath: join(root, 'tsconfig.json'),
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('is silent when the declaration is included explicitly, by glob, or through files', async () => {
    for (const config of [
      tsconfig(['agent-bundle.config.ts', '.agent-bundle/routes.d.ts', 'src/**/*.ts']),
      // A glob that names the dot-directory reaches it; a bare `**/*` never does.
      tsconfig(['src/**/*.ts', '.agent-bundle/**/*']),
      tsconfig(['src/**/*.ts'], { files: ['.agent-bundle/routes.d.ts'] }),
    ]) {
      const root = await createProject({
        'src/mcp/status/tools/report.ts': routeModule,
        'tsconfig.json': config,
      });
      const result = await validate({ root });
      expect(codesOf(result.diagnostics), config).not.toContain('AB4834');
    }
  });

  it('follows extends and project references before judging the program', async () => {
    const extending = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.base.json': tsconfig(['agent-bundle.config.ts', '.agent-bundle/routes.d.ts', 'src/**/*.ts']),
      'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n',
    });
    expect(codesOf((await validate({ root: extending })).diagnostics)).not.toContain('AB4834');

    const solution = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.json': `${JSON.stringify({ files: [], references: [{ path: './tsconfig.src.json' }] }, null, 2)}\n`,
      'tsconfig.src.json': tsconfig(['.agent-bundle/routes.d.ts', 'src/**/*.ts'], { compilerOptions: { composite: true, module: 'NodeNext' } }),
    });
    expect(codesOf((await validate({ root: solution })).diagnostics)).not.toContain('AB4834');

    const wildcardOnly = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.json': `${JSON.stringify({ files: [], references: [{ path: './tsconfig.src.json' }] }, null, 2)}\n`,
      // `**/*` never descends into dot-directories, so this program still omits the declaration.
      'tsconfig.src.json': tsconfig(['**/*'], { compilerOptions: { composite: true, module: 'NodeNext' } }),
    });
    expect(codesOf((await validate({ root: wildcardOnly })).diagnostics)).toContain('AB4834');
  });

  it('judges every consuming program of a solution, so the server project cannot hide the browser project', async () => {
    const solution = {
      'src/mcp/status/apps/panel.html': '<!doctype html><html><body></body></html>\n',
      'src/mcp/status/apps/panel.ts': appModule,
      'src/mcp/status/tools/report.ts': routeModule,
      'src/scripts/build.ts': scriptModule,
      // Nested: the root references a solution file that references the three projects.
      'tsconfig.json': `${JSON.stringify({ files: [], references: [{ path: './tsconfig.solution.json' }] }, null, 2)}\n`,
      'tsconfig.solution.json': `${JSON.stringify({ files: [], references: [{ path: './tsconfig.node.json' }, { path: './config/tsconfig.app.json' }, { path: './tsconfig.scripts.json' }] }, null, 2)}\n`,
      'tsconfig.node.json': tsconfig(['.agent-bundle/routes.d.ts', 'src/mcp/**/tools/*.ts'], { compilerOptions: { composite: true, module: 'NodeNext' } }),
      'tsconfig.scripts.json': tsconfig(['src/scripts/*.ts'], { compilerOptions: { composite: true, module: 'NodeNext' } }),
    };
    const browserOmits = await createProject({
      ...solution,
      // Excluding the declaration is as good as omitting it.
      'config/tsconfig.app.json': tsconfig(['../src/mcp/**/apps/*.ts', '../.agent-bundle/**/*'], { compilerOptions: { composite: true, lib: ['DOM', 'ES2022'], module: 'NodeNext' }, exclude: ['../.agent-bundle/**/*'] }),
    });
    const warnings = (await validate({ root: browserOmits })).diagnostics.filter((diagnostic) => diagnostic.code === 'AB4834');
    // One warning, on the browser project; the node project includes the file and the scripts project imports nothing that consumes it.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining('config/tsconfig.app.json imports agent-bundle/app'),
      recovery: expect.stringContaining('Add "../.agent-bundle/routes.d.ts" to the "include" array of config/tsconfig.app.json'),
      sourcePath: join(browserOmits, 'config', 'tsconfig.app.json'),
    });

    const browserIncludes = await createProject({
      ...solution,
      'config/tsconfig.app.json': tsconfig(['../src/mcp/**/apps/*.ts', '../.agent-bundle/routes.d.ts'], { compilerOptions: { composite: true, lib: ['DOM', 'ES2022'], module: 'NodeNext' } }),
    });
    expect(codesOf((await validate({ root: browserIncludes })).diagnostics)).not.toContain('AB4834');

    // A program that imports none of the augmented modules is never asked to include the file.
    const buildOnly = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'src/scripts/build.ts': scriptModule,
      'tsconfig.json': tsconfig(['src/scripts/*.ts']),
    });
    expect(codesOf((await validate({ root: buildOnly })).diagnostics)).not.toContain('AB4834');
  });

  it('reads imports with the scanner, not by text: comments and strings are not consumers, import type in a .d.ts is', async () => {
    const commentOnly = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      // The program's own files mention the entries only in prose and a string literal.
      'src/scripts/build.ts': [
        "// Consumers import '@agent-bundle/runtime' or 'agent-bundle/test'; this script does neither.",
        "export const hint = \"import { agent } from '@agent-bundle/runtime'\";",
        '',
      ].join('\n'),
      'tsconfig.json': tsconfig(['src/scripts/*.ts']),
    });
    expect(codesOf((await validate({ root: commentOnly })).diagnostics)).not.toContain('AB4834');

    const subpath = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'src/scripts/build.ts': "import type { AgentRouteModule } from 'agent-bundle/routes';\nexport type Module = AgentRouteModule;\n",
      'tsconfig.json': tsconfig(['src/scripts/*.ts']),
    });
    expect(codesOf((await validate({ root: subpath })).diagnostics)).not.toContain('AB4834');

    const declaration = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'src/scripts/types.d.ts': "import type { RegisteredRouteId } from '@agent-bundle/runtime';\nexport type Id = RegisteredRouteId;\n",
      'tsconfig.json': tsconfig(['src/scripts/*.ts']),
    });
    expect(codesOf((await validate({ root: declaration })).diagnostics)).toContain('AB4834');
  });

  it('judges the project by its own files: a workspace-linked package that imports the runtime is not the consumer', async () => {
    // A `workspace:*` link resolves outside the project root, where the host
    // cannot decline it by path; its declaration imports the runtime, as the
    // framework's own `agent-bundle/routes` declaration may.
    const linked = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'src/scripts/build.ts': "import type { AgentRouteModule } from 'agent-bundle/routes';\nexport type Module = AgentRouteModule;\n",
      'tsconfig.json': tsconfig(['src/scripts/*.ts']),
    });
    const sibling = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-route-types-linked-')));
    roots.push(sibling);
    await mkdir(join(sibling, 'agent-bundle'), { recursive: true });
    await writeFile(join(sibling, 'agent-bundle/package.json'), '{"name":"agent-bundle","type":"module","exports":{"./routes":{"types":"./routes.d.ts"}}}\n');
    await writeFile(join(sibling, 'agent-bundle/routes.d.ts'), "import type { RegisteredRouteId } from '@agent-bundle/runtime';\nexport interface AgentRouteModule { readonly id: RegisteredRouteId }\n");
    await mkdir(join(linked, 'node_modules'), { recursive: true });
    await symlink(join(sibling, 'agent-bundle'), join(linked, 'node_modules/agent-bundle'), 'dir');
    expect(codesOf((await validate({ root: linked })).diagnostics)).not.toContain('AB4834');
  });

  it('follows imports from a narrow root, as tsc does: the consumer an entry point imports is in the program', async () => {
    const narrow = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      // The root file imports nothing augmented itself; the module it imports does.
      'src/index.ts': "export { status } from './status.js';\n",
      'src/status.ts': "import { invokeMcpTool } from 'agent-bundle/test';\nexport const status = () => invokeMcpTool('report', { input: {} });\n",
      'tsconfig.json': tsconfig([], { files: ['src/index.ts'] }),
    });
    const diagnostics = (await validate({ root: narrow })).diagnostics.filter((diagnostic) => diagnostic.code === 'AB4834');
    expect(diagnostics.map((diagnostic) => diagnostic.sourcePath)).toEqual([join(narrow, 'tsconfig.json')]);

    // The declaration reached through an import counts as compiled, like any other module.
    const referenced = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'src/index.ts': "/// <reference path=\"../.agent-bundle/routes.d.ts\" />\nimport { invokeMcpTool } from 'agent-bundle/test';\nexport const status = () => invokeMcpTool('report', { input: {} });\n",
      'tsconfig.json': tsconfig([], { files: ['src/index.ts'] }),
    });
    expect(codesOf((await validate({ root: referenced })).diagnostics)).not.toContain('AB4834');
  });

  it('tailors the recovery to a config without its own include array, whose patterns an include would replace', async () => {
    const defaults = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      // No `include`: the program is the `**/*` default, which never descends into dot-directories.
      'tsconfig.json': `${JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true } }, null, 2)}\n`,
    });
    const [warning] = (await validate({ root: defaults })).diagnostics.filter((diagnostic) => diagnostic.code === 'AB4834');
    expect(warning?.recovery).toContain('Declare an "include" array in tsconfig.json that lists ".agent-bundle/routes.d.ts" beside the patterns it compiles today (an "include" array replaces the inherited or default "**/*" patterns)');

    // The inherited patterns live in another directory: the path is spelled
    // for the config being edited, never for the one it extends.
    const inherited = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'config/tsconfig.base.json': tsconfig(['../agent-bundle.config.ts', '../src/**/*.ts']),
      'tsconfig.json': tsconfig([], { compilerOptions: { composite: true, module: 'NodeNext' }, files: [], references: [{ path: './config/tsconfig.app.json' }] }),
      'config/tsconfig.app.json': '{ "extends": "./tsconfig.base.json", "compilerOptions": { "composite": true } }\n',
    });
    const [inheritedWarning] = (await validate({ root: inherited })).diagnostics.filter((diagnostic) => diagnostic.code === 'AB4834');
    expect(inheritedWarning?.sourcePath).toBe(join(inherited, 'config/tsconfig.app.json'));
    expect(inheritedWarning?.recovery).toContain('Declare an "include" array in config/tsconfig.app.json that lists "../.agent-bundle/routes.d.ts" beside the patterns it compiles today');
  });

  it('matches the declaration path the way the host file system does', async () => {
    const root = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      // Case-mismatched: names the file on a case-insensitive host, nothing on a case-sensitive one.
      'tsconfig.json': tsconfig(['.agent-bundle/Routes.d.ts', 'src/**/*.ts']),
    });
    const codes = codesOf((await validate({ root })).diagnostics);
    if (ts.sys.useCaseSensitiveFileNames) expect(codes).toContain('AB4834');
    else expect(codes).not.toContain('AB4834');
  });

  it('has nothing to report without a tsconfig, without routes, or with an unparsable tsconfig', async () => {
    const noTsconfig = await createProject({ 'src/mcp/status/tools/report.ts': routeModule });
    expect(codesOf((await validate({ root: noTsconfig })).diagnostics)).not.toContain('AB4834');

    const routeFree = await createProject({
      'src/skills/notes/SKILL.md': '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n\nBody.\n',
      'tsconfig.json': tsconfig(['agent-bundle.config.ts']),
    });
    expect(codesOf((await validate({ root: routeFree })).diagnostics)).not.toContain('AB4834');
    expect(existsSync(join(routeFree, routeTypesRelativePath))).toBe(false);

    const broken = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.json': '{ "include": [\n',
    });
    expect(codesOf((await validate({ root: broken })).diagnostics)).not.toContain('AB4834');
    expect(routeTypesProgramDiagnostics(broken)).toEqual([]);
  });

  it('is a validate-only judgment: inspect and build flows do not surface it', async () => {
    const root = await createProject({
      'src/mcp/status/tools/report.ts': routeModule,
      'tsconfig.json': tsconfig(['src/**/*.ts']),
    });
    const inspected = await inspect({ root });
    expect(codesOf(inspected.diagnostics)).not.toContain('AB4834');
    // The declaration is on disk after inspect too, so the check itself would fire.
    expect(codesOf(routeTypesProgramDiagnostics(root))).toEqual(['AB4834']);
  });
});
