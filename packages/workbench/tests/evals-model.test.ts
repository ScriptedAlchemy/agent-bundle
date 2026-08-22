import { expect, it } from '@rstest/core';

import type { EvalRunResult, EvalSuiteListing } from '../../agent-bundle/src/dev/eval/eval-service.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../../agent-bundle/src/eval/run-store.ts';
import {
  admitEvalRunLifecycle,
  createEvalRunLifecycle,
  evalRunLifecycleToken,
  evalOutcomeLabel,
  evalRunSelectionFor,
  evalRunViewFor,
  evalSuiteOptionsFor,
  evalTrialRowsFor,
  maximumEvalTimelineBytes,
  mergeEvalEvents,
  replaceEvalRunLifecycle,
  updateEvalRunLifecycle,
} from '../src/evals/evals-model.ts';
import { makeRunRecord, makeTrialRecord } from './support/eval-records.ts';

const listing: EvalSuiteListing = {
  diagnostics: [],
  suites: [
    {
      cases: [{
        assertions: [{ id: 'skill-activation:0123456789abcdef', kind: 'skill-activation' }],
        digest: 'f'.repeat(64),
        hosts: ['portable'],
        id: 'unbound-activation',
        invocation: { mode: 'explicit', skill: 'review' },
        prompt: 'Invoke the review Skill.',
        trials: 1,
      }],
      digest: 'a'.repeat(64),
      name: 'zeta-suite',
      sourcePath: 'evals/zeta.eval.ts',
    },
    {
      cases: [
        {
          assertions: [{ id: 'outcome:0123456789abcdef', kind: 'outcome' }],
          digest: 'b'.repeat(64),
          hosts: ['portable'],
          id: 'reads-result',
          invocation: { mode: 'automatic' },
          prompt: 'Report the highest-risk regression.',
          trials: 2,
        },
        {
          assertions: [
            { id: 'outcome:fedcba9876543210', kind: 'outcome' },
            { id: 'exit-code:fedcba9876543210', kind: 'exit-code' },
          ],
          digest: 'c'.repeat(64),
          hosts: ['claude', 'portable'],
          id: 'wrong-result',
          invocation: { mode: 'none' },
          prompt: 'Leave the fixture untouched.',
          trials: 1,
        },
      ],
      digest: 'd'.repeat(64),
      name: 'review-change',
      sourcePath: 'evals/review.eval.ts',
    },
  ],
};

const runRecord: EvalRunRecord = makeRunRecord();

const trial = (overrides: Partial<EvalTrialRecord>): EvalTrialRecord => makeTrialRecord(overrides);

const result: EvalRunResult = {
  aggregates: [],
  diagnostics: [],
  run: runRecord,
  trials: [
    trial({}),
    trial({
      assertions: [{
        assertionId: 'skill-activation:0123456789abcdef',
        detail: 'The harness recorded "unavailable" evidence but this assertion requires at least "inferred".',
        evidence: 'unavailable',
        kind: 'skill-activation',
        outcome: 'inconclusive',
      }],
      caseId: 'unbound-activation',
      id: 'portable-1-activation',
      outcome: 'inconclusive',
    }),
    trial({
      assertions: [{
        assertionId: 'outcome:fedcba9876543210',
        detail: 'The fixture did not record risk low.',
        evidence: 'observed',
        kind: 'outcome',
        outcome: 'fail',
      }],
      caseId: 'wrong-result',
      id: 'portable-1-wrong',
      outcome: 'fail',
      pluginFailure: { code: 'EVAL_PLUGIN_ASSERTION_FAILED', message: 'At least one assertion failed.' },
    }),
  ],
};

it('orders suite options and reports the authored source of each one', () => {
  const options = evalSuiteOptionsFor(listing.suites);

  expect(options.map((option) => option.name)).toEqual(['review-change', 'zeta-suite']);
  expect(options[0]).toMatchObject({ cases: 2, key: 'review-change', sourcePath: 'evals/review.eval.ts' });
  expect(options[0]?.label).toContain('evals/review.eval.ts');
  expect(options[0]?.label).toContain('2 case');
  expect(Object.isFrozen(options)).toBe(true);
});

