import type { Rspack } from '@rsbuild/core';
import { createRslib } from '@rslib/core';
import { describe, expect, it } from '@rstest/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CompilationEvidence } from '../src/build/compile-result.ts';
import { ArtifactDependencyAuditPlugin } from '../src/build/dependency-audit-plugin.ts';
import { composeEntryLibConfig, entryLibId, type RslibEntry } from '../src/build/rslib.ts';
import type { AgentBundleMeta } from '../src/meta.ts';

const testMeta: AgentBundleMeta = Object.freeze({
  name: 'dependency-audit-probe-plugin',
  packageName: 'dependency-audit-probe-package',
  packageVersion: '1.0.0',
  version: '1.0.0',
});

type RspackMutator = (config: Rspack.Configuration) => void;

const externalDeclarations = (externals: Rspack.Configuration['externals']): readonly Rspack.ExternalItem[] => {
  if (externals === undefined) return [];
  return Array.isArray(externals) ? externals : [externals];
};

const probeProject = async (
  entrySource: readonly string[],
  packages: Readonly<Record<string, string>> = {},
): Promise<{ readonly entry: RslibEntry; readonly root: string; readonly source: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-dependency-audit-'));
  const source = join(root, 'src', 'entry.ts');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(source, [...entrySource, ''].join('\n'));
  for (const [name, body] of Object.entries(packages)) {
    const packageRoot = join(root, 'node_modules', name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ main: 'index.js', name, version: '1.0.0' }));
    await writeFile(join(packageRoot, 'index.js'), body);
  }
  return {
    entry: { name: 'probe', outputRelativePath: 'scripts/probe.mjs', source, sourceInputs: [source] },
    root,
    source,
  };
};

const buildRecording = async (
  root: string,
  entries: readonly RslibEntry[],
  mutate: RspackMutator = () => undefined,
): Promise<readonly CompilationEvidence[]> => {
  const records: CompilationEvidence[] = [];
  const rslib = await createRslib({
    cwd: root,
    config: {
      logLevel: 'silent',
      lib: entries.map((entry) => composeEntryLibConfig(entry, {
        cwd: root,
        meta: testMeta,
        outputRoot: join(root, 'dist'),
        tools: {
          rspack: (config) => {
            mutate(config);
            config.plugins = [...(config.plugins ?? []), new ArtifactDependencyAuditPlugin((evidence) => records.push(evidence))];
          },
        },
      })),
    },
  });
  const result = await rslib.build();
  await result.close();
  return records;
};

const withExternals = (...externals: readonly Rspack.ExternalItem[]): RspackMutator => (config) => {
  config.externals = [...externalDeclarations(config.externals), ...externals];
};

const leftPadStub = { 'left-pad': 'export default (value, width) => String(value).padStart(width);\n' };
const leftPadEntry = ["import leftPad from 'left-pad';", "console.log(leftPad('7', 3));"];

const expectLeftPadExternal = (record: CompilationEvidence | undefined, source: string, externalType: string): void => {
  expect(record?.externals).toEqual([{ externalType, issuers: [source], request: 'left-pad' }]);
  expect(record?.modules.map((module) => module.resource)).toEqual([source]);
};

