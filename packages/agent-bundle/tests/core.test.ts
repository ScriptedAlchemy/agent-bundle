import { expect, it } from '@rstest/core';

import {
  DiagnosticBag,
  DiagnosticError,
  type Diagnostic,
} from '../src/core/diagnostics.ts';
import { digest, stableJson } from '../src/core/digest.ts';
import { assertInside } from '../src/core/paths.ts';
import { typeScriptTransformFlags } from '../src/core/runtime.ts';
import type { McpTransport } from '../src/index.ts';

// Type-level contract: only modern MCP transports are public.
const modernTransport: McpTransport = 'streamable-http';
// @ts-expect-error Legacy HTTP+SSE is not part of the public MCP transport contract.
const legacyTransport: McpTransport = 'sse';
void [modernTransport, legacyTransport];

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

it('matches JSON.stringify for sparse arrays', () => {
  const oneHole = Array(1);
  const middleHole = [1, 2, 3];
  delete middleHole[1];

  expect(stableJson(oneHole)).toBe(JSON.stringify(oneHole));
  expect(stableJson(middleHole)).toBe(JSON.stringify(middleHole));
});

it('matches JSON.stringify for boxed primitives', () => {
  const boxedNumber = Object(1);
  const boxedString = Object('agent-bundle');
  const boxedBoolean = Object(true);

  expect(stableJson(boxedNumber)).toBe(JSON.stringify(boxedNumber));
  expect(stableJson(boxedString)).toBe(JSON.stringify(boxedString));
  expect(stableJson(boxedBoolean)).toBe(JSON.stringify(boxedBoolean));
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

// The TypeScript-related entries of `process.allowedNodeEnvironmentFlags`, as
// observed on each release line.
const node22Flags: ReadonlySet<string> = new Set([
  '--experimental-default-type',
  '--experimental-strip-types',
  '--experimental-transform-types',
  '--input-type',
  '--no-experimental-strip-types',
  '--no-experimental-transform-types',
]);
const node24Flags: ReadonlySet<string> = new Set([
  '--experimental-strip-types',
  '--experimental-transform-types',
  '--input-type',
  '--no-experimental-transform-types',
  '--no-strip-types',
  '--strip-types',
]);
// Node 26 removed --experimental-transform-types (nodejs/node#61803).
const node26Flags: ReadonlySet<string> = new Set([
  '--experimental-strip-types',
  '--input-type',
  '--no-strip-types',
  '--strip-types',
]);

it('passes --experimental-transform-types to a TypeScript child only where the binary accepts it', () => {
  expect(typeScriptTransformFlags(node22Flags)).toEqual(['--experimental-transform-types']);
  expect(typeScriptTransformFlags(node24Flags)).toEqual(['--experimental-transform-types']);
  // Node 26 rejects the removed flag as a bad option; it strips types by
  // default, and the stable flag names that explicitly so an inherited
  // NODE_OPTIONS=--no-strip-types cannot switch it off.
  expect(typeScriptTransformFlags(node26Flags)).toEqual(['--strip-types']);
  expect(Object.isFrozen(typeScriptTransformFlags(node26Flags))).toBe(true);
  // A binary that accepts neither gets no flag rather than a bad option.
  expect(typeScriptTransformFlags(new Set(['--input-type']))).toEqual([]);
});

it('defaults to the flags this process accepts, so a child over process.execPath never gets a bad option', () => {
  const flags = typeScriptTransformFlags();
  expect(flags).toEqual(typeScriptTransformFlags(process.allowedNodeEnvironmentFlags));
  for (const flag of flags) expect(process.allowedNodeEnvironmentFlags.has(flag)).toBe(true);
});
