import { describe, expect, it } from '@rstest/core';

import { extractStateDefinition } from '../src/config/state-extract.ts';

const extract = (text: string) =>
  extractStateDefinition(text, 'src/state.ts', '/project/src/state.ts');

describe('state definition extraction', () => {
  it('extracts literal id and lifetime without executing the module', () => {
    const result = extract([
      "import { defineState } from '@agent-bundle/runtime/state';",
      'throw new Error("must not execute");',
      'export default defineState({',
      "  id: 'project/tasks',",
      "  lifetime: 'workspace-durable',",
      '  schema: anything,',
      '});',
    ].join('\n'));

    expect(result).toEqual({
      definition: { id: 'project/tasks', lifetime: 'workspace-durable' },
      diagnostics: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.definition?.budgets).toBeUndefined();
  });

  it('extracts full literal budgets', () => {
    const result = extract([
      'export default defineState({',
      "  id: 'project/tasks',",
      "  lifetime: 'workspace-durable',",
      '  budgets: {',
      '    maxEventBytes: 262144,',
      '    maxStateBytes: 1048576,',
      '    maxRevisions: 100000,',
      '    maxCommitMs: 5000,',
      '  },',
      '});',
    ].join('\n'));

    expect(result.definition?.budgets).toEqual({
      declared: {
        maxCommitMs: 5000,
        maxEventBytes: 262144,
        maxRevisions: 100000,
        maxStateBytes: 1048576,
      },
    });
  });

  it('extracts partial literal budgets', () => {
    const result = extract([
      'export default defineState({',
      "  id: 'project/tasks',",
      "  lifetime: 'process',",
      '  budgets: { maxRevisions: 42 },',
      '});',
    ].join('\n'));

    expect(result.definition?.budgets).toEqual({ declared: { maxRevisions: 42 } });
  });

  it.each([
    ['computed value', 'budgets: { maxStateBytes: MAX_STATE_BYTES }'],
    ['unknown key', 'budgets: { maxStateBytes: 1024, burst: 2 }'],
  ])('marks %s budgets as dynamic', (_label, budgets) => {
    const result = extract([
      'export default defineState({',
      "  id: 'project/tasks',",
      "  lifetime: 'request',",
      `  ${budgets},`,
      '});',
    ].join('\n'));

    expect(result.definition?.budgets).toBe('dynamic');
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ['missing default export', 'export const state = defineState({ id: "x", lifetime: "process" });', 'AB4818'],
    ['wrong default call', 'export default createState({ id: "x", lifetime: "process" });', 'AB4818'],
    ['non-literal id', 'export default defineState({ id: STATE_ID, lifetime: "process" });', 'AB4819'],
    ['non-literal lifetime', 'export default defineState({ id: "x", lifetime: lifetime() });', 'AB4819'],
    ['unknown lifetime', 'export default defineState({ id: "x", lifetime: "forever" });', 'AB4819'],
  ])('diagnoses %s', (_label, source, code) => {
    const result = extract(source);
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code,
      severity: 'error',
      sourcePath: '/project/src/state.ts',
    });
  });

  it('rejects external lifetime until embedder driver wiring exists', () => {
    const result = extract('export default defineState({ id: "x", lifetime: "external" });');
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: 'AB4820', severity: 'error' });
    expect(result.diagnostics[0]!.message).toContain('request, process, and workspace-durable');
  });

  it('rejects the reserved notice-ledger state id', () => {
    const result = extract([
      'export default defineState({',
      "  id: '@agent-bundle/runtime/agent-notice-ledger/v1',",
      "  lifetime: 'workspace-durable',",
      '});',
    ].join('\n'));
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: 'AB4821', severity: 'error' });
    expect(result.diagnostics[0]!.message).toContain('notice-ledger');
  });
});
