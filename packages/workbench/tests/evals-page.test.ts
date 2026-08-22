import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { EvalRunResult, EvalSuiteListing } from '../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunRecord, EvalTrialRecord } from '../../agent-bundle/src/eval/run-store.ts';
import { EvalClient } from '../src/evals/eval-client.ts';
import { evalRunSelectionFor, evalRunViewFor } from '../src/evals/evals-model.ts';
import {
  beginEvalCancellation,
  evalArtifactPresentationKey,
  EvalRunControls,
  EvalRunReport,
  EvalsPage,
  observeEvalRunEvents,
  openEvalRun,
  prepareEvalArtifactDisplay,
  startEvalRun,
} from '../src/evals/evals-page.tsx';
import { makeRunRecord, makeTrialRecord } from './support/eval-records.ts';

const targetDigest = 'c'.repeat(64);

const listing: EvalSuiteListing = {
  diagnostics: [],
  suites: [{
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
        assertions: [{ id: 'skill-activation:0123456789abcdef', kind: 'skill-activation' }],
        digest: 'e'.repeat(64),
        hosts: ['portable'],
        id: 'unbound-activation',
        invocation: { mode: 'explicit', skill: 'review' },
        prompt: 'Invoke the review Skill.',
        trials: 1,
      },
    ],
    digest: 'd'.repeat(64),
    name: 'review-change',
    sourcePath: 'evals/review.eval.ts',
  }],
};

const runRecord: EvalRunRecord = makeRunRecord();

const trial = (overrides: Partial<EvalTrialRecord>): EvalTrialRecord => makeTrialRecord({
  assertions: [{
    assertionId: 'outcome:0123456789abcdef',
    detail: 'The fixture recorded risk high.',
    evidence: 'observed',
    kind: 'outcome',
    outcome: 'pass',
  }],
  provenance: {
    hostCliVersion: '2.1.232',
    invocation: { mode: 'automatic' },
    semanticGrader: null,
  },
  usage: { inputTokens: 9, outputTokens: 3 },
  ...overrides,
});

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

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

const view = (result_: EvalRunResult | undefined) =>
  evalRunViewFor({ listing, result: result_, selectedSuite: 'review-change' });

it('renders each trial outcome with the exact target digest of the artifact it exercised', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('Passed');
  expect(markup).toContain('Failed');
  expect(markup).toContain('Inconclusive');
  expect(markup).toContain(targetDigest);
  expect(markup).toContain('portable-1-activation');
  expect(markup).toContain('The fixture did not record risk low.');
  expect(markup).toContain('EVAL_PLUGIN_ASSERTION_FAILED');
  expect(markup).toContain('Host CLI version');
  expect(markup).toContain('2.1.232');
  expect(markup).toContain('Invocation');
  expect(markup).toContain('automatic');
  expect(markup).toContain('Recorded usage');
  expect(markup).toContain('9 input tokens · 3 output tokens');
});

it('presents an inconclusive trial distinctly from a failing trial', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('eval-outcome eval-outcome-inconclusive');
  expect(markup).toContain('eval-outcome eval-outcome-fail');
  expect(markup).toContain('eval-outcome eval-outcome-pass');
  expect(markup).toContain('recorded no defect');
  expect(markup).toContain('requires at least');
});

it('summarizes passed, failed, and inconclusive counts separately', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(result) }));

  expect(markup).toContain('1 passed');
  expect(markup).toContain('1 failed');
  expect(markup).toContain('1 inconclusive');
});

it('renders the persisted timeline, server evidence channels, host/model matrix, and raw evidence controls', () => {
  const evidenceResult: EvalRunResult = {
    ...result,
    trials: [trial({
      evidence: {
        ...trial({}).evidence,
        scripts: {
          level: 'observed',
          results: { review: { detail: 'Matched the expected risk.', outcome: 'pass' } },
        },
      },
    })],
  };
  const evidenceView = evalRunViewFor({
    events: [
      { kind: 'run.started', payload: { trials: 3 }, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' },
      { kind: 'trial.completed', payload: { outcome: 'pass' }, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' },
    ],
    listing,
    result: evidenceResult,
    selectedSuite: 'review-change',
  });

  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: evidenceView }));

  expect(markup).toContain('Durable event timeline');
  expect(markup).toContain('#1');
  expect(markup).toContain('run.started');
  expect(markup).toContain('Host / model matrix');
  expect(markup).toContain('Evidence channels');
  expect(markup).toContain('unavailable evidence');
  expect(markup).toContain('Matched the expected risk.');
  expect(markup).toContain('Raw evidence');
  expect(markup).toContain('evidence.json');
});

