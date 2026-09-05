import { describe, expect, it } from '@rstest/core';

import type { CompileResult, ExternalIR } from '../src/build/compile-result.ts';
import {
  classifyExternal,
  externalizedSpecifiers,
  selfContainmentDiagnostics,
} from '../src/build/external-policy.ts';

const resultWith = (externals: readonly ExternalIR[]): CompileResult => ({
  assets: [],
  diagnostics: [],
  externals,
  modules: [],
});

describe('classifyExternal', () => {
  const emittedAssets = new Set(['scripts/probe.mjs', 'scripts/sibling.mjs']);
  const classify = (request: string) => classifyExternal(request, {
    asset: 'scripts/probe.mjs',
    emittedAssets,
  });

  it('accepts Node builtins and Yarn PnP', () => {
    expect(classify('fs')).toBe('builtin');
    expect(classify('node:fs')).toBe('builtin');
    expect(classify('pnpapi')).toBe('builtin');
  });

  it('accepts emitted artifact-relative siblings', () => {
    expect(classify('./sibling.mjs')).toBe('artifact-relative');
  });

  it('rejects missing, escaping, and package requests', () => {
    expect(classify('./missing.mjs')).toBe('package');
    expect(classify('../outside.mjs')).toBe('package');
    expect(classify('left-pad')).toBe('package');
  });

  it('judges the run-time target, so an escaping normalised path is not a sibling', () => {
    expect(classify('../scripts/sibling.mjs')).toBe('artifact-relative');
    expect(classify('./../../scripts/sibling.mjs')).toBe('package');
  });
});

describe('selfContainmentDiagnostics', () => {
  it('reports package externals in asset-request order', () => {
    expect(selfContainmentDiagnostics(resultWith([
      {
        asset: 'scripts/zeta.mjs',
        externalType: 'module',
        issuers: [],
        kind: 'package',
        request: 'left-pad',
        userRequest: 'left-pad',
      },
      {
        asset: 'scripts/alpha.mjs',
        externalType: 'node-commonjs',
        issuers: ['src/entry.ts', 'src/helper.ts'],
        kind: 'package',
        request: 'right-pad',
        userRequest: 'right-pad',
      },
    ]))).toEqual([
      expect.objectContaining({
        code: 'AB6005',
        generatedPath: 'scripts/alpha.mjs',
        message: 'Compiled module "scripts/alpha.mjs" keeps "right-pad" external (node-commonjs) from src/entry.ts, src/helper.ts; a generated executable bundles everything but Node built-ins.',
      }),
      expect.objectContaining({
        code: 'AB6005',
        generatedPath: 'scripts/zeta.mjs',
        message: 'Compiled module "scripts/zeta.mjs" keeps "left-pad" external (module); a generated executable bundles everything but Node built-ins.',
      }),
    ]);
  });

  it('names the authored specifier when an object map redirected it, and the missing sibling a relative target misses', () => {
    expect(selfContainmentDiagnostics(resultWith([
      {
        asset: 'scripts/probe.mjs',
        externalType: 'module',
        issuers: ['src/probe.ts'],
        kind: 'package',
        request: 'lp',
        userRequest: 'left-pad',
      },
      {
        asset: 'scripts/probe.mjs',
        externalType: 'module',
        issuers: ['src/probe.ts'],
        kind: 'package',
        request: './missing.mjs',
        userRequest: './missing.ts',
      },
    ])).map((diagnostic) => diagnostic.message)).toEqual([
      'Compiled module "scripts/probe.mjs" keeps "./missing.mjs" external (module), imported as "./missing.ts", from src/probe.ts; it names no module emitted by this artifact.',
      'Compiled module "scripts/probe.mjs" keeps "lp" external (module), imported as "left-pad", from src/probe.ts; a generated executable bundles everything but Node built-ins.',
    ]);
  });

  it('allows builtins and emitted artifact-relative externals', () => {
    expect(selfContainmentDiagnostics(resultWith([
      {
        asset: 'scripts/probe.mjs',
        externalType: 'module',
        issuers: ['src/probe.ts'],
        kind: 'builtin',
        request: 'node:fs',
        userRequest: 'node:fs',
      },
      {
        asset: 'scripts/probe.mjs',
        externalType: 'module',
        issuers: ['src/probe.ts'],
        kind: 'artifact-relative',
        request: './sibling.mjs',
        userRequest: './sibling.mjs',
      },
    ]))).toEqual([]);
  });
});

describe('externalizedSpecifiers', () => {
  it('accepts builtins, disabled object entries, regular expressions, and functions', () => {
    expect(externalizedSpecifiers('fs')).toEqual([]);
    expect(externalizedSpecifiers('node:fs')).toEqual([]);
    expect(externalizedSpecifiers('pnpapi')).toEqual([]);
    expect(externalizedSpecifiers(/^node:/u)).toEqual([]);
    expect(externalizedSpecifiers({ 'left-pad': false })).toEqual([]);
    expect(externalizedSpecifiers(() => 'left-pad')).toEqual([]);
    expect(externalizedSpecifiers(undefined)).toEqual([]);
  });

  it('leaves relative requests to compile time, where emitted siblings are known', () => {
    expect(externalizedSpecifiers('./worker.mjs')).toEqual([]);
    expect(externalizedSpecifiers({ '../outside.mjs': 'module ../outside.mjs' })).toEqual([]);
  });

  it('lists every non-builtin static declaration, recursively', () => {
    expect(externalizedSpecifiers('left-pad')).toEqual(['left-pad']);
    expect(externalizedSpecifiers(['node:fs', ['left-pad'], 'right-pad'])).toEqual(['left-pad', 'right-pad']);
    expect(externalizedSpecifiers({ fs: 'fs', 'left-pad': 'commonjs left-pad' })).toEqual(['left-pad']);
  });
});
