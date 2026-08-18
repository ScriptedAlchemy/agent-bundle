import type { Diagnostic } from '../../../agent-bundle/src/core/diagnostics.ts';
import type {
  EvalCaseSummary,
  EvalRunResult,
  EvalSuiteListing,
  EvalSuiteSummary,
} from '../../../agent-bundle/src/dev/eval-service.ts';
import type { EvalRunEvent, EvalRunRecord, EvalTrialRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import type {
  ActivationEvidence,
  EvalAssertionKind,
  EvalAssertionOutcome,
  EvalTrialEvidence,
} from '../../../agent-bundle/src/eval/types.ts';
import type { EvalRunStart } from './eval-client.ts';

export type EvalPageState = 'empty' | 'loading' | 'ran' | 'ready';

export type EvalRunStatus = 'admitting' | 'cancelled' | 'cancelling' | 'completed' | 'failed' | 'queued' | 'replaying' | 'running';

export interface EvalSuiteOption {
  readonly cases: number;
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly sourcePath: string;
}

export interface EvalCaseRow {
  readonly assertions: number;
  readonly hosts: string;
  readonly id: string;
  readonly invocation: string;
  readonly prompt: string;
  readonly trials: number;
}

export interface EvalAssertionRow {
  readonly detail: string;
  readonly evidence: ActivationEvidence;
  readonly id: string;
  readonly kind: EvalAssertionKind;
  readonly outcome: EvalAssertionOutcome;
}

export interface EvalTrialRow {
  readonly assertions: readonly EvalAssertionRow[];
  readonly caseId: string;
  readonly durationMs: number;
  readonly evidence: EvalTrialEvidence;
  /** A harness or plugin defect; an evidence-free trial reports neither. */
  readonly failure: string | undefined;
  readonly host: string;
  readonly id: string;
  readonly model: string;
  readonly outcome: EvalAssertionOutcome;
  readonly rawArtifacts: readonly string[];
  readonly targetDigest: string;
}

export interface EvalHostModelRow {
  readonly host: string;
  readonly model: string;
  readonly outcome: EvalAssertionOutcome;
  readonly trialId: string;
}

export interface EvalOutcomeCounts {
  readonly fail: number;
  readonly inconclusive: number;
  readonly pass: number;
}

export interface EvalRunViewOptions {
  readonly admittedRun?: EvalRunRecord;
  readonly admitting?: boolean;
  /** A locally sent cancellation is visible until durable replay establishes a terminal state. */
  readonly cancelling?: boolean;
  /** The only run whose results and timeline are allowed to render. */
  readonly currentRunId?: string;
  readonly discardedThroughSequence?: number;
  readonly events?: readonly EvalRunEvent[];
  /** Associates events with a run, so a previous observer cannot leak into a replacement. */
  readonly eventsRunId?: string;
  readonly listing: EvalSuiteListing | undefined;
  readonly result: EvalRunResult | undefined;
  readonly selectedSuite: string | undefined;
}

export interface EvalRunView {
  readonly cases: readonly EvalCaseRow[];
  readonly diagnostics: readonly Diagnostic[];
  readonly discardedThroughSequence: number | undefined;
  readonly events: readonly EvalRunEvent[];
  readonly hostModels: readonly EvalHostModelRow[];
  readonly outcomes: EvalOutcomeCounts;
  readonly runId: string | undefined;
  readonly runStatus: EvalRunStatus | undefined;
  readonly selected: EvalSuiteOption | undefined;
  readonly state: EvalPageState;
  readonly suites: readonly EvalSuiteOption[];
  readonly summary: string;
  readonly trials: readonly EvalTrialRow[];
}

/** A generation-scoped durable run snapshot. Replacements must clear all old evidence synchronously. */
export interface EvalRunLifecycle {
  readonly admittedRun?: EvalRunRecord;
  readonly discardedThroughSequence?: number;
  readonly events: readonly EvalRunEvent[];
  readonly generation: number;
  readonly result?: EvalRunResult;
  readonly runId?: string;
}

export interface EvalRunLifecycleToken {
  readonly generation: number;
  readonly runId?: string;
}

const maximumTrials = 100;

const noCases: readonly EvalCaseRow[] = Object.freeze([]);

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

const noTrials: readonly EvalTrialRow[] = Object.freeze([]);

const noEvents: readonly EvalRunEvent[] = Object.freeze([]);

export const createEvalRunLifecycle = (): EvalRunLifecycle => Object.freeze({
  events: noEvents,
  generation: 0,
});

/** Starts a new admission/open lifecycle before any asynchronous work can settle. */
export const replaceEvalRunLifecycle = (
  lifecycle: EvalRunLifecycle,
  runId?: string,
  admittedRun?: EvalRunRecord,
): EvalRunLifecycle => Object.freeze({
  ...(admittedRun === undefined ? {} : { admittedRun }),
  events: noEvents,
  generation: lifecycle.generation + 1,
  ...(runId === undefined ? {} : { runId }),
});

/** Commits a successful admission into the generation that initiated it. */
export const admitEvalRunLifecycle = (
  lifecycle: EvalRunLifecycle,
  admittedRun: EvalRunRecord,
): EvalRunLifecycle => Object.freeze({
  admittedRun,
  events: noEvents,
  generation: lifecycle.generation,
  runId: admittedRun.id,
});

export const evalRunLifecycleToken = (lifecycle: EvalRunLifecycle): EvalRunLifecycleToken => Object.freeze({
  generation: lifecycle.generation,
  ...(lifecycle.runId === undefined ? {} : { runId: lifecycle.runId }),
});

/** Applies observer/read data only when it belongs to the currently rendered run generation. */
export const updateEvalRunLifecycle = (
  lifecycle: EvalRunLifecycle,
  token: EvalRunLifecycleToken,
  update: Pick<Partial<EvalRunLifecycle>, 'admittedRun' | 'discardedThroughSequence' | 'events' | 'result'>,
): EvalRunLifecycle => {
  if (lifecycle.generation !== token.generation || lifecycle.runId !== token.runId) return lifecycle;
  if (update.result !== undefined && update.result.run.id !== lifecycle.runId) return lifecycle;
  if (update.admittedRun !== undefined && update.admittedRun.id !== lifecycle.runId) return lifecycle;
  return Object.freeze({
    ...lifecycle,
    ...update,
    ...(update.events === undefined ? {} : { events: Object.freeze([...update.events]) }),
  });
};

export const maximumEvalTimelineEvents = 512;

export const maximumEvalTimelineBytes = 512 * 1024;

const timelineEncoder = new TextEncoder();

export interface EvalEventMerge {
  readonly conflictSequence?: number;
  readonly discardedThroughSequence?: number;
  readonly discontinuitySequence?: number;
  readonly cursor: number;
  readonly events: readonly EvalRunEvent[];
}

const outcomeLabels: Readonly<Record<EvalAssertionOutcome, string>> = Object.freeze({
  fail: 'Failed',
  inconclusive: 'Inconclusive',
  pass: 'Passed',
});

/** An inconclusive trial produced no evidence; it is never labelled as a failure. */
export const evalOutcomeLabel = (outcome: EvalAssertionOutcome): string => outcomeLabels[outcome];

export const evalSuiteOptionsFor = (
  suites: readonly EvalSuiteSummary[],
): readonly EvalSuiteOption[] => Object.freeze(suites
  .map((suite): EvalSuiteOption => Object.freeze({
    cases: suite.cases.length,
    key: suite.name,
    label: `${suite.name} · ${suite.cases.length} case(s) · ${suite.sourcePath}`,
    name: suite.name,
    sourcePath: suite.sourcePath,
  }))
  .sort((left, right) => left.key.localeCompare(right.key)));

export const evalCaseRowsFor = (cases: readonly EvalCaseSummary[]): readonly EvalCaseRow[] => Object.freeze(
  cases.map((entry): EvalCaseRow => Object.freeze({
    assertions: entry.assertions.length,
    hosts: entry.hosts.join(', '),
    id: entry.id,
    invocation: entry.invocation.skill === undefined
      ? entry.invocation.mode
      : `${entry.invocation.mode} · ${entry.invocation.skill}`,
    prompt: entry.prompt,
    trials: entry.trials,
  })),
);

const failureFor = (trial: EvalTrialRecord): string | undefined => {
  if (trial.harnessFailure !== undefined) {
    return `Harness failure (${trial.harnessFailure.code}) at the ${trial.harnessFailure.stage} stage: ${trial.harnessFailure.message}`;
  }
  return trial.pluginFailure === undefined
    ? undefined
    : `Plugin failure (${trial.pluginFailure.code}): ${trial.pluginFailure.message}`;
};

const evidenceFor = (evidence: EvalTrialEvidence): EvalTrialEvidence => Object.freeze({
  mcp: Object.freeze({
    calls: Object.freeze(evidence.mcp.calls.map((call) => Object.freeze({ server: call.server, tool: call.tool }))),
    level: evidence.mcp.level,
  }),
  process: Object.freeze({
    ...(evidence.process.exitCode === undefined ? {} : { exitCode: evidence.process.exitCode }),
    level: evidence.process.level,
    timedOut: evidence.process.timedOut,
  }),
  scripts: Object.freeze({
    level: evidence.scripts.level,
    results: Object.freeze(Object.fromEntries(Object.entries(evidence.scripts.results).map(([name, result]) => [name, Object.freeze({
      detail: result.detail,
      outcome: result.outcome,
    })]))),
  }),
  skillActivation: Object.freeze({
    activated: Object.freeze([...evidence.skillActivation.activated]),
    level: evidence.skillActivation.level,
  }),
});

export const evalTrialRowsFor = (
  trials: readonly EvalTrialRecord[],
): readonly EvalTrialRow[] => Object.freeze(trials.map((trial): EvalTrialRow => Object.freeze({
  assertions: Object.freeze(trial.assertions.map((assertion): EvalAssertionRow => Object.freeze({
    detail: assertion.detail,
    evidence: assertion.evidence,
    id: assertion.assertionId,
    kind: assertion.kind,
    outcome: assertion.outcome,
  }))),
  caseId: trial.caseId,
  durationMs: trial.durationMs,
  evidence: evidenceFor(trial.evidence),
  failure: failureFor(trial),
  host: trial.host,
  id: trial.id,
  model: trial.model,
  outcome: trial.outcome,
  rawArtifacts: Object.freeze([...trial.rawArtifacts]),
  targetDigest: trial.targetDigest,
})));

const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => jsonEquivalent(entry, right[index]));
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, entry], index) =>
    key === rightEntries[index]?.[0] && jsonEquivalent(entry, rightEntries[index]?.[1]));
};

