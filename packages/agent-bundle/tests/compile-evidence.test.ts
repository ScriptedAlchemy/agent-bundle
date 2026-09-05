import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  compileEvidenceDiagnostics,
  createCompileEvidenceRecord,
  parseCompileEvidenceRecord,
  serializeCompileEvidenceRecord,
  type CompileEvidenceExternal,
  type CompileEvidenceRecord,
} from '../src/build/compile-evidence.ts';
import type { CompileResult } from '../src/build/compile-result.ts';
import { sha256Hex } from '../src/core/digest.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createFixture = async (): Promise<{ readonly record: CompileEvidenceRecord; readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-compile-evidence-'));
  roots.push(root);
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin', 'main.js'), 'export {};\n');
  await writeFile(join(root, 'bin', 'worker.mjs'), 'export {};\n');
  const result: CompileResult = {
    assets: [
      { path: 'bin/worker.mjs', sourceInputs: ['/project/worker.ts'] },
      { path: 'bin/main.js', sourceInputs: ['/project/main.ts'] },
    ],
    diagnostics: [],
    externals: [
      {
        asset: 'bin/main.js',
        externalType: 'node-commonjs',
        issuers: ['src/main.ts'],
        kind: 'builtin',
        request: 'node:path',
        userRequest: 'node:path',
      },
      {
        asset: 'bin/main.js',
        externalType: 'module',
        issuers: ['src/main.ts'],
        kind: 'artifact-relative',
        request: './worker.mjs',
        userRequest: './worker.mjs',
      },
    ],
    modules: [{
      asset: 'bin/main.js',
      identifier: '/project/node_modules/example-package/index.js',
      kind: 'dependency',
      package: 'example-package',
      resource: '/project/node_modules/example-package/index.js',
    }],
  };
  return {
    record: await createCompileEvidenceRecord({
      pathPrefix: 'dist',
      results: [result],
      rewritable: false,
      root,
      rspackVersion: '2.2.2',
    }),
    root,
  };
};