it('keeps an inconclusive trial distinct from a failing trial', () => {
  const rows = evalTrialRowsFor(result.trials);

  expect(rows.map((row) => row.outcome)).toEqual(['pass', 'inconclusive', 'fail']);
  expect(rows[1]).toMatchObject({ caseId: 'unbound-activation', failure: undefined, outcome: 'inconclusive' });
  expect(rows[1]?.assertions[0]).toMatchObject({ evidence: 'unavailable', outcome: 'inconclusive' });
  expect(rows[2]?.failure).toContain('EVAL_PLUGIN_ASSERTION_FAILED');
  expect(evalOutcomeLabel('fail')).toBe('Failed');
  expect(evalOutcomeLabel('inconclusive')).toBe('Inconclusive');
  expect(evalOutcomeLabel('pass')).toBe('Passed');
});

it('reports a harness failure as a harness defect rather than a plugin defect', () => {
  const rows = evalTrialRowsFor([trial({
    harnessFailure: { code: 'EVAL_GRADER_FAILED', message: 'Grading is incomplete.', stage: 'grader' },
    outcome: 'inconclusive',
  })]);

  expect(rows[0]?.failure).toContain('Harness failure');
  expect(rows[0]?.failure).toContain('EVAL_GRADER_FAILED');
});

it('carries the exact target digest of every trial', () => {
  const rows = evalTrialRowsFor(result.trials);

  expect(rows.every((row) => row.targetDigest === 'c'.repeat(64))).toBe(true);
  expect(rows[0]?.host).toBe('portable');
  expect(rows[0]?.model).toBe('deterministic');
});

it('derives the case table of the selected suite', () => {
  const view = evalRunViewFor({ listing, result: undefined, selectedSuite: 'review-change' });

  expect(view.selected?.name).toBe('review-change');
  expect(view.cases.map((row) => row.id)).toEqual(['reads-result', 'wrong-result']);
  expect(view.cases[1]).toMatchObject({ assertions: 2, hosts: 'claude, portable', trials: 1 });
  expect(view.cases[0]?.invocation).toBe('automatic');
  expect(view.cases[1]?.prompt).toBe('Leave the fixture untouched.');
});

it('falls back to the first suite when none is selected', () => {
  const view = evalRunViewFor({ listing, result: undefined, selectedSuite: undefined });

  expect(view.selected?.name).toBe('review-change');
  expect(view.state).toBe('ready');
  expect(view.summary).toContain('Select an authored suite');
});

it('reports the loading, empty, and completed states', () => {
  const loading = evalRunViewFor({ listing: undefined, result: undefined, selectedSuite: undefined });
  const empty = evalRunViewFor({ listing: { diagnostics: [], suites: [] }, result: undefined, selectedSuite: undefined });
  const ran = evalRunViewFor({
    events: [{ kind: 'run.completed', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }],
    listing,
    result,
    selectedSuite: 'review-change',
  });

  expect(loading.state).toBe('loading');
  expect(empty.state).toBe('empty');
  expect(empty.summary).toContain('no eval suites');
  expect(ran.state).toBe('ran');
  expect(ran.runId).toBe(runRecord.id);
  expect(ran.outcomes).toEqual({ fail: 1, inconclusive: 1, pass: 1 });
  expect(ran.summary).toContain('1 passed');
  expect(ran.summary).toContain('1 failed');
  expect(ran.summary).toContain('1 inconclusive');
  expect(Object.isFrozen(ran)).toBe(true);
});

it('derives admitting, active, and terminal run states from durable events', () => {
  const admitted: EvalRunRecord = {
    ...runRecord,
    completedAt: undefined,
    summary: undefined,
  };
  const event = (kind: string) => ({
    kind,
    payload: {},
    sequence: 1,
    timestamp: '2026-08-17T00:00:00.000Z',
  });
  const status = (events: readonly ReturnType<typeof event>[], admitting = false) => evalRunViewFor({
    admitting,
    admittedRun: admitted,
    events,
    listing,
    result: undefined,
    selectedSuite: 'review-change',
  }).runStatus;

  expect(status([], true)).toBe('admitting');
  expect(status([])).toBe('queued');
  expect(status([event('run.started')])).toBe('queued');
  expect(status([event('trial.started')])).toBe('running');
  expect(status([event('run.cancelling')])).toBe('cancelling');
  expect(status([event('run.completed')])).toBe('completed');
  expect(status([event('run.failed')])).toBe('failed');
  expect(status([event('run.cancelled')])).toBe('cancelled');
});