const eventsEquivalent = (left: EvalRunEvent, right: EvalRunEvent): boolean =>
  left.sequence === right.sequence && left.kind === right.kind && left.schemaVersion === right.schemaVersion &&
  left.timestamp === right.timestamp && jsonEquivalent(left.payload, right.payload);

/** Keeps a bounded ordered durable timeline; equal replay duplicates are harmless, conflicts are not. */
export const mergeEvalEvents = (
  existing: readonly EvalRunEvent[],
  incoming: readonly EvalRunEvent[],
): EvalEventMerge => {
  const bySequence = new Map<number, EvalRunEvent>();
  let conflictSequence: number | undefined;
  for (const event of [...existing, ...incoming]) {
    const previous = bySequence.get(event.sequence);
    if (previous === undefined) bySequence.set(event.sequence, event);
    else if (!eventsEquivalent(previous, event)) conflictSequence ??= event.sequence;
  }
  const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  let discontinuitySequence: number | undefined;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const event = ordered[index];
    if (previous !== undefined && event !== undefined && event.sequence !== previous.sequence + 1) {
      discontinuitySequence = previous.sequence + 1;
      break;
    }
  }
  const cursor = ordered.at(-1)?.sequence ?? 0;
  const bounded: EvalRunEvent[] = [];
  let bytes = 0;
  for (const event of [...ordered].reverse()) {
    const size = timelineEncoder.encode(JSON.stringify(event)).byteLength;
    if (bounded.length >= maximumEvalTimelineEvents || bytes + size > maximumEvalTimelineBytes) break;
    bounded.push(event);
    bytes += size;
  }
  const events = Object.freeze(bounded.reverse());
  const discardedThroughSequence = events.length < ordered.length
    ? events[0]?.sequence === undefined ? cursor : events[0].sequence - 1
    : undefined;
  return Object.freeze({
    ...(conflictSequence === undefined ? {} : { conflictSequence }),
    ...(discardedThroughSequence === undefined ? {} : { discardedThroughSequence }),
    ...(discontinuitySequence === undefined ? {} : { discontinuitySequence }),
    cursor,
    events,
  });
};