it('labels a bounded timeline when earlier durable events are not shown', () => {
  const bounded = evalRunViewFor({
    discardedThroughSequence: 12,
    events: [{ kind: 'run.completed', payload: {}, sequence: 13, timestamp: '2026-08-17T00:00:01.000Z' }],
    listing,
    result,
    selectedSuite: 'review-change',
  });

  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: bounded }));

  expect(markup).toContain('Earlier durable events through #12 are not shown');
});

it('does not claim that no persisted event exists when every event exceeded the view bound', () => {
  const bounded = evalRunViewFor({
    discardedThroughSequence: 1,
    events: [],
    listing,
    result,
    selectedSuite: 'review-change',
  });

  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: bounded }));

  expect(markup).toContain('Earlier durable events through #1 are not shown');
  expect(markup).not.toContain('No persisted event is available for this run.');
});

it('keys raw artifact state by run identity and creates no URL when safe-text decoding fails', async () => {
  expect(evalArtifactPresentationKey('run-a', 'artifacts/trial/evidence.json'))
    .not.toBe(evalArtifactPresentationKey('run-b', 'artifacts/trial/evidence.json'));
  let createCalls = 0;

  await expect(prepareEvalArtifactDisplay({
    blob: new Blob([new Uint8Array([0xff])], { type: 'text/plain' }),
    filename: 'evidence.txt',
    mediaType: 'text/plain',
  }, true, () => {
    createCalls += 1;
    return 'blob:should-not-exist';
  })).rejects.toBeInstanceOf(TypeError);
  expect(createCalls).toBe(0);
});

it('stops at a terminal replay and exposes torn or malformed observation instead of retrying forever', async () => {
  let streamCalls = 0;
  await observeEvalRunEvents({
    client: {
      events: async () => ({
        cursor: { afterSequence: 1 },
        events: [{ kind: 'run.completed', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:01.000Z' }],
      }),
      stream: () => {
        streamCalls += 1;
        return { close: () => undefined, done: Promise.resolve() };
      },
    },
    onEvents: () => undefined,
    runId: runRecord.id,
    signal: new AbortController().signal,
    wait: async () => undefined,
  });
  expect(streamCalls).toBe(0);

  await expect(observeEvalRunEvents({
    client: {
      events: async () => ({ cursor: { afterSequence: 0 }, events: [], incompleteTrailingRecord: true }),
      stream: () => ({ close: () => undefined, done: Promise.resolve() }),
    },
    onEvents: () => undefined,
    runId: runRecord.id,
    signal: new AbortController().signal,
    wait: async () => undefined,
  })).rejects.toThrow('Persisted eval events could not be read.');
});

it('reconnects a cleanly ended stream from the last cursor but treats stream rejection as fatal', async () => {
  const replayCursors: number[] = [];
  const streamCursors: number[] = [];
  let replayCount = 0;
  await observeEvalRunEvents({
    client: {
      events: async (_runId, afterSequence) => {
        replayCursors.push(afterSequence);
        replayCount += 1;
        return replayCount === 1
          ? { cursor: { afterSequence: 1 }, events: [{ kind: 'run.started', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }] }
          : { cursor: { afterSequence: 2 }, events: [{ kind: 'run.completed', payload: {}, sequence: 2, timestamp: '2026-08-17T00:00:01.000Z' }] };
      },
      stream: ({ afterSequence }) => {
        streamCursors.push(afterSequence);
        return { close: () => undefined, done: Promise.resolve() };
      },
    },
    onEvents: () => undefined,
    runId: runRecord.id,
    signal: new AbortController().signal,
    wait: async () => undefined,
  });
  expect(replayCursors).toEqual([0, 1]);
  expect(streamCursors).toEqual([1]);

  await expect(observeEvalRunEvents({
    client: {
      events: async () => ({ cursor: { afterSequence: 0 }, events: [] }),
      stream: () => ({ close: () => undefined, done: Promise.reject(new Error('malformed frame')) }),
    },
    onEvents: () => undefined,
    runId: runRecord.id,
    signal: new AbortController().signal,
    wait: async () => undefined,
  })).rejects.toThrow('malformed frame');
});

it('lists the cases of the selected suite before any run exists', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: view(undefined) }));

  expect(markup).toContain('reads-result');
  expect(markup).toContain('unbound-activation');
  expect(markup).toContain('Report the highest-risk regression.');
  expect(markup).toContain('explicit · review');
  expect(markup).toContain('Select an authored suite');
  expect(markup).toContain('aria-label="Cases table scroll region"');
  expect(markup).toContain('tabindex="0"');
});

