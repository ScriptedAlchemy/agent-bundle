import { describe, expect, it } from '@rstest/core';

import {
  executeProviders,
  orderedProviders,
  requiredProviderKeyProblemMessage,
  selectRequiredProviders,
  validateRequiredProviderKeys,
  type ExecutableProvider,
  type RequiredProviderKeyProblem,
  type RequiredProviderSelection,
} from '../src/routes/provider-execution.ts';
import { providerKeyFromName } from '../src/routes/providers.ts';
import type { CompiledProvider } from '../src/routes/types.ts';

/**
 * Declaration-driven required-provider selection (#595): the pure step every
 * consumer runs before `executeProviders` — the graph to validate a route's
 * declaration, the compiler to emit a route's provider subset, the harness to
 * mount the same subset. Fixtures are deliberately out of key order so the
 * tests distinguish declaration order from execution order.
 */

const compiled = (name: string): CompiledProvider => Object.freeze({
  id: `provider:${name}`,
  name,
  provenance: Object.freeze({ kind: 'conventional' as const, relativePath: `src/providers/${name}.ts` }),
  source: `/project/src/providers/${name}.ts`,
});

// Keys: zeta, alphaValue, daemonProbe — execution order is alphaValue, daemonProbe, zeta.
const providers: readonly CompiledProvider[] = Object.freeze([
  compiled('zeta'),
  compiled('alpha-value'),
  compiled('daemon_probe'),
]);

const names = (selection: RequiredProviderSelection<CompiledProvider>): readonly string[] => {
  if (!selection.ok) throw new Error(`expected an accepted selection, got ${JSON.stringify(selection.problems)}`);
  return selection.providers.map((provider) => provider.name);
};