const outcomeCountsFor = (trials: readonly EvalTrialRow[]): EvalOutcomeCounts => Object.freeze({
  fail: trials.filter((trial) => trial.outcome === 'fail').length,
  inconclusive: trials.filter((trial) => trial.outcome === 'inconclusive').length,
  pass: trials.filter((trial) => trial.outcome === 'pass').length,
});

const hostModelsFor = (trials: readonly EvalTrialRow[]): readonly EvalHostModelRow[] => Object.freeze(trials
  .map((trial): EvalHostModelRow => Object.freeze({
    host: trial.host,
    model: trial.model,
    outcome: trial.outcome,
    trialId: trial.id,
  }))
  .sort((left, right) => `${left.host}/${left.model}/${left.trialId}`.localeCompare(`${right.host}/${right.model}/${right.trialId}`)));

const summaryFor = (
  state: EvalPageState,
  outcomes: EvalOutcomeCounts,
  result: EvalRunResult | undefined,
  run: EvalRunRecord | undefined,
  runStatus: EvalRunStatus | undefined,
): string => {
  if (runStatus === 'admitting') return 'Admitting a durable eval run…';
  if (run !== undefined && runStatus === 'queued') return `Run ${run.id} is queued.`;
  if (run !== undefined && runStatus === 'running') return `Run ${run.id} is running.`;
  if (run !== undefined && runStatus === 'cancelling') return `Run ${run.id} is cancelling.`;
  if (run !== undefined && runStatus === 'replaying') return `Run ${run.id} has recorded terminal results; loading durable events.`;
  if (run !== undefined && result === undefined && runStatus !== undefined) {
    return `Run ${run.id} is ${runStatus}; refreshing its durable results.`;
  }
  if (state === 'loading') return 'Looking for authored eval suites…';
  if (state === 'empty') return 'This project declares no eval suites yet.';
  if (state === 'ran' && result !== undefined) {
    if (runStatus === 'cancelled') return `Run ${result.run.id} was cancelled after recording ${result.trials.length} trial(s).`;
    if (runStatus === 'failed') return `Run ${result.run.id} failed after recording ${result.trials.length} trial(s).`;
    return [
      `Run ${result.run.id} finished: ${outcomes.pass} passed, ${outcomes.fail} failed, `,
      `${outcomes.inconclusive} inconclusive across ${result.trials.length} trial(s).`,
    ].join('');
  }
  return 'Select an authored suite and choose a harness to record evidence.';
};