describe('compile evidence records', () => {
  it('creates deterministic evidence and round-trips its canonical serialization', async () => {
    const { record } = await createFixture();
    expect(record.assets.map((asset) => asset.path)).toEqual([
      'dist/bin/main.js',
      'dist/bin/worker.mjs',
    ]);
    expect(record.assets[0]).toMatchObject({
      packages: ['example-package'],
      sha256: sha256Hex('export {};\n'),
    });
    expect(record.assets[0]!.externals).toContainEqual(expect.objectContaining({
      kind: 'artifact-relative',
      target: 'dist/bin/worker.mjs',
    }));
    expect(parseCompileEvidenceRecord(serializeCompileEvidenceRecord(record))).toEqual(record);
  });

  it.each([
    ['invalid JSON', '{'],
    ['an unexpected key', '{"assets":[],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"},"extra":true}'],
    ['unsorted assets', '{"assets":[{"externals":[],"packages":[],"path":"z.js","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"externals":[],"packages":[],"path":"a.js","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"}}'],
    ['a bad sha256', '{"assets":[{"externals":[],"packages":[],"path":"a.js","sha256":"bad"}],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"}}'],
    ['an unsafe path', '{"assets":[{"externals":[],"packages":[],"path":"../a.js","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"}}'],
    ['a builtin target', '{"assets":[{"externals":[{"externalType":"module","issuers":[],"kind":"builtin","request":"node:path","target":"a.js","userRequest":"node:path"}],"packages":[],"path":"a.js","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"}}'],
    ['an artifact-relative external without a target', '{"assets":[{"externals":[{"externalType":"module","issuers":[],"kind":"artifact-relative","request":"./b.js","userRequest":"./b.js"}],"packages":[],"path":"a.js","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"coverage":{"rewritable":false,"unobserved":[]},"policy":{"name":"closed-world-externals","revision":1},"producer":{"name":"agent-bundle","rspack":"2","version":"1"}}'],
  ])('rejects %s', (_case, bytes) => {
    expect(() => parseCompileEvidenceRecord(bytes)).toThrow(TypeError);
  });

  it('reports every file-table and policy mismatch', () => {
    const hash = 'a'.repeat(64);
    const record: CompileEvidenceRecord = {
      assets: [{
        externals: [
          {
            externalType: 'module',
            issuers: [],
            kind: 'builtin',
            request: 'left-pad',
            userRequest: 'left-pad',
          },
          {
            externalType: 'module',
            issuers: [],
            kind: 'artifact-relative',
            request: './missing.js',
            target: 'missing.js',
            userRequest: './missing.js',
          },
        ],
        packages: [],
        path: 'wrong-kind.js',
        sha256: hash,
      }, {
        externals: [],
        packages: [],
        path: 'mismatch.js',
        sha256: hash,
      }],
      coverage: { rewritable: false, unobserved: [] },
      policy: { name: 'closed-world-externals', revision: 2 },
      producer: { name: 'agent-bundle', rspack: '2.2.2', version: '1.0.0' },
    };
    const diagnostics = compileEvidenceDiagnostics(record, new Map([
      ['uncovered.js', { kind: 'bundle', sha256: hash }],
      ['mismatch.js', { kind: 'bundle', sha256: 'b'.repeat(64) }],
      ['wrong-kind.js', { kind: 'copy', sha256: hash }],
    ]));
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('was judged under policy'),
      expect.stringContaining('does not cover compiled file "uncovered.js"'),
      expect.stringContaining('for "mismatch.js" describes different bytes'),
      expect.stringContaining('manifest does not list as a compiled file'),
      expect.stringContaining('"left-pad" as a built-in; it is not one'),
      expect.stringContaining('sibling "./missing.js", which the artifact does not contain'),
    ]));
  });

  it('re-judges every external instead of trusting the recorded kind or target', () => {
    const hash = 'a'.repeat(64);
    const external = (fields: Partial<CompileEvidenceExternal>): CompileEvidenceExternal => ({
      externalType: 'module',
      issuers: [],
      kind: 'artifact-relative',
      request: './lib/b.js',
      target: 'lib/b.js',
      userRequest: './lib/b.js',
      ...fields,
    });
    const files = new Map([
      ['a.js', { kind: 'bundle', sha256: hash }],
      ['lib/b.js', { kind: 'bundle', sha256: hash }],
      ['copied.mjs', { kind: 'copy', sha256: hash }],
    ]);
    const judge = (externals: readonly CompileEvidenceExternal[]): readonly string[] =>
      compileEvidenceDiagnostics({
        assets: [
          { externals, packages: [], path: 'a.js', sha256: hash },
          { externals: [], packages: [], path: 'lib/b.js', sha256: hash },
        ],
        coverage: { rewritable: false, unobserved: [] },
        policy: { name: 'closed-world-externals', revision: 1 },
        producer: { name: 'agent-bundle', rspack: '2.2.2', version: '1.0.0' },
      }, files).map((diagnostic) => diagnostic.message);

    expect(judge([external({})])).toEqual([]);
    // A bare package request cannot borrow a sibling as its target.
    expect(judge([external({ request: 'left-pad', userRequest: 'left-pad' })]))
      .toEqual([expect.stringContaining('sibling "left-pad", which the artifact does not contain')]);
    // The target must be the file the request resolves to from the asset.
    expect(judge([external({ target: 'a.js' })]))
      .toEqual([expect.stringContaining('sibling "./lib/b.js", which the artifact does not contain')]);
    // A sibling that is not a compiled file is not a valid load target.
    expect(judge([external({ request: './copied.mjs', target: 'copied.mjs', userRequest: './copied.mjs' })]))
      .toEqual([expect.stringContaining('sibling "./copied.mjs", which the artifact does not contain')]);
    // A built-in kept through a non-module-loading external type is not a load.
    expect(judge([{ externalType: 'var', issuers: [], kind: 'builtin', request: 'node:fs', userRequest: 'node:fs' }]))
      .toEqual([expect.stringContaining('"node:fs" as a built-in; it is not one')]);
  });
});