it('renders unsupported configuration diagnostics as a visible alert', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, {
    view: evalRunViewFor({
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
    }),
  }));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('AB9000');
  expect(markup).toContain('not supported yet');
});

it('renders the suite, trial, and recorded run controls of a project that declares suites', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunControls, {
    busy: false,
    harness: 'deterministic',
    onCancelRun: () => undefined,
    onHarnessChange: () => undefined,
    onOpenRun: () => undefined,
    onSelectRun: () => undefined,
    onSelectSuite: () => undefined,
    onStartRun: () => undefined,
    onTrialsChange: () => undefined,
    openableRun: runRecord.id,
    recorded: [runRecord],
    runnable: true,
    trials: '2',
    view: view(undefined),
  }));

  expect(markup).toContain('id="eval-suite"');
  expect(markup).toContain('id="eval-trials"');
  expect(markup).toContain('id="eval-run"');
  expect(markup).toContain('Run deterministic suite');
  expect(markup).toContain('Open recorded run');
  expect(markup).toContain('evals/review.eval.ts');
});

it('renders a closed harness selector, keeps authored model pins read-only, and offers cancellation only for an active run', () => {
  const admitted: EvalRunRecord = { ...runRecord, completedAt: undefined, summary: undefined };
  const activeView = evalRunViewFor({
    admittedRun: admitted,
    events: [{ kind: 'trial.started', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }],
    listing,
    result: undefined,
    selectedSuite: 'review-change',
  });
  const markup = renderToStaticMarkup(createElement(EvalRunControls, {
    busy: false,
    harness: 'codex',
    onCancelRun: () => undefined,
    onHarnessChange: () => undefined,
    onOpenRun: () => undefined,
    onSelectRun: () => undefined,
    onSelectSuite: () => undefined,
    onStartRun: () => undefined,
    onTrialsChange: () => undefined,
    openableRun: runRecord.id,
    recorded: [runRecord],
    runnable: true,
    trials: '2',
    view: activeView,
  }));

  expect(markup).toContain('id="eval-harness"');
  expect(markup).toContain('Deterministic');
  expect(markup).toContain('Claude');
  expect(markup).toContain('Codex');
  expect(markup).toContain('Authored model pins are read-only');
  expect(markup).toContain('Cancel run');
});

it('renders an admitted run state and its durable replay before trial records refresh', () => {
  const admitted: EvalRunRecord = { ...runRecord, completedAt: undefined, summary: undefined };
  const activeView = evalRunViewFor({
    admittedRun: admitted,
    events: [{ kind: 'run.started', payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }],
    listing,
    result: undefined,
    selectedSuite: 'review-change',
  });
  const markup = renderToStaticMarkup(createElement(EvalRunReport, { view: activeView }));

  expect(markup).toContain(`Run ${runRecord.id} is queued.`);
  expect(markup).toContain('Durable event timeline');
  expect(markup).toContain('run.started');
});

