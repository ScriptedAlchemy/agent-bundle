/**
 * Trace, PR 1 minimal (#600 §6): this dev session's route invocations, newest
 * first, from the invocation backends' `history` and `subscribe`; every row
 * deep-links to the route workspace with that invocation loaded
 * (`/routes/…?invocation=<id>`), and `/trace/<id>` shows one entry. PR 2
 * replaces this with the unified trace over the execution kernel; the module
 * stays small on purpose.
 */
import React, { useEffect, useState } from 'react';

import type { RouteInvocation, RouteInvocationSummary } from '../../../agent-bundle/src/contracts/invocations.ts';
import { applicationLeaves, type ApplicationTree } from '../application/application-tree-model.ts';
import type { InvocationBackend } from '../application/invocation-backend.ts';
import { errorMessage, isAbortError } from '../client-helpers.ts';
import { applicationNodeRefForRouteId, formatWorkbenchLocation, type WorkbenchLocation } from '../shell/workbench-location.ts';

export interface TracePageProps {
  readonly backends: readonly InvocationBackend[];
  /** `/trace/<id>`: show this one entry instead of the table. */
  readonly invocationId?: string;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly tree: ApplicationTree;
}

const completedAtMillis = (summary: RouteInvocationSummary): number => {
  const completed = Date.parse(summary.completedAt);
  return Number.isNaN(completed) ? Date.parse(summary.startedAt) : completed;
};

/** Newest first; ties keep the id order stable. */
export const sortTraceEntries = (entries: readonly RouteInvocationSummary[]): readonly RouteInvocationSummary[] =>
  Object.freeze([...entries].sort((left, right) => completedAtMillis(right) - completedAtMillis(left) || left.id.localeCompare(right.id)));

/** Merges by id (a later summary for the same id wins) and re-sorts. */
export const mergeTraceEntries = (
  existing: readonly RouteInvocationSummary[],
  incoming: readonly RouteInvocationSummary[],
): readonly RouteInvocationSummary[] => {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return sortTraceEntries([...byId.values()]);
};

/** Wall-clock duration of an invocation, falling back to its recorded phase timings. */
export const traceDurationMs = (summary: RouteInvocationSummary): number => {
  const started = Date.parse(summary.startedAt);
  const completed = Date.parse(summary.completedAt);
  if (!Number.isNaN(started) && !Number.isNaN(completed) && completed >= started) return completed - started;
  return summary.timings.reduce((total, timing) => total + timing.durationMs, 0);
};

