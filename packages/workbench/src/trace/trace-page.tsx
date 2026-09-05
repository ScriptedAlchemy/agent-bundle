/**
 * The Trace page (#600 PR 2): one correlated, live timeline of everything the
 * dev server observed the application doing. Entries arrive from `/api/trace`
 * already lowered; this page groups them, filters them, and opens the full
 * record behind each entry's `href`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { type TraceEntry, type TraceSource, type TraceStatus, traceSources } from '../../../agent-bundle/src/contracts/trace.ts';
import { ShellLink } from '../shell/shell-link.tsx';
import { parseWorkbenchLocation, type WorkbenchLocation } from '../shell/workbench-location.ts';
import { openTraceFeed, type TraceClient, type TraceFeedState } from './trace-client.ts';
import {
  filterTraceGroups,
  formatTraceDuration,
  formatTraceTime,
  groupTraceEntries,
  isEmptyTraceFilter,
  selectTraceEntry,
  selectTraceGroup,
  traceFacetsFor,
  traceKindLabel,
  traceSourceGlyph,
  type TraceFacets,
  type TraceFilter,
  type TraceGroup,
  type TraceGroupKeyKind,
} from './trace-model.ts';
import './trace-page.css';

export interface TracePageProps {
  readonly client: TraceClient;
  /** `?correlation=<id>`: show only the group holding an entry that carries this id. */
  readonly correlation?: string;
  /** A supplied snapshot keeps server/static rendering deterministic; the live feed is not opened. */
  readonly entries?: readonly TraceEntry[];
  /** `/trace/<id>`: the selected entry (a trace entry id, or a PR 1 invocation id). */
  readonly entryId?: string;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** Row timestamps' zone; the browser's when absent. Tests pass `UTC`. */
  readonly timeZone?: string;
}

const all = '';
const bottomThresholdPx = 8;

interface FilterState {
  readonly host: string;
  readonly routeId: string;
  readonly sources: ReadonlySet<TraceSource>;
  readonly status: string;
  readonly text: string;
}

const emptyFilter: FilterState = Object.freeze({ host: all, routeId: all, sources: new Set<TraceSource>(), status: all, text: all });

const isStatus = (value: string): value is TraceStatus => value === 'ok' || value === 'error' || value === 'running';

const traceFilterFor = (state: FilterState): TraceFilter => Object.freeze({
  ...(state.host === all ? {} : { host: state.host }),
  ...(state.routeId === all ? {} : { routeId: state.routeId }),
  ...(state.sources.size === 0 ? {} : { sources: state.sources }),
  ...(isStatus(state.status) ? { status: state.status } : {}),
  ...(state.text === all ? {} : { text: state.text }),
});

const groupKeyLabel = (kind: TraceGroupKeyKind): string => {
  switch (kind) {
    case 'conversationId':
      return 'conversation';
    case 'sessionId':
      return 'session';
    case 'invocationId':
      return 'invocation';
    case 'executionId':
      return 'execution';
    case 'runId':
      return 'run';
    case 'mcpRequestId':
      return 'MCP request';
    case 'correlationId':
      return 'correlation';
    case 'entry':
      return 'entry';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const groupKeyValue = (group: TraceGroup): string => {
  const separator = group.key.indexOf(':');
  return separator === -1 ? group.key : group.key.slice(separator + 1);
};

const splitHref = (href: string): readonly [string, string] => {
  const index = href.indexOf('?');
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index)];
};

const initialFeedState = (entries: readonly TraceEntry[] | undefined): TraceFeedState =>
  Object.freeze({ connected: false, entries: entries ?? [], loaded: entries !== undefined });

/** Opens the live feed once per client; a supplied snapshot short-circuits it. */
const useTraceFeed = (client: TraceClient, supplied: readonly TraceEntry[] | undefined): TraceFeedState => {
  const [state, setState] = useState<TraceFeedState>(() => initialFeedState(supplied));
  useEffect(() => {
    if (supplied !== undefined) return undefined;
    setState(initialFeedState(undefined));
    const feed = openTraceFeed({ client, onState: setState });
    return () => feed.close();
  }, [client, supplied]);
  return supplied === undefined ? state : initialFeedState(supplied);
};

const StatusPill = ({ status }: { readonly status: TraceStatus }) =>
  <span className={`trace-status trace-status--${status}`}>{status}</span>;