describe('selectRequiredProviders', () => {
  it('resolves every conventional provider in the existing deterministic order when the route declares nothing', () => {
    const selection = selectRequiredProviders(providers, undefined);
    expect(selection).toEqual({ ok: true, providers: orderedProviders(providers) });
    expect(names(selection)).toEqual(['alpha-value', 'daemon_probe', 'zeta']);
  });

  it('selects only the declared keys, in key/source order rather than declaration order', () => {
    const selection = selectRequiredProviders(providers, Object.freeze(['zeta', 'alphaValue']));
    expect(names(selection)).toEqual(['alpha-value', 'zeta']);
    expect(names(selectRequiredProviders(providers, Object.freeze(['daemonProbe'])))).toEqual(['daemon_probe']);
  });

  it('selects no conventional provider for an empty declaration', () => {
    expect(selectRequiredProviders(providers, Object.freeze([]))).toEqual({ ok: true, providers: [] });
  });

  it('accepts an empty declaration and rejects every explicit key for a project without providers', () => {
    expect(selectRequiredProviders([], Object.freeze([]))).toEqual({ ok: true, providers: [] });
    expect(selectRequiredProviders([], undefined)).toEqual({ ok: true, providers: [] });
    expect(selectRequiredProviders([], Object.freeze(['zeta']))).toEqual({
      ok: false,
      problems: [{ key: 'zeta', kind: 'unknown-provider-key', known: [] }],
    });
  });

  it('reports duplicate, reserved and unknown keys together, once per offending occurrence, in declaration order', () => {
    const selection = selectRequiredProviders(
      providers,
      Object.freeze(['zeta', 'nope', 'zeta', 'processLifetime', 'nope', 'processLifetime']),
    );
    expect(selection).toEqual({
      ok: false,
      problems: [
        { key: 'nope', kind: 'unknown-provider-key', known: ['alphaValue', 'daemonProbe', 'zeta'] },
        { key: 'zeta', kind: 'duplicate-provider-key' },
        { key: 'processLifetime', kind: 'reserved-provider-key' },
        { key: 'nope', kind: 'duplicate-provider-key' },
        { key: 'processLifetime', kind: 'duplicate-provider-key' },
      ],
    });
  });

  it('matches declared keys against the derived camel-case key, not the file stem', () => {
    // `alpha-value` is the stem; `alphaValue` is the mounted key a route reads.
    expect(selectRequiredProviders(providers, Object.freeze(['alpha-value']))).toEqual({
      ok: false,
      problems: [{ key: 'alpha-value', kind: 'unknown-provider-key', known: ['alphaValue', 'daemonProbe', 'zeta'] }],
    });
  });

  it('returns frozen results without mutating or reordering its inputs', () => {
    const input = [compiled('zeta'), compiled('alpha-value')];
    const required = ['zeta', 'alphaValue'];
    const accepted = selectRequiredProviders(input, required);
    const rejected = selectRequiredProviders(input, ['zeta', 'zeta']);
    expect(input.map((provider) => provider.name)).toEqual(['zeta', 'alpha-value']);
    expect(required).toEqual(['zeta', 'alphaValue']);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(accepted.ok && Object.isFrozen(accepted.providers)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(!rejected.ok && Object.isFrozen(rejected.problems)).toBe(true);
    expect(!rejected.ok && rejected.problems.every((problem) => Object.isFrozen(problem))).toBe(true);
    // Selection never freezes the caller's provider records: the graph froze
    // its own; a harness fixture stays the caller's to mutate.
    expect(Object.isFrozen(input)).toBe(false);
  });
});

describe('validateRequiredProviderKeys', () => {
  it('returns no problems for a distinct subset of the known keys', () => {
    expect(validateRequiredProviderKeys(Object.freeze(['zeta', 'alphaValue']), ['alphaValue', 'zeta'])).toEqual([]);
    expect(validateRequiredProviderKeys(Object.freeze([]), [])).toEqual([]);
  });

  it('accepts any iterable of known keys and lists them sorted and unique in an unknown-key problem', () => {
    const fromSet = validateRequiredProviderKeys(['nope'], new Set(['zeta', 'alphaValue']));
    const fromArray = validateRequiredProviderKeys(['nope'], ['zeta', 'alphaValue', 'zeta']);
    expect(fromSet).toEqual([{ key: 'nope', kind: 'unknown-provider-key', known: ['alphaValue', 'zeta'] }]);
    expect(fromArray).toEqual(fromSet);
    expect(Object.isFrozen(fromSet)).toBe(true);
    expect(Object.isFrozen(fromSet[0])).toBe(true);
    expect(Object.isFrozen((fromSet[0] as { known: readonly string[] }).known)).toBe(true);
  });

  it('flags the reserved processLifetime key even when a caller lists it as known', () => {
    // The graph refuses a provider module deriving this key (AB4942); the
    // request scope seeds it itself, so a declaration never selects it.
    expect(validateRequiredProviderKeys(['processLifetime'], ['processLifetime', 'zeta'])).toEqual([
      { key: 'processLifetime', kind: 'reserved-provider-key' },
    ]);
  });
});

describe('requiredProviderKeyProblemMessage', () => {
  it('names the key and the defect for every problem kind', () => {
    const problems: readonly RequiredProviderKeyProblem[] = [
      { key: 'zeta', kind: 'duplicate-provider-key' },
      { key: 'processLifetime', kind: 'reserved-provider-key' },
      { key: 'nope', kind: 'unknown-provider-key', known: ['alphaValue', 'zeta'] },
      { key: 'nope', kind: 'unknown-provider-key', known: [] },
    ];
    expect(problems.map(requiredProviderKeyProblemMessage)).toEqual([
      'Required provider key "zeta" is declared more than once.',
      'Required provider key "processLifetime" is the framework-owned process identity every request mounts; do not declare it.',
      'Required provider key "nope" matches no conventional provider; known keys: alphaValue, zeta.',
      'Required provider key "nope" matches no conventional provider; the project declares none.',
    ]);
  });
});

describe('executeProviders over a selection', () => {
  const lifetime = { hits: 1, instanceId: 'instance-1', pid: 42 };
  const request = {
    host: { reason: 'not-provided', state: 'unavailable' },
    lineage: { reason: 'not-provided', state: 'unavailable' },
    plugin: { reason: 'not-provided', state: 'unavailable' },
    session: { reason: 'not-provided', state: 'unavailable' },
    signal: new AbortController().signal,
    workspace: { reason: 'not-provided', state: 'unavailable' },
  } as const;

  const executable = (
    selection: RequiredProviderSelection<CompiledProvider>,
    factories: Record<string, () => unknown>,
  ): readonly ExecutableProvider[] => {
    if (!selection.ok) throw new Error('expected an accepted selection');
    return selection.providers.map((provider) => {
      const key = providerKeyFromName(provider.name);
      return { key, module: { default: factories[key] }, source: provider.provenance.relativePath };
    });
  };

  it('always mounts processLifetime, alone when the declaration selects nothing', async () => {
    const values = await executeProviders({
      invocation: { kind: 'event' },
      processLifetime: lifetime,
      providers: executable(selectRequiredProviders(providers, Object.freeze([])), {}),
      request,
    });
    expect(values).toEqual({ processLifetime: { hits: 1, instanceId: 'instance-1', pid: 42 } });
  });

  it('runs only the selected factories, in the existing deterministic order, after processLifetime', async () => {
    const calls: string[] = [];
    const factories = {
      alphaValue: () => { calls.push('alphaValue'); return 'a'; },
      daemonProbe: () => { calls.push('daemonProbe'); throw new Error('must not be selected'); },
      zeta: () => { calls.push('zeta'); return 'z'; },
    };
    const values = await executeProviders({
      invocation: { kind: 'event' },
      processLifetime: lifetime,
      providers: executable(selectRequiredProviders(providers, Object.freeze(['zeta', 'alphaValue'])), factories),
      request,
    });
    expect(Object.keys(values)).toEqual(['processLifetime', 'alphaValue', 'zeta']);
    expect(values).toEqual({ alphaValue: 'a', processLifetime: { hits: 1, instanceId: 'instance-1', pid: 42 }, zeta: 'z' });
    expect(calls).toEqual(['alphaValue', 'zeta']);
  });
});
