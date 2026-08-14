import { expect, it } from '@rstest/core';

import {
  DiagnosticBag,
  DiagnosticError,
  type Diagnostic,
} from '../src/core/diagnostics.ts';
import { digest, stableJson } from '../src/core/digest.ts';
import { assertInside } from '../src/core/paths.ts';

it('serializes plain-object keys deterministically without changing JSON values', () => {
  const value = {
    z: 1,
    a: { y: 2, b: 3 },
    items: [{ b: 2, a: 1 }, 3],
    ignored: undefined,
    nonFinite: Number.NaN,
  };

  expect(stableJson(value)).toBe(
    '{"a":{"b":3,"y":2},"items":[{"a":1,"b":2},3],"nonFinite":null,"z":1}',
  );
  expect(digest(value)).toBe(
    '0338f75b2518e061751e01ee2c95f868309c301ae1f02619877fba6063fb84de',
  );
});

it('serializes integer-like object keys in lexical order', () => {
  expect(stableJson({ '2': 'two', '10': 'ten' })).toBe(
    '{"10":"ten","2":"two"}',
  );
});

it('returns resolved paths contained by the output root', () => {
  expect(assertInside('/tmp/out', '/tmp/out')).toBe('/tmp/out');
  expect(assertInside('/tmp/out', '/tmp/out/nested/file.txt')).toBe(
    '/tmp/out/nested/file.txt',
  );
  expect(() => assertInside('/tmp/out', '/tmp/outside/file.txt')).toThrow(
    /outside output root/,
  );
});

it('throws stable error summaries containing only error diagnostics', () => {
  const warning: Diagnostic = {
    code: 'AB1002',
    severity: 'warning',
    message: 'Optional metadata is absent',
  };
  const error: Diagnostic = {
    code: 'AB1001',
    severity: 'error',
    message: 'Plugin name is required',
    sourcePath: '/project/agent-bundle.config.ts',
    generatedPath: '/project/dist/plugin.json',
    target: 'codex',
    recovery: 'Set plugin.name in the configuration.',
  };
  const bag = new DiagnosticBag([warning, error]);

  try {
    bag.throwIfErrors();
  } catch (caught) {
    expect(caught).toBeInstanceOf(DiagnosticError);
    const diagnosticError = caught as DiagnosticError;
    expect(diagnosticError.diagnostics).toEqual([error]);
    expect(diagnosticError.message).toBe(
      'Agent Bundle compilation failed with 1 error:\n[AB1001] Plugin name is required',
    );
    return;
  }

  throw new Error('Expected DiagnosticBag.throwIfErrors() to throw.');
});