const FilterBar = ({ facets, filter, onChange }: {
  readonly facets: TraceFacets;
  readonly filter: FilterState;
  readonly onChange: (next: FilterState) => void;
}) => {
  const toggleSource = (source: TraceSource): void => {
    const sources = new Set(filter.sources);
    if (!sources.delete(source)) sources.add(source);
    onChange({ ...filter, sources });
  };
  const active = !isEmptyTraceFilter(traceFilterFor(filter));
  return <section aria-label="Trace filters" className="trace-filter-bar" data-testid="trace-filter-bar">
    <div aria-label="Sources" className="trace-filter-sources" role="group">
      {traceSources.map((source) => <button
        aria-pressed={filter.sources.has(source)}
        className="trace-chip"
        data-source={source}
        disabled={!facets.sources.includes(source) && !filter.sources.has(source)}
        key={source}
        onClick={() => toggleSource(source)}
        type="button"
      ><span aria-hidden="true" className={`trace-glyph trace-glyph--${source}`}>{traceSourceGlyph(source)}</span>{source}</button>)}
    </div>
    <label className="trace-filter-field"><span>Host</span>
      <select onChange={(event) => onChange({ ...filter, host: event.currentTarget.value })} value={filter.host}>
        <option value={all}>All hosts</option>
        {facets.hosts.map((host) => <option key={host} value={host}>{host}</option>)}
      </select>
    </label>
    <label className="trace-filter-field"><span>Route</span>
      <select onChange={(event) => onChange({ ...filter, routeId: event.currentTarget.value })} value={filter.routeId}>
        <option value={all}>All routes</option>
        {facets.routeIds.map((routeId) => <option key={routeId} value={routeId}>{routeId}</option>)}
      </select>
    </label>
    <label className="trace-filter-field"><span>Status</span>
      <select onChange={(event) => onChange({ ...filter, status: event.currentTarget.value })} value={filter.status}>
        <option value={all}>Any status</option>
        <option value="ok">ok</option>
        <option value="error">error</option>
        <option value="running">running</option>
      </select>
    </label>
    <label className="trace-filter-field trace-filter-text"><span>Text</span>
      <input onChange={(event) => onChange({ ...filter, text: event.currentTarget.value })} placeholder="Filter summaries…" type="search" value={filter.text} />
    </label>
    <button className="trace-clear" disabled={!active} onClick={() => onChange(emptyFilter)} type="button">Clear</button>
  </section>;
};

const GroupView = ({ correlation, group, onNavigate, selected, selectedEntryId, timeZone }: {
  readonly correlation: string | undefined;
  readonly group: TraceGroup;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly selected: boolean;
  readonly selectedEntryId: string | undefined;
  readonly timeZone: string | undefined;
}) =>
  <section
    aria-label={group.headline.summary}
    className={`trace-group trace-group--${group.status}`}
    data-group-key={group.key}
    data-selected={selected ? 'true' : undefined}
    data-testid="trace-group"
  >
    <header className="trace-group-head">
      <span className="trace-time">{formatTraceTime(group.startedAt, timeZone)}</span>
      <span aria-hidden="true" className={`trace-glyph trace-glyph--${group.headline.source}`}>{traceSourceGlyph(group.headline.source)}</span>
      <span className="trace-group-title">{group.headline.summary}</span>
      <span className="trace-group-meta">
        <span className="trace-group-key">{groupKeyLabel(group.keyKind)} <span className="identifier">{groupKeyValue(group)}</span></span>
        <span className="trace-group-count">{String(group.rows.length)} {group.rows.length === 1 ? 'entry' : 'entries'}</span>
        <StatusPill status={group.status} />
      </span>
      <span className="trace-duration">{formatTraceDuration(group.spanMs)}</span>
    </header>
    <ol className="trace-rows">
      {group.rows.map(({ depth, entry }) => {
        const status = entry.status ?? 'ok';
        return <li className={`trace-row trace-row--depth-${String(depth)} trace-row--${status}`} key={entry.id}>
          <ShellLink
            aria-current={entry.id === selectedEntryId ? 'true' : undefined}
            className="trace-line"
            data-entry-id={entry.id}
            data-kind={entry.kind}
            data-source={entry.source}
            data-status={status}
            data-testid="trace-entry"
            location={{ area: 'trace', ...(correlation === undefined ? {} : { correlation }), invocationId: entry.id }}
            onNavigate={onNavigate}
          >
            <span className="trace-time">{formatTraceTime(entry.occurredAt, timeZone)}</span>
            <span className={`trace-kind trace-kind--${entry.source}`}>
              <span aria-hidden="true" className={`trace-glyph trace-glyph--${entry.source}`}>{traceSourceGlyph(entry.source)}</span>
              {traceKindLabel(entry)}
            </span>
            <span className="trace-summary">{entry.summary}</span>
            {status === 'error' ? <span className="trace-row-flag" role="img" aria-label="error">!</span> : undefined}
            <span className="trace-duration">{entry.durationMs === undefined ? '' : formatTraceDuration(entry.durationMs)}</span>
          </ShellLink>
        </li>;
      })}
    </ol>
  </section>;

