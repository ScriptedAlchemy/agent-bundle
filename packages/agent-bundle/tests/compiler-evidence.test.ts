import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { portableAdapter } from '../src/adapters/portable.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import { validate } from '../src/api.ts';
import { DiagnosticError, type Diagnostic } from '../src/core/diagnostics.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { build } from './support/build.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixtureRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-compiler-evidence-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const stubLeftPad = async (root: string): Promise<void> => {
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(
    join(root, 'node_modules', 'left-pad', 'package.json'),
    '{"name":"left-pad","version":"1.3.0","main":"index.js"}\n',
  );
  await writeFile(
    join(root, 'node_modules', 'left-pad', 'index.js'),
    'module.exports = (value) => String(value);\n',
  );
};

const padScript = [
  "import leftPad from 'left-pad';",
  '',
  'export const main = async (): Promise<number> => {',
  "  process.stdout.write(`${leftPad('x', 4)}\\n`);",
  '  return 0;',
  '};',
  '',
].join('\n');

const modelFor = (root: string, scriptPath: string): NormalizedPlugin => ({
  assets: [],
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    id: 'plugin:compiler-evidence-fixture',
    name: 'compiler-evidence-fixture',
    provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [{
    id: 'script:pad',
    mode: 'bundle',
    name: 'pad',
    provenance: { kind: 'explicit', sourcePath: scriptPath },
    source: scriptPath,
    targets: ['portable'],
  }],
  skills: [],
  targets: [{
    id: 'target:portable',
    name: 'portable',
    provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
  }],
});

const compileTimeExternal = (
  asset: string,
  request: string,
  externalType: string,
  issuers: readonly string[],
): Diagnostic => ({
  code: 'AB6005',
  generatedPath: asset,
  message: `Compiled module ${JSON.stringify(asset)} keeps ${JSON.stringify(request)} external (${externalType}) from ${issuers.join(', ')}; a generated executable bundles everything but Node built-ins.`,
  recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
  severity: 'error',
});

const withCode = (reported: readonly Diagnostic[], code: string): readonly Diagnostic[] =>
  reported.filter((diagnostic) => diagnostic.code === code);

describe('compiler evidence on host-pack builds', () => {
  it('fails a host-pack build with compile-time AB6005 when a tools.rspack mutator keeps a dependency external', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': 'export default {};\n',
      'package.json': '{"name":"compiler-evidence-fixture","type":"module","private":true}\n',
      'src/scripts/pad.ts': padScript,
    });
    await stubLeftPad(root);
    const scriptPath = join(root, 'src', 'scripts', 'pad.ts');
    const failure = await build({
      model: modelFor(root, scriptPath),
      outputRoot: join(root, 'dist'),
      projectRoot: root,
      registry: new TargetRegistry().register(portableAdapter, { default: true }),
      tools: {
        rspack: (config) => {
          const current = config.externals;
          config.externals = [
            ...(current === undefined ? [] : Array.isArray(current) ? current : [current]),
            'left-pad',
          ];
        },
      },
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DiagnosticError);
    expect(withCode((failure as DiagnosticError).diagnostics, 'AB6005')).toEqual([
      compileTimeExternal('scripts/pad.mjs', 'left-pad', 'module', ['src/scripts/pad.ts']),
    ]);
  }, 120_000);

  it('rejects static tools.rsbuild.output.externals with AB4725 before a host-pack compile', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': [
        'export default {',
        "  plugin: { name: 'compiler-evidence-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  tools: { rsbuild: { output: { externals: ['left-pad'] } } },",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"name":"compiler-evidence-fixture","type":"module","private":true}\n',
      'src/scripts/pad.ts': padScript,
    });
    const reported = withCode((await validate({ root })).diagnostics, 'AB4725');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ code: 'AB4725', severity: 'error' });
    expect(reported[0]?.message).toContain('left-pad');
  }, 30_000);
});
