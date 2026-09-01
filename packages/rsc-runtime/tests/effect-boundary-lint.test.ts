import { describe, expect, it } from '@rstest/core';

import { effectBoundaryPlugin, isEffectBoundaryFile } from '../../../scripts/eslint-plugin-effect-boundary.ts';

const rule = effectBoundaryPlugin.rules['no-ad-hoc-run'];

const apply = (filename: string, visit: (listeners: ReturnType<typeof rule.create>) => void) => {
  const reports: Array<{ readonly messageId: string; readonly data: { readonly name: string } }> = [];
  const listeners = rule.create({
    filename,
    report(descriptor) {
      reports.push({ data: descriptor.data, messageId: descriptor.messageId });
    },
  });
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
});