const DetailDrawer = ({ correlation, entry, onNavigate, timeZone }: {
  readonly correlation: string | undefined;
  readonly entry: TraceEntry;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly timeZone: string | undefined;
}) => {
  const status = entry.status ?? 'ok';
  const keys = Object.entries(entry.correlation).filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  const [pathname, search] = entry.href === undefined ? ['', ''] : splitHref(entry.href);
  return <aside aria-label="Trace entry" className="trace-detail" data-entry-id={entry.id} data-testid="trace-detail">
    <header className="trace-detail-head">
      <div>
        <p className="trace-detail-eyebrow"><span aria-hidden="true" className={`trace-glyph trace-glyph--${entry.source}`}>{traceSourceGlyph(entry.source)}</span> {entry.source} · <span className="identifier">{entry.kind}</span></p>
        <h2>{entry.summary}</h2>
      </div>
      <ShellLink aria-label="Close entry" className="trace-detail-close" location={{ area: 'trace', ...(correlation === undefined ? {} : { correlation }) }} onNavigate={onNavigate}>×</ShellLink>
    </header>
    <div className="trace-detail-actions">
      {entry.href === undefined
        ? <span className="trace-detail-no-route">No route record behind this entry.</span>
        : <a
            className="trace-primary-action"
            href={entry.href}
            onClick={(event) => { event.preventDefault(); onNavigate(parseWorkbenchLocation(pathname, search)); }}
          >Open route</a>}
    </div>
    <dl className="trace-detail-facts">
      <div><dt>Time</dt><dd>{formatTraceTime(entry.occurredAt, timeZone)}</dd></div>
      <div><dt>Status</dt><dd><StatusPill status={status} /></dd></div>
      <div><dt>Duration</dt><dd>{entry.durationMs === undefined ? '—' : formatTraceDuration(entry.durationMs)}</dd></div>
      <div><dt>Sequence</dt><dd className="identifier">{String(entry.sequence)}</dd></div>
      <div><dt>Entry id</dt><dd className="identifier">{entry.id}</dd></div>
    </dl>
    <h3>Correlation</h3>
    {keys.length === 0 ? <p className="empty-row">This entry carries no correlation key.</p> : <dl className="trace-detail-keys">
      {keys.map(([key, value]) => <div key={key}>
        <dt>{key}</dt>
        <dd><ShellLink className="trace-link identifier" location={{ area: 'trace', correlation: value, invocationId: entry.id }} onNavigate={onNavigate} title={`Show entries correlated by ${key}`}>{value}</ShellLink></dd>
      </div>)}
    </dl>}
    <h3>Details</h3>
    {entry.details === undefined
      ? <p className="empty-row">No details were published with this entry.</p>
      : <pre className="trace-detail-json">{JSON.stringify(entry.details, null, 2)}</pre>}
  </aside>;
};

const emptyMessage = (feed: TraceFeedState): string => {
  if (!feed.loaded) return 'Connecting to the trace…';
  return 'Nothing has been traced in this dev session yet. Run a route, call a tool in Advanced → Protocol, or invoke the plugin from a host, and it appears here.';
};