/** The workspace deep link for an entry, or undefined when its route id is not an application node. */
export const traceEntryLocation = (summary: RouteInvocationSummary): WorkbenchLocation | undefined => {
  const node = applicationNodeRefForRouteId(summary.routeId);
  return node === undefined ? undefined : Object.freeze({ area: 'application', invocationId: summary.id, node });
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const formatTime = (value: string): string => {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? value : timeFormat.format(new Date(millis));
};

const formatDuration = (millis: number): string => millis < 1000 ? `${String(Math.round(millis))} ms` : `${(millis / 1000).toFixed(2)} s`;

interface TraceState {
  readonly entries: readonly RouteInvocationSummary[];
  readonly error?: string;
  readonly loading: boolean;
}

export interface TraceHistory {
  readonly entries: readonly RouteInvocationSummary[];
  /** The first non-abort failure among the per-leaf history reads, when any. */
  readonly error?: string;
}

/**
 * Every invocable leaf's history from the backends that accept it, merged by
 * id so a leaf with history on both backends lists each invocation once. One
 * failed read degrades to a message rather than hiding the rest.
 */
export const loadTraceHistory = async (
  backends: readonly InvocationBackend[],
  tree: ApplicationTree,
  signal?: AbortSignal,
): Promise<TraceHistory> => {
  const leaves = applicationLeaves(tree).filter((leaf) => leaf.execution === 'invoke');
  const loads = leaves.flatMap((leaf) => backends.filter((backend) => backend.accepts(leaf)).map((backend) => backend.history(leaf, signal)));
  const results = await Promise.allSettled(loads);
  const entries = mergeTraceEntries([], results.flatMap((result) => result.status === 'fulfilled' ? [...result.value] : []));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected' && !isAbortError(result.reason));
  return Object.freeze({
    entries,
    ...(failure === undefined ? {} : { error: errorMessage(failure.reason, 'Some invocation history could not be read.') }),
  });
};

/** Loads history once per backend set and tree, then folds live completions in. */
const useTraceEntries = (backends: readonly InvocationBackend[], tree: ApplicationTree): TraceState => {
  const [state, setState] = useState<TraceState>({ entries: [], loading: true });
  useEffect(() => {
    const request = new AbortController();
    setState({ entries: [], loading: true });
    const unsubscribes = backends.map((backend) => backend.subscribe((summary) => {
      if (request.signal.aborted) return;
      setState((current) => ({ ...current, entries: mergeTraceEntries(current.entries, [summary]) }));
    }));
    void loadTraceHistory(backends, tree, request.signal).then((history) => {
      if (request.signal.aborted) return;
      setState((current) => ({
        entries: mergeTraceEntries(current.entries, history.entries),
        ...(history.error === undefined ? {} : { error: history.error }),
        loading: false,
      }));
    });
    return () => {
      request.abort();
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [backends, tree]);
  return state;
};

const EntryLink = ({ children, onNavigate, summary }: {
  readonly children: string;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly summary: RouteInvocationSummary;
}) => {
  const location = traceEntryLocation(summary);
  return location === undefined
    ? <span className="identifier">{children}</span>
    : <a className="trace-link identifier" href={formatWorkbenchLocation(location)} onClick={(event) => { event.preventDefault(); onNavigate(location); }}>{children}</a>;
};

const TraceTable = ({ entries, onNavigate }: { readonly entries: readonly RouteInvocationSummary[]; readonly onNavigate: (location: WorkbenchLocation) => void }) =>
  <div className="table-wrap trace-table"><table>
    <thead><tr><th>Time</th><th>Kind</th><th>Route</th><th>Status</th><th>Duration</th><th>Correlation</th></tr></thead>
    <tbody>{entries.map((entry) => {
      const traceLocation: WorkbenchLocation = Object.freeze({ area: 'trace', invocationId: entry.id });
      return <tr data-invocation-id={entry.id} key={entry.id}>
        <td><a className="trace-link" href={formatWorkbenchLocation(traceLocation)} onClick={(event) => { event.preventDefault(); onNavigate(traceLocation); }}>{formatTime(entry.completedAt)}</a></td>
        <td>{entry.kind}</td>
        <td><EntryLink onNavigate={onNavigate} summary={entry}>{entry.routeId}</EntryLink></td>
        <td><span className={`trace-status trace-status--${entry.status}`}>{entry.status}</span></td>
        <td>{formatDuration(traceDurationMs(entry))}</td>
        <td className="identifier">{entry.correlationId ?? '—'}</td>
      </tr>;
    })}</tbody>
  </table></div>;

const useTraceEntry = (
  backends: readonly InvocationBackend[],
  entries: readonly RouteInvocationSummary[],
  invocationId: string | undefined,
): Readonly<{ entry?: RouteInvocationSummary; error?: string; loading: boolean }> => {
  const known = entries.find((entry) => entry.id === invocationId);
  const [loaded, setLoaded] = useState<Readonly<{ entry?: RouteInvocation; error?: string; id: string }>>();
  useEffect(() => {
    if (invocationId === undefined || known !== undefined) return undefined;
    const request = new AbortController();
    void (async () => {
      let lastError: unknown = new Error('No backend knows this invocation.');
      for (const backend of backends) {
        try {
          const entry = await backend.read(invocationId, request.signal);
          if (!request.signal.aborted) setLoaded({ entry, id: invocationId });
          return;
        } catch (reason) {
          if (isAbortError(reason)) return;
          lastError = reason;
        }
      }
      if (!request.signal.aborted) setLoaded({ error: errorMessage(lastError, 'The invocation could not be read.'), id: invocationId });
    })();
    return () => request.abort();
  }, [backends, invocationId, known]);
  if (invocationId === undefined) return { loading: false };
  if (known !== undefined) return { entry: known, loading: false };
  if (loaded?.id !== invocationId) return { loading: true };
  return { ...(loaded.entry === undefined ? {} : { entry: loaded.entry }), ...(loaded.error === undefined ? {} : { error: loaded.error }), loading: false };
};

const TraceEntry = ({ entry, onNavigate }: { readonly entry: RouteInvocationSummary; readonly onNavigate: (location: WorkbenchLocation) => void }) =>
  <section className="trace-entry" data-testid="trace-entry">
    <dl>
      <div><dt>Route</dt><dd><EntryLink onNavigate={onNavigate} summary={entry}>{entry.routeId}</EntryLink></dd></div>
      <div><dt>Kind</dt><dd>{entry.kind}</dd></div>
      <div><dt>Status</dt><dd><span className={`trace-status trace-status--${entry.status}`}>{entry.status}</span></dd></div>
      <div><dt>Started</dt><dd>{formatTime(entry.startedAt)}</dd></div>
      <div><dt>Duration</dt><dd>{formatDuration(traceDurationMs(entry))}</dd></div>
      <div><dt>Correlation id</dt><dd className="identifier">{entry.correlationId ?? '—'}</dd></div>
      <div><dt>Invocation id</dt><dd className="identifier">{entry.id}</dd></div>
      <div><dt>Source</dt><dd className="identifier">{entry.source}</dd></div>
      <div><dt>Manifest</dt><dd className="identifier">{entry.manifestDigest.slice(0, 12)}</dd></div>
    </dl>
    {entry.diagnostics.length === 0 ? undefined : <ul className="trace-diagnostics">
      {entry.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${String(index)}`}>
        <span className={`severity severity--${diagnostic.severity}`}>{diagnostic.severity}</span> <span className="identifier">{diagnostic.code}</span> {diagnostic.message}
      </li>)}
    </ul>}
    {entry.timings.length === 0 ? undefined : <div className="table-wrap"><table>
      <thead><tr><th>Phase</th><th>Duration</th></tr></thead>
      <tbody>{entry.timings.map((timing) => <tr key={`${timing.phase}-${timing.startedAt}`}><td>{timing.phase}</td><td>{formatDuration(timing.durationMs)}</td></tr>)}</tbody>
    </table></div>}
  </section>;

export const TracePage = ({ backends, invocationId, onNavigate, tree }: TracePageProps) => {
  const trace = useTraceEntries(backends, tree);
  const selected = useTraceEntry(backends, trace.entries, invocationId);
  const traceRoot: WorkbenchLocation = Object.freeze({ area: 'trace' });
  return <main className="shell-page trace-page">
    <div className="shell-page-heading">
      <div>
        <h1>Trace</h1>
        <p>{invocationId === undefined
          ? `Route invocations from this dev session, newest first${trace.loading ? ' — loading history…' : ` (${String(trace.entries.length)})`}.`
          : <>One invocation. <a className="trace-link" href={formatWorkbenchLocation(traceRoot)} onClick={(event) => { event.preventDefault(); onNavigate(traceRoot); }}>All invocations</a></>}
        </p>
      </div>
    </div>
    {trace.error === undefined ? undefined : <p className="request-error" role="alert">{trace.error}</p>}
    {invocationId === undefined
      ? trace.entries.length === 0
        ? <p className="empty-row" data-testid="trace-empty">{trace.loading ? 'Loading invocation history…' : 'No route has been invoked in this dev session yet. Run one from the application tree and it appears here.'}</p>
        : <TraceTable entries={trace.entries} onNavigate={onNavigate} />
      : selected.entry !== undefined
        ? <TraceEntry entry={selected.entry} onNavigate={onNavigate} />
        : selected.loading
          ? <p className="empty-row">Loading invocation {invocationId}…</p>
          : <p className="request-error" role="alert">{selected.error ?? `Invocation ${invocationId} is not known to this dev session.`}</p>}
  </main>;
};