const runStatusFor = (
  admitting: boolean,
  cancelling: boolean,
  run: EvalRunRecord | undefined,
  events: readonly EvalRunEvent[],
): EvalRunStatus | undefined => {
  if (admitting) return 'admitting';
  if (run === undefined) return undefined;
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has('run.cancelled')) return 'cancelled';
  if (kinds.has('run.failed')) return 'failed';
  if (kinds.has('run.completed')) return 'completed';
  if (cancelling) return 'cancelling';
  if (kinds.has('run.cancelling')) return 'cancelling';
  if (kinds.has('trial.started') || kinds.has('trial.completed') || kinds.has('trial.failed') || kinds.has('trial.cancelled')) {
    return 'running';
  }
  return run.completedAt === undefined ? 'queued' : 'replaying';
};

/** Derives every Eval page section from the discovered suites and the latest run. */
export const evalRunViewFor = (options: EvalRunViewOptions): EvalRunView => {
  const suites = options.listing === undefined ? [] : evalSuiteOptionsFor(options.listing.suites);
  const selected = suites.find((option) => option.key === options.selectedSuite) ?? suites[0];
  const result = options.currentRunId === undefined || options.result?.run.id === options.currentRunId
    ? options.result
    : undefined;
  const admittedRun = options.currentRunId === undefined || options.admittedRun?.id === options.currentRunId
    ? options.admittedRun
    : undefined;
  const events = options.eventsRunId === undefined || options.eventsRunId === options.currentRunId
    ? options.events === undefined ? noEvents : Object.freeze([...options.events])
    : noEvents;
  const trials = result === undefined ? noTrials : evalTrialRowsFor(result.trials);
  const outcomes = outcomeCountsFor(trials);
  const run = admittedRun ?? result?.run;
  const runStatus = runStatusFor(options.admitting === true, options.cancelling === true, run, events);
  const state: EvalPageState = options.listing === undefined ? 'loading'
    : suites.length === 0 ? 'empty'
      : result === undefined ? 'ready' : 'ran';
  const summary = summaryFor(state, outcomes, result, run, runStatus);
  return Object.freeze({
    cases: selected === undefined || options.listing === undefined
      ? noCases
      : evalCaseRowsFor(options.listing.suites.find((suite) => suite.name === selected.name)?.cases ?? []),
    diagnostics: options.listing?.diagnostics ?? noDiagnostics,
    discardedThroughSequence: options.discardedThroughSequence,
    events,
    hostModels: hostModelsFor(trials),
    outcomes,
    runId: run?.id,
    runStatus,
    selected,
    state,
    suites,
    summary,
    trials,
  });
};

/** The browser may name a suite and a trial count; nothing else reaches the eval routes. */
export const evalRunSelectionFor = (view: EvalRunView, trials: string): EvalRunStart | undefined => {
  const suite = view.selected;
  if (suite === undefined) return undefined;
  const requested = trials.trim();
  if (requested.length === 0) return Object.freeze({ suites: Object.freeze([suite.name]) });
  if (!/^\d+$/u.test(requested)) return undefined;
  const count = Number(requested);
  if (!Number.isSafeInteger(count) || count < 1 || count > maximumTrials) return undefined;
  return Object.freeze({ suites: Object.freeze([suite.name]), trials: count });
};
