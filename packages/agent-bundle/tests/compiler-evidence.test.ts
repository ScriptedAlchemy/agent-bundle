import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Rspack } from '@rsbuild/core';
import { afterEach, describe, expect, it } from '@rstest/core';

import { portableAdapter } from '../src/adapters/portable.ts';
import { TargetRegistry } from '../src/adapters/registry.ts';
import { validate } from '../src/api.ts';
import type { BuildOptions } from '../src/build/build.ts';
import { DiagnosticError, type Diagnostic } from '../src/core/diagnostics.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { build } from './support/build.ts';

type RspackMutator = (config: Rspack.Configuration) => void;

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

const modelFor = (root: string, scripts: Readonly<Record<string, string>>): NormalizedPlugin => ({
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
  scripts: Object.entries(scripts).map(([name, source]) => ({
    id: `script:${name}`,
    mode: 'bundle',
    name,
    provenance: { kind: 'explicit', sourcePath: source },
    source,
    targets: ['portable'],
  })),
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
  userRequest = request,
): Diagnostic => ({
  code: 'AB6005',
  generatedPath: asset,
  message: `Compiled module ${JSON.stringify(asset)} keeps ${JSON.stringify(request)} external (${externalType})`
    + `${userRequest === request ? '' : `, imported as ${JSON.stringify(userRequest)},`} from ${issuers.join(', ')}; `
    + (request.startsWith('.')
      ? 'it names no module emitted by this artifact.'
      : 'a generated executable bundles everything but Node built-ins.'),
  recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
  severity: 'error',
});

const withCode = (reported: readonly Diagnostic[], code: string): readonly Diagnostic[] =>
  reported.filter((diagnostic) => diagnostic.code === code);

const externalsMutator = (...externals: readonly Rspack.ExternalItem[]): RspackMutator => (config) => {
  const current = config.externals;
  config.externals = [...(current === undefined ? [] : Array.isArray(current) ? current : [current]), ...externals];
};

const buildFixture = async (
  root: string,
  scripts: Readonly<Record<string, string>>,
  tools: BuildOptions['tools'],
): Promise<unknown> => build({
  model: modelFor(root, scripts),
  outputRoot: join(root, 'dist'),
  projectRoot: root,
  registry: new TargetRegistry().register(portableAdapter, { default: true }),
  tools,
}).then(() => undefined, (error: unknown) => error);

const ab6005 = (failure: unknown): readonly Diagnostic[] => {
  expect(failure).toBeInstanceOf(DiagnosticError);
  return withCode((failure as DiagnosticError).diagnostics, 'AB6005');
};

const padFixture = async (): Promise<{ readonly root: string; readonly scriptPath: string }> => {
  const root = await fixtureRoot({
    'agent-bundle.config.ts': 'export default {};\n',
    'package.json': '{"name":"compiler-evidence-fixture","type":"module","private":true}\n',
    'src/scripts/pad.ts': padScript,
  });
  await stubLeftPad(root);
  return { root, scriptPath: join(root, 'src', 'scripts', 'pad.ts') };
};

describe('compiler evidence on host-pack builds', () => {
  it('fails a host-pack build with compile-time AB6005 when a tools.rspack mutator keeps a dependency external', async () => {
    const { root, scriptPath } = await padFixture();
    const failure = await buildFixture(root, { pad: scriptPath }, { rspack: externalsMutator('left-pad') });

    expect(ab6005(failure)).toEqual([
      compileTimeExternal('scripts/pad.mjs', 'left-pad', 'module', ['src/scripts/pad.ts']),
    ]);
  }, 120_000);

  it('fails the node-commonjs shim form the same way in a host pack', async () => {
    const { root, scriptPath } = await padFixture();
    const failure = await buildFixture(root, { pad: scriptPath }, {
      rspack: (config) => {
        config.externalsType = 'node-commonjs';
        externalsMutator('left-pad')(config);
      },
    });

    expect(ab6005(failure)).toEqual([
      compileTimeExternal('scripts/pad.mjs', 'left-pad', 'node-commonjs', ['src/scripts/pad.ts']),
    ]);
  }, 120_000);

  it('judges the run-time target of an object-map external, not the authored specifier', async () => {
    const { root, scriptPath } = await padFixture();
    const failure = await buildFixture(root, { pad: scriptPath }, { rspack: externalsMutator({ 'left-pad': 'lp' }) });

    expect(ab6005(failure)).toEqual([
      compileTimeExternal('scripts/pad.mjs', 'lp', 'module', ['src/scripts/pad.ts'], 'left-pad'),
    ]);
  }, 120_000);

  it('inlines a package dependency even when the hatch asks for autoExternal', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': 'export default {};\n',
      'package.json': '{"name":"compiler-evidence-fixture","type":"module","private":true,"dependencies":{"left-pad":"1.3.0"}}\n',
      'src/scripts/pad.ts': padScript,
    });
    await stubLeftPad(root);
    const scriptPath = join(root, 'src', 'scripts', 'pad.ts');

    await expect(buildFixture(root, { pad: scriptPath }, { rsbuild: { output: { autoExternal: true } } }))
      .resolves.toBeUndefined();
    const emitted = await readFile(join(root, 'dist', 'scripts', 'pad.mjs'), 'utf8');
    expect(emitted).not.toMatch(/from\s+["']left-pad["']/u);
    expect(emitted).toContain('String(');
  }, 120_000);

  describe('artifact-relative externals', () => {
    const helperScript = "export const main = async (): Promise<number> => 0;\nexport const helper = 'helper';\n";
    const padViaHelper = [
      "import { helper } from './helper.ts';",
      '',
      'export const main = async (): Promise<number> => {',
      '  process.stdout.write(`${helper}\\n`);',
      '  return 0;',
      '};',
      '',
    ].join('\n');

    const siblingFixture = async (): Promise<{ readonly root: string; readonly scripts: Readonly<Record<string, string>> }> => {
      const root = await fixtureRoot({
        'agent-bundle.config.ts': 'export default {};\n',
        'package.json': '{"name":"compiler-evidence-fixture","type":"module","private":true}\n',
        'src/scripts/helper.ts': helperScript,
        'src/scripts/pad.ts': padViaHelper,
      });
      return {
        root,
        scripts: { helper: join(root, 'src', 'scripts', 'helper.ts'), pad: join(root, 'src', 'scripts', 'pad.ts') },
      };
    };

    const redirectHelper = (target: string): Rspack.ExternalItem => (data, callback) => {
      if (data.request === './helper.ts') callback(undefined, `module ${target}`);
      else callback();
    };

    it('passes when a function-form external names an emitted sibling', async () => {
      const { root, scripts } = await siblingFixture();
      await expect(buildFixture(root, scripts, { rspack: externalsMutator(redirectHelper('./helper.mjs')) }))
        .resolves.toBeUndefined();
      await expect(readFile(join(root, 'dist', 'scripts', 'pad.mjs'), 'utf8')).resolves.toContain('./helper.mjs');
    }, 120_000);

    it('fails with AB6005 when the relative target is not emitted or escapes the artifact', async () => {
      for (const target of ['./missing.mjs', '../outside.mjs']) {
        const { root, scripts } = await siblingFixture();
        const failure = await buildFixture(root, scripts, { rspack: externalsMutator(redirectHelper(target)) });
        expect(ab6005(failure)).toEqual([
          compileTimeExternal('scripts/pad.mjs', target, 'module', ['src/scripts/pad.ts'], './helper.ts'),
        ]);
      }
    }, 240_000);
  });

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
