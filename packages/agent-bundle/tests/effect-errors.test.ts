import { inspect } from 'node:util';

import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from '@rstest/core';

import { stableJson } from '../src/core/digest.ts';
import { CodedError } from '../src/core/errors.ts';
import { DevCoordinatorCloseError } from '../src/dev/coordinator.ts';
import { RuntimeMcpRegistryError } from '../src/dev/runtime-mcp-registry.ts';
import { ScriptPlaygroundFailure } from '../src/dev/playground/script-playground-service.ts';
import { isTypedDevError, runPromise, runPromiseExit } from '../src/effect/boundary.ts';
import { YieldableCodedError, YieldableFrameworkError } from '../src/effect/errors.ts';

/** The plain-`Error` twin the yieldable bases replace; the serialization pins compare against it. */
class PlainCoded extends CodedError<'AB0001'> {
  readonly detail: string;

  constructor(message: string, detail: string, options?: ErrorOptions) {
    super('Probe', 'AB0001', message, options);
    this.detail = detail;
  }
}

class YieldableCoded extends YieldableCodedError<'AB0001'> {
  readonly detail: string;

  constructor(message: string, detail: string, options?: ErrorOptions) {
    super('Probe', 'AB0001', message, options);
    this.detail = detail;
  }
}

describe('yieldable framework error bases (src/effect/errors.ts)', () => {
  it('fails an Effect.gen program by yield* with the same instance Effect.fail would carry', async () => {
    const error = new ScriptPlaygroundFailure('spawn-failed', 'Script failed.', { stderr: '', stdout: '' });
    const program = Effect.gen(function* () {
      return yield* error;
    });
    const exit = await runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBe(error);
    }
    await expect(runPromise(program)).rejects.toBe(error);
    await expect(runPromise(Effect.fail(error))).rejects.toBe(error);
    expect(isTypedDevError(error)).toBe(true);
    const uncoded = new DevCoordinatorCloseError([]);
    await expect(runPromise(Effect.gen(function* () {
      return yield* uncoded;
    }))).rejects.toBe(uncoded);
  });

  it('types the yielded error into the fail channel', () => {
    const program: Effect.Effect<never, RuntimeMcpRegistryError> = Effect.gen(function* () {
      return yield* new RuntimeMcpRegistryError('RUNTIME_MCP_REGISTRY_CLOSED', 'Runtime MCP registry is closed.');
    });
    expect(program).toBeDefined();
  });

  it('keeps the plain Error shape: instanceof, name, code, message, cause, stack', () => {
    const cause = new Error('inner');
    const error = new YieldableCoded('outer', 'd', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(YieldableCodedError);
    expect(error).toBeInstanceOf(YieldableFrameworkError);
    expect(error.name).toBe('Probe');
    expect(error.code).toBe('AB0001');
    expect(error.message).toBe('outer');
    expect(error.cause).toBe(cause);
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(error, 'message')?.enumerable).toBe(false);
    expect(error.stack?.split('\n')[0]).toBe('Probe: outer');
    expect(String(error)).toBe('Probe: outer');
    expect('cause' in new YieldableCoded('no cause', 'd')).toBe(false);
  });

  it('installs a falsy cause exactly like new Error(message, { cause })', () => {
    for (const cause of [null, 0, '', false, undefined]) {
      const plain = new PlainCoded('m', 'd', { cause });
      const yieldable = new YieldableCoded('m', 'd', { cause });
      expect('cause' in yieldable).toBe('cause' in plain);
      expect(yieldable.cause).toBe(plain.cause);
      expect(Object.keys(yieldable)).toEqual(Object.keys(plain));
    }
  });

  it('serializes byte-identically to the plain Error twin (JSON.stringify, stableJson, spread)', () => {
    const plain = new PlainCoded('outer', 'd', { cause: new Error('inner') });
    const yieldable = new YieldableCoded('outer', 'd', { cause: new Error('inner') });
    expect(Object.keys(yieldable)).toEqual(Object.keys(plain));
    expect(Object.keys(yieldable)).toEqual(['code', 'name', 'detail']);
    expect(JSON.stringify(yieldable)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(yieldable)).toBe('{"code":"AB0001","name":"Probe","detail":"d"}');
    expect(stableJson(yieldable)).toBe(stableJson(plain));
    expect(stableJson({ error: yieldable })).toBe(stableJson({ error: plain }));
    expect({ ...yieldable }).toEqual({ ...plain });
    expect(structuredClone(yieldable)).toEqual(structuredClone(plain));
  });

  it('prints the stack trace under util.inspect instead of a field dump', () => {
    const yieldable = new YieldableCoded('outer', 'd');
    const rendered = inspect(yieldable);
    expect(rendered.startsWith('Probe: outer\n    at ')).toBe(true);
    expect(rendered).toContain("code: 'AB0001'");
    expect(rendered.startsWith('{')).toBe(false);
  });

  it('never leaks into a package entry', async () => {
    const rootApi = await import('../src/index.ts');
    const api = await import('../src/api.ts');
    expect('YieldableCodedError' in rootApi).toBe(false);
    expect('YieldableFrameworkError' in rootApi).toBe(false);
    expect('YieldableCodedError' in api).toBe(false);
    expect('YieldableFrameworkError' in api).toBe(false);
  });
});