describe('ArtifactDependencyAuditPlugin', () => {
  it('records Node builtins as module externals and inlined dependencies as modules with their resource', async () => {
    const { entry, root, source } = await probeProject([
      "import 'node:fs';",
      "import { join } from 'node:path';",
      "import { greet } from 'probe-dep';",
      "console.log(join('a', 'b'), greet());",
    ], { 'probe-dep': "export const greet = () => 'hello';\n" });
    try {
      const [record, ...rest] = await buildRecording(root, [entry]);
      expect(rest).toEqual([]);
      expect(record?.compiler).toBe(entryLibId(entry));
      expect(record?.externals).toEqual([
        { externalType: 'module', issuers: [source], request: 'node:fs' },
        { externalType: 'module', issuers: [source], request: 'node:path' },
      ]);
      expect(record?.modules.map((module) => module.resource).sort()).toEqual([
        join(root, 'node_modules', 'probe-dep', 'index.js'),
        source,
      ]);
      expect(record?.modules.every((module) =>
        module.resource !== undefined && module.identifier.endsWith(module.resource))).toBe(true);
      expect(Object.isFrozen(record?.externals)).toBe(true);
      expect(Object.isFrozen(record?.modules)).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records an array-form external with the default module type', async () => {
    const { entry, root, source } = await probeProject(leftPadEntry, leftPadStub);
    try {
      const [record] = await buildRecording(root, [entry], withExternals('left-pad'));
      expectLeftPadExternal(record, source, 'module');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records the configured externalsType', async () => {
    const { entry, root, source } = await probeProject(leftPadEntry, leftPadStub);
    try {
      const [record] = await buildRecording(root, [entry], (config) => {
        withExternals('left-pad')(config);
        config.externalsType = 'node-commonjs';
      });
      expectLeftPadExternal(record, source, 'node-commonjs');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records a function-form external identically to the array form', async () => {
    const { entry, root, source } = await probeProject(leftPadEntry, leftPadStub);
    try {
      const [record] = await buildRecording(root, [entry], withExternals((data, callback) => {
        if (data.request === 'left-pad') callback(undefined, 'module left-pad');
        else callback();
      }));
      expectLeftPadExternal(record, source, 'module');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records an artifact-relative external kept by an object map', async () => {
    const { entry, root, source } = await probeProject(["import './sibling.js';", "console.log('probe');"]);
    try {
      const [record] = await buildRecording(root, [entry], withExternals({ './sibling.js': 'module ./sibling.js' }));
      expect(record?.externals).toEqual([{ externalType: 'module', issuers: [source], request: './sibling.js' }]);
      expect(record?.modules.map((module) => module.resource)).toEqual([source]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records a builtin required by a bundled CommonJS dependency as a node-commonjs external issued by that dependency', async () => {
    const { entry, root, source } = await probeProject(
      ["import size from 'probe-cjs';", 'console.log(size(process.argv[2]!));'],
      { 'probe-cjs': "module.exports = (path) => require('fs').statSync(path).size;\n" },
    );
    try {
      const [record] = await buildRecording(root, [entry]);
      expect(record?.externals).toEqual([
        { externalType: 'node-commonjs', issuers: [join(root, 'node_modules', 'probe-cjs', 'index.js')], request: 'fs' },
      ]);
      expect(record?.modules.map((module) => module.resource).sort()).toEqual([
        join(root, 'node_modules', 'probe-cjs', 'index.js'),
        source,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  // Rslib's ESM format layer sets `module.parser.javascript.importDynamic:
  // false` (and `requireDynamic: false`), so an expression request is never
  // parsed as a dependency: Rspack emits neither a context module nor a
  // `Critical dependency` warning and the call survives verbatim. The
  // compiler's account of such a program is therefore silent on it.
  it('has nothing to record for an expression import, which the profile leaves verbatim', async () => {
    const { entry, root, source } = await probeProject([
      'export const load = async (): Promise<unknown> => import(process.argv[2]!);',
      'console.log(await load());',
    ]);
    try {
      const [record] = await buildRecording(root, [entry]);
      expect(record?.externals).toEqual([]);
      expect(record?.modules.map((module) => module.resource)).toEqual([source]);
      await expect(readFile(join(root, 'dist', 'scripts', 'probe.mjs'), 'utf8')).resolves
        .toContain('import(process.argv[2])');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  it('records once per compilation, each under its own compiler name', async () => {
    const { entry, root } = await probeProject(["import 'node:fs';", "console.log('probe');"]);
    const sibling: RslibEntry = { ...entry, name: 'sibling', outputRelativePath: 'scripts/sibling.mjs' };
    try {
      const records = await buildRecording(root, [entry, sibling]);
      expect(records.map((record) => record.compiler).sort()).toEqual([entryLibId(entry), entryLibId(sibling)].sort());
      for (const record of records) {
        expect(record.externals.map((external) => external.request)).toEqual(['node:fs']);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);
});