it('renders recorded terminal data as replaying until a durable terminal event establishes its kind', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunReport, {
    view: evalRunViewFor({ listing, result, selectedSuite: 'review-change' }),
  }));

  expect(markup).toContain('has recorded terminal results; loading durable events');
  expect(markup).not.toContain('finished:');
});

it('renders reopened durable completed, failed, cancelled, and cancelling states truthfully', () => {
  const markupFor = (kind: string | undefined): string => renderToStaticMarkup(createElement(EvalRunReport, {
    view: evalRunViewFor({
      admittedRun: kind === undefined ? { ...runRecord, completedAt: undefined, summary: undefined } : undefined,
      cancelling: kind === undefined,
      events: kind === undefined ? [] : [{ kind, payload: {}, sequence: 1, timestamp: '2026-08-17T00:00:00.000Z' }],
      listing,
      result,
      selectedSuite: 'review-change',
    }),
  }));

  expect(markupFor('run.completed')).toContain(`Run ${runRecord.id} finished:`);
  expect(markupFor('run.failed')).toContain(`Run ${runRecord.id} failed after recording`);
  expect(markupFor('run.cancelled')).toContain(`Run ${runRecord.id} was cancelled after recording`);
  expect(markupFor(undefined)).toContain(`Run ${runRecord.id} is cancelling.`);
});

it('opens one synchronous cancellation flight and permits only a new run generation to replace it', () => {
  const active = Object.freeze({ generation: 4, runId: runRecord.id });
  const replacement = Object.freeze({ generation: 5, runId: '20260817t000000001z-abcdef02' });
  const first = beginEvalCancellation(undefined, active);

  expect(first).toEqual(active);
  expect(beginEvalCancellation(first, active)).toBeUndefined();
  expect(beginEvalCancellation(first, replacement)).toEqual(replacement);
});

it('marks an invalid trial count instead of letting the run start', () => {
  const markup = renderToStaticMarkup(createElement(EvalRunControls, {
    busy: false,
    harness: 'deterministic',
    onCancelRun: () => undefined,
    onHarnessChange: () => undefined,
    onOpenRun: () => undefined,
    onSelectRun: () => undefined,
    onSelectSuite: () => undefined,
    onStartRun: () => undefined,
    onTrialsChange: () => undefined,
    openableRun: undefined,
    recorded: [],
    runnable: false,
    trials: 'two',
    view: view(undefined),
  }));

  expect(markup).toContain('aria-invalid="true"');
  expect(markup).toContain('Trials must be a whole number between 1 and 100.');
  expect(markup).toContain('Run deterministic suite</button>');
  expect(markup).not.toContain('id="eval-run"');
});

it('states that no eval evidence exists before the suites have loaded', () => {
  const client = new EvalClient({ fetch: async () => response(listing) });
  const markup = renderToStaticMarkup(createElement(EvalsPage, { client }));

  expect(markup).toContain('Looking for authored eval suites');
  expect(markup).not.toContain('id="eval-suite"');
});

it('starts a durable run from the selected suite, trial count, and closed harness only', async () => {
  const bodies: unknown[] = [];
  const client = new EvalClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({ run: { ...runRecord, completedAt: undefined, summary: undefined } }), {
        headers: { 'content-type': 'application/json' },
        status: 202,
      });
    },
  });
  const selection = evalRunSelectionFor(view(undefined), '2');
  if (selection === undefined) throw new Error('Expected a runnable selection.');

  const started = await startEvalRun(client, { ...selection, harness: 'claude' });

  expect(bodies).toEqual([{ harness: 'claude', suites: ['review-change'], trials: 2 }]);
  expect(started.run.id).toBe(runRecord.id);
  expect(started.run.completedAt).toBeUndefined();
});

it('reopens a recorded run by identifier without restarting it', async () => {
  const requests: string[] = [];
  const client = new EvalClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return response({ run: result });
    },
  });

  const reopened = await openEvalRun(client, runRecord.id);

  expect(requests).toEqual([`GET /api/evals/runs/${runRecord.id}`]);
  expect(reopened.run.summary).toEqual(runRecord.summary);
});
