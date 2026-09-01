import { describe, expect, it } from '@rstest/core';

import { effectBoundaryPlugin, isEffectBoundaryFile } from '../../../scripts/eslint-plugin-effect-boundary.ts';

const rule = effectBoundaryPlugin.rules['no-ad-hoc-run'];

type ImportNode = {
  readonly imported?: { readonly name?: string };
  readonly local?: { readonly name?: string };
  readonly parent?: { readonly source?: { readonly value?: unknown } };
};

type MemberNode = {
  readonly computed?: boolean;
  readonly object?: { readonly name?: string; readonly type?: string };
  readonly property?: { readonly name?: string; readonly type?: string };
};

type LintListeners = ReturnType<typeof rule.create> & {
  ImportNamespaceSpecifier?(node: ImportNode): void;
  ImportSpecifier?(node: ImportNode): void;
  MemberExpression?(node: MemberNode): void;
};

const apply = (filename: string, visit: (listeners: LintListeners) => void) => {
  const reports: Array<{ readonly messageId: string; readonly data: { readonly name: string } }> = [];
  const listeners = rule.create({
    filename,
    report(descriptor) {
      reports.push({ data: descriptor.data, messageId: descriptor.messageId });
    },
  }) as LintListeners;
  visit(listeners);
  return reports;
};

describe('effect-boundary lint', () => {
  it('recognizes only src/effect/boundary.ts as the legal runner home', () => {
    expect(isEffectBoundaryFile('/fast/projects/agent-bundle/packages/rsc-runtime/src/effect/boundary.ts')).toBe(true);
    expect(isEffectBoundaryFile('/fast/projects/agent-bundle/packages/agent-bundle/src/effect/boundary.ts')).toBe(true);
    expect(isEffectBoundaryFile('C:\\repo\\packages\\rsc-runtime\\src\\effect\\boundary.ts')).toBe(true);
    expect(isEffectBoundaryFile('/fast/projects/agent-bundle/packages/rsc-runtime/src/dispatcher.ts')).toBe(false);
    expect(isEffectBoundaryFile('/fast/projects/agent-bundle/packages/agent-bundle/src/dev/epoch-store.ts')).toBe(false);
  });

  it('rejects ad-hoc runners in agent-bundle dev seam files', () => {
    const reports = apply('packages/agent-bundle/src/dev/coordinator.ts', (listeners) => {
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'Effect', type: 'Identifier' },
        property: { name: 'runFork', type: 'Identifier' },
      });
    });
    expect(reports).toEqual([{ data: { name: 'Effect.runFork' }, messageId: 'forbiddenCall' }]);
  });

  it('rejects Effect.runPromise and Effect.runSync outside the boundary', () => {
    const reports = apply('packages/rsc-runtime/src/dispatcher.ts', (listeners) => {
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'Effect', type: 'Identifier' },
        property: { name: 'runPromise', type: 'Identifier' },
      });
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'Effect', type: 'Identifier' },
        property: { name: 'runSync', type: 'Identifier' },
      });
    });
    expect(reports).toEqual([
      { data: { name: 'Effect.runPromise' }, messageId: 'forbiddenCall' },
      { data: { name: 'Effect.runSync' }, messageId: 'forbiddenCall' },
    ]);
  });

  it('rejects importing runPromise from effect', () => {
    const reports = apply('packages/rsc-runtime/src/reconciler.ts', (listeners) => {
      listeners.ImportSpecifier?.({
        imported: { name: 'runPromise' },
        parent: { source: { value: 'effect' } },
      });
    });
    expect(reports).toEqual([{ data: { name: 'runPromise' }, messageId: 'forbiddenImport' }]);
  });

  it('allows runners inside src/effect/boundary.ts', () => {
    const reports = apply('packages/rsc-runtime/src/effect/boundary.ts', (listeners) => {
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'Effect', type: 'Identifier' },
        property: { name: 'runPromise', type: 'Identifier' },
      });
    });
    expect(reports).toEqual([]);
  });

  it('rejects aliased Effect namespaces (named and star imports)', () => {
    const named = apply('packages/rsc-runtime/src/dispatcher.ts', (listeners) => {
      listeners.ImportSpecifier?.({
        imported: { name: 'Effect' },
        local: { name: 'Fx' },
        parent: { source: { value: 'effect' } },
      });
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'Fx', type: 'Identifier' },
        property: { name: 'runPromise', type: 'Identifier' },
      });
    });
    expect(named).toEqual([{ data: { name: 'Fx.runPromise' }, messageId: 'forbiddenCall' }]);

    const star = apply('packages/agent-bundle/src/dev/coordinator.ts', (listeners) => {
      listeners.ImportNamespaceSpecifier?.({
        local: { name: 'E' },
        parent: { source: { value: 'effect' } },
      });
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'E', type: 'Identifier' },
        property: { name: 'runSync', type: 'Identifier' },
      });
    });
    expect(star).toEqual([{ data: { name: 'E.runSync' }, messageId: 'forbiddenCall' }]);
  });

  it('does not flag aliased Effect used for non-runners', () => {
    const reports = apply('packages/rsc-runtime/src/reconciler.ts', (listeners) => {
      listeners.ImportSpecifier?.({
        imported: { name: 'Effect' },
        local: { name: 'E' },
        parent: { source: { value: 'effect' } },
      });
      listeners.MemberExpression?.({
        computed: false,
        object: { name: 'E', type: 'Identifier' },
        property: { name: 'succeed', type: 'Identifier' },
      });
    });
    expect(reports).toEqual([]);
  });
});