it('never infers a successful terminal state from completedAt before durable replay', () => {
  const completed: EvalRunRecord = runRecord;
  const state = (events: readonly { readonly kind: string; readonly sequence: number }[]) => evalRunViewFor({
    admittedRun: completed,
    events: events.map((event) => ({ ...event, payload: {}, timestamp: '2026-08-17T00:00:00.000Z' })),
    listing,
    result: { ...result, run: completed },
    selectedSuite: 'review-change',
  });

  expect(state([]).runStatus).toBe('replaying');
  expect(state([]).summary).not.toContain('finished');
  expect(state([{ kind: 'run.cancelling', sequence: 1 }]).runStatus).toBe('cancelling');
  expect(state([{ kind: 'run.failed', sequence: 1 }]).runStatus).toBe('failed');
  expect(state([{ kind: 'run.cancelled', sequence: 1 }]).runStatus).toBe('cancelled');
  expect(state([{ kind: 'run.completed', sequence: 1 }]).runStatus).toBe('completed');
});

it('rejects stale observer and canonical-read updates after a replacement lifecycle begins', () => {
  const initial = createEvalRunLifecycle();
  const admitting = replaceEvalRunLifecycle(initial);
  const first = admitEvalRunLifecycle(admitting, { ...runRecord, completedAt: undefined, summary: undefined });
  const firstToken = evalRunLifecycleToken(first);
  const replacement = replaceEvalRunLifecycle(first, '20260817t000000001z-abcdef02');

  const stale = updateEvalRunLifecycle(replacement, firstToken, {
    events: [{ kind: 'run.failed', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }],
    result,
  });

  expect(stale).toBe(replacement);
  expect(replacement.events).toEqual([]);
  expect(replacement.result).toBeUndefined();
  expect(replacement.runId).toBe('20260817t000000001z-abcdef02');
});

it('surfaces configuration diagnostics beside the suites they came from', () => {
  const view = evalRunViewFor({
    listing: {
      diagnostics: [{
        code: 'AB9000',
        message: 'Model-backed eval semantic grader configuration is not supported yet and was ignored.',
        severity: 'warning',
      }],
      suites: listing.suites,
    },
    result: undefined,
    selectedSuite: undefined,
  });

  expect(view.diagnostics).toMatchObject([{ code: 'AB9000' }]);
});

it('builds a run selection only from a selected suite and a valid trial count', () => {
  const view = evalRunViewFor({ listing, result: undefined, selectedSuite: 'review-change' });

  expect(evalRunSelectionFor(view, '')).toEqual({ suites: ['review-change'] });
  expect(evalRunSelectionFor(view, '3')).toEqual({ suites: ['review-change'], trials: 3 });
  expect(evalRunSelectionFor(view, '0')).toBeUndefined();
  expect(evalRunSelectionFor(view, '101')).toBeUndefined();
  expect(evalRunSelectionFor(view, 'two')).toBeUndefined();
  expect(evalRunSelectionFor(
    evalRunViewFor({ listing: { diagnostics: [], suites: [] }, result: undefined, selectedSuite: undefined }),
    '1',
  )).toBeUndefined();
});

it('retains a bounded exact event timeline without silently accepting a conflicting sequence', () => {
  const one = { kind: 'run.started', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' };
  const two = { kind: 'trial.completed', payload: {}, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' };

  const merged = mergeEvalEvents([one], [one, two]);
  const conflict = mergeEvalEvents([one], [{ ...one, kind: 'run.failed' }]);

  expect(merged.events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(merged.cursor).toBe(2);
  expect(merged.discardedThroughSequence).toBeUndefined();
  expect(conflict.conflictSequence).toBe(1);
  expect(Object.isFrozen(merged.events)).toBe(true);
});

it('retains the newest durable cursor even when a hostilely large event cannot fit the view budget', () => {
  const oversized = {
    kind: 'trial.completed',
    payload: 'x'.repeat(maximumEvalTimelineBytes + 1),
    sequence: 1,
    timestamp: '2026-08-17T00:00:00.000Z',
  };

  const merged = mergeEvalEvents([], [oversized]);

  expect(merged.cursor).toBe(1);
  expect(merged.events).toEqual([]);
  expect(merged.discardedThroughSequence).toBe(1);
});

it('reports the durable sequence discarded by the event-count bound', () => {
  const events = Array.from({ length: 513 }, (_, index) => ({
    kind: index === 512 ? 'run.completed' : 'trial.completed',
    payload: {},
    sequence: index + 1,
    timestamp: '2026-08-17T00:00:00.000Z',
  }));

  const merged = mergeEvalEvents([], events);

  expect(merged.cursor).toBe(513);
  expect(merged.events).toHaveLength(512);
  expect(merged.events[0]?.sequence).toBe(2);
  expect(merged.discardedThroughSequence).toBe(1);
});