export const TracePage = ({ client, correlation, entries: suppliedEntries, entryId, onNavigate, timeZone }: TracePageProps) => {
  const feed = useTraceFeed(client, suppliedEntries);
  const [filter, setFilter] = useState<FilterState>(emptyFilter);
  const groups = useMemo(() => groupTraceEntries(feed.entries), [feed.entries]);
  const facets = useMemo(() => traceFacetsFor(feed.entries), [feed.entries]);
  const selectedEntry = entryId === undefined ? undefined : selectTraceEntry(feed.entries, entryId);
  const correlatedGroup = correlation === undefined ? undefined : selectTraceGroup(groups, correlation);
  const selectedGroup = correlatedGroup ?? (selectedEntry === undefined ? undefined : selectTraceGroup(groups, selectedEntry.id));
  const scope = correlation === undefined ? groups : correlatedGroup === undefined ? [] : [correlatedGroup];
  const visible = filterTraceGroups(scope, traceFilterFor(filter));
  const lastSequence = feed.entries.at(-1)?.sequence ?? 0;

  // New groups land at the bottom. While the user is reading further up the
  // timeline the scroll position stays put and the pill counts what arrived;
  // at the bottom the timeline follows the feed.
  const timelineRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenSequence, setSeenSequence] = useState(0);
  useEffect(() => {
    if (!atBottom) return;
    const timeline = timelineRef.current;
    if (timeline !== null) timeline.scrollTop = timeline.scrollHeight;
    setSeenSequence(lastSequence);
  }, [atBottom, lastSequence]);
  const pending = atBottom ? 0 : visible.filter((group) => group.firstSequence > seenSequence).length;
  const onScroll = (): void => {
    const timeline = timelineRef.current;
    if (timeline !== null) setAtBottom(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= bottomThresholdPx);
  };

  const heading = !feed.loaded
    ? 'Connecting…'
    : `${String(feed.entries.length)} ${feed.entries.length === 1 ? 'entry' : 'entries'} in ${String(groups.length)} ${groups.length === 1 ? 'group' : 'groups'}${feed.connected ? ' · live' : feed.error === undefined ? '' : ' · reconnecting'}`;

  return <main className={`shell-page trace-page${selectedEntry === undefined ? '' : ' trace-page--detail'}`}>
    <div className="trace-main">
      <div className="shell-page-heading trace-heading">
        <div>
          <h1>Trace</h1>
          <p>{heading}</p>
        </div>
        {correlation === undefined ? undefined : <p className="trace-scope" role="status">
          Correlated by <span className="identifier">{correlation}</span> · <ShellLink className="trace-link" location={{ area: 'trace', ...(entryId === undefined ? {} : { invocationId: entryId }) }} onNavigate={onNavigate}>Show all</ShellLink>
        </p>}
      </div>
      {feed.error === undefined ? undefined : <p className="request-error" role="alert">{feed.error}</p>}
      {feed.gap === undefined ? undefined : <p className="trace-gap" role="status">{String(feed.gap.droppedCount)} earlier {feed.gap.droppedCount === 1 ? 'entry is' : 'entries are'} no longer retained.</p>}
      <FilterBar facets={facets} filter={filter} onChange={setFilter} />
      <div className="trace-timeline-wrap">
        <div className="trace-timeline" data-testid="trace-timeline" onScroll={onScroll} ref={timelineRef}>
          {feed.entries.length === 0
            ? <p className="empty-row trace-empty" data-testid="trace-empty">{emptyMessage(feed)}</p>
            : visible.length === 0
              ? <p className="empty-row">{correlation !== undefined && correlatedGroup === undefined ? `No entry carries ${correlation}.` : 'No entry matches this filter.'}</p>
              : visible.map((group) => <GroupView
                  correlation={correlation}
                  group={group}
                  key={group.key}
                  onNavigate={onNavigate}
                  selected={group.key === selectedGroup?.key}
                  selectedEntryId={selectedEntry?.id}
                  timeZone={timeZone}
                />)}
        </div>
        {pending === 0 ? undefined : <button className="trace-new-pill" data-testid="trace-new-pill" onClick={() => setAtBottom(true)} type="button">{String(pending)} new</button>}
      </div>
    </div>
    {selectedEntry !== undefined
      ? <DetailDrawer correlation={correlation} entry={selectedEntry} onNavigate={onNavigate} timeZone={timeZone} />
      : entryId === undefined
        ? undefined
        : <aside aria-label="Trace entry" className="trace-detail" data-testid="trace-detail">
            <header className="trace-detail-head">
              <div><p className="trace-detail-eyebrow">entry</p><h2>Not in this trace</h2></div>
              <ShellLink aria-label="Close entry" className="trace-detail-close" location={{ area: 'trace', ...(correlation === undefined ? {} : { correlation }) }} onNavigate={onNavigate}>×</ShellLink>
            </header>
            <p className="empty-row">{feed.loaded ? `No retained entry is ${entryId}. It may have been published before this dev server started, or evicted from the retained window.` : 'Connecting to the trace…'}</p>
          </aside>}
  </main>;
};
