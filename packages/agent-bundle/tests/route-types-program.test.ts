import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { inspect, validate } from '../src/api.ts';
import { routeTypesProgramDiagnostics } from '../src/routes/typegen-program.ts';
import { routeTypesRelativePath } from '../src/routes/typegen.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const routeModule = [
  "import { z } from 'zod';",
  'export const inputSchema = z.object({ service: z.string() });',
  'export const resultSchema = z.object({ status: z.string() });',
  'export default async () => undefined;',
  '',
].join('\n');

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
      message: expect.stringContaining('tsconfig.json does not include the generated .agent-bundle/routes.d.ts'),
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
