import React, { useEffect, useRef, useState } from 'react';

import { errorMessage as messageFrom, isAbortError } from '../client-helpers.ts';
import { HookRequestLifecycle } from '../hooks/hooks-page.tsx';
import {
  parseRawJsonRecord,
  serializeJsonRecord,
  type ImmutableJsonRecord,
} from '../mcp/mcp-json-input.tsx';
import { AgentDocumentStage } from '../runtime/agent-document-stage.tsx';
import {
  LifecycleStaleDigestError,
  type LifecycleClient,
  type LifecycleListResponse,
  type LifecycleReplayRequest,
  type LifecycleReplayResult,
} from './lifecycle-client.ts';
import {
  lifecycleReplaySourceFor,
  lifecyclesViewFor,
  type LifecycleDetailRow,
  type LifecyclesView,
  type LifecycleSourceMode,
} from './lifecycles-model.ts';
import './lifecycles-page.css';

export type LifecycleClientSurface = Pick<LifecycleClient, 'list' | 'replay'>;

export interface LifecyclesPageProps {
  readonly client: LifecycleClientSurface;
  /** Invalidates list and replay work when the shell observes a different compiled graph. */
  readonly manifestDigest?: string;
}

export interface LifecycleReplayViewProps {
  readonly view: LifecyclesView;
}

type StaleReplayState = Readonly<{
  readonly code: string;
  readonly message: string;
  readonly repaired: boolean;
}>;

const inputError = 'Observed native receipt must be a JSON object.';

const errorMessage = (reason: unknown): string =>
  messageFrom(reason, 'The lifecycle replay request could not be completed.');

export const runLifecycleReplay = (
  client: LifecycleClientSurface,
  request: LifecycleReplayRequest,
  signal?: AbortSignal,
): Promise<LifecycleReplayResult> => client.replay(request, signal);

const DetailRows = ({ label, rows }: Readonly<{
  readonly label: string;
  readonly rows: readonly LifecycleDetailRow[];
}>) => <section className="lifecycle-detail">
  <h2>{label}</h2>
  <dl className="lifecycle-detail-rows">
    {rows.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
  </dl>
</section>;

const JsonBlock = ({ empty, label, value }: Readonly<{
  readonly empty: string;
  readonly label: string;
  readonly value: Readonly<Record<string, unknown>> | undefined;
}>) => <section className="lifecycle-detail">
  <h2>{label}</h2>
  {value === undefined
    ? <p className="empty-row">{empty}</p>
    : <pre className="lifecycle-json"><code>{serializeJsonRecord(value as ImmutableJsonRecord)}</code></pre>}
</section>;

const DiagnosticList = ({ diagnostics, label }: Readonly<{
  readonly diagnostics: readonly Readonly<{
    readonly code: string;
    readonly event?: string;
    readonly message: string;
    readonly severity?: string;
    readonly source?: string;
    readonly target?: string;
  }>[];
  readonly label: string;
}>) => diagnostics.length === 0 ? undefined : <section className="lifecycle-diagnostics" role="alert">
  <h2>{label}</h2>
  {diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${String(index)}`}>
    <strong>{diagnostic.code}</strong> {diagnostic.message}
    <span>
      {[
        diagnostic.severity === undefined ? undefined : `Severity: ${diagnostic.severity}`,
        diagnostic.event === undefined ? undefined : `Event: ${diagnostic.event}`,
        diagnostic.target === undefined ? undefined : `Target: ${diagnostic.target}`,
        diagnostic.source === undefined ? undefined : `Source: ${diagnostic.source}`,
      ].filter((entry): entry is string => entry !== undefined).join(' · ')}
    </span>
  </p>)}
</section>;

/** Correlates native receipt provenance, canonical identity, render events, and native projection. */
export const LifecycleReplayView = ({ view }: LifecycleReplayViewProps) => {
  const replay = view.replay;
  return <div className="lifecycle-result">
    <p className="lifecycle-summary" role="status">{view.summary}</p>
    <DiagnosticList diagnostics={view.replayDiagnostics} label="Replay diagnostics" />
    {replay === undefined ? undefined : <>
      <section className={`lifecycle-provenance lifecycle-provenance--${replay.source}`} aria-label="Replay provenance">
        <strong>{replay.source === 'fixture' ? 'Fixture' : 'Observed'}</strong>
        <div>
          <h2>Deterministic replay</h2>
          <p>This is a deterministic replay from {replay.source === 'fixture' ? 'a checked-in adapter fixture' : 'a pasted observed native receipt'}; it is not evidence that {replay.canonical.provenance.host} dispatched this event.</p>
        </div>
      </section>
      <DiagnosticList diagnostics={view.resultDiagnostics} label="Replay result diagnostics" />
      <DetailRows label="Canonical identity" rows={view.canonicalRows} />
      <DetailRows label="Request context" rows={view.requestRows} />
      <JsonBlock empty="This replay carried no native input." label="Native input" value={replay.nativeInput} />
      <AgentDocumentStage events={replay.events} />
      <JsonBlock empty="This replay produced no native response." label="Native response" value={replay.nativeResponse} />
    </>}
  </div>;
};

/** Discovers compiled event lifecycles and explicitly replays native host receipts through them. */
export const LifecyclesPage = ({ client, manifestDigest }: LifecyclesPageProps) => {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => serializeJsonRecord({}));
  const [error, setError] = useState<string>();
  const [fixtureEdited, setFixtureEdited] = useState(false);
  const [list, setList] = useState<LifecycleListResponse>();
  const [listState, setListState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [result, setResult] = useState<LifecycleReplayResult>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [sourceMode, setSourceMode] = useState<LifecycleSourceMode>('fixture');
  const [stale, setStale] = useState<StaleReplayState>();
  const lifecycle = useRef(new HookRequestLifecycle()).current;
  const view = lifecyclesViewFor({ list, listState, result, selectedKey });
  const parsed = parseRawJsonRecord(draft);
  const submittedSource = lifecycleReplaySourceFor(sourceMode, fixtureEdited);

  useEffect(() => {
    lifecycle.invalidate();
    setBusy(false);
    setError(undefined);
    setList(undefined);
    setListState('loading');
    setResult(undefined);
    setSelectedKey(undefined);
    setStale(undefined);
    const request = lifecycle.begin('list');
    void client.list(request.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        setList(next);
        setListState('ready');
      },
      (reason: unknown) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        if (isAbortError(reason)) return;
        setListState('error');
        setError(errorMessage(reason));
      },
    );
    return () => lifecycle.invalidate();
  }, [client, lifecycle, manifestDigest]);

  useEffect(() => {
    const selected = view.selected;
    if (selected === undefined || selectedKey !== undefined) return;
    setSelectedKey(selected.key);
    if (selected.fixture === undefined) {
      setDraft(serializeJsonRecord({}));
      setSourceMode('observed');
    } else {
      setDraft(serializeJsonRecord(selected.fixture.native as ImmutableJsonRecord));
      setSourceMode('fixture');
    }
    setFixtureEdited(false);
  }, [selectedKey, view.selected?.key]);

  const select = (key: string): void => {
    const selected = view.options.find((option) => option.key === key);
    setSelectedKey(key);
    setResult(undefined);
    setStale(undefined);
    setError(undefined);
    if (selected?.fixture === undefined) {
      setDraft(serializeJsonRecord({}));
      setSourceMode('observed');
    } else {
      setDraft(serializeJsonRecord(selected.fixture.native as ImmutableJsonRecord));
      setSourceMode('fixture');
    }
    setFixtureEdited(false);
  };

  const chooseSource = (mode: LifecycleSourceMode): void => {
    setSourceMode(mode);
    setResult(undefined);
    setStale(undefined);
    setError(undefined);
    if (mode === 'fixture' && view.selected?.fixture !== undefined) {
      setDraft(serializeJsonRecord(view.selected.fixture.native as ImmutableJsonRecord));
      setFixtureEdited(false);
    }
  };

  const run = async (): Promise<void> => {
    const selected = view.selected;
    if (selected === undefined || parsed === null) return;
    const request = lifecycle.begin('run');
    setBusy(true);
    setError(undefined);
    try {
      const next = await runLifecycleReplay(client, {
        binding: selected.binding,
        native: parsed,
        source: submittedSource,
      }, request.signal);
      if (!lifecycle.isCurrent(request)) return;
      setResult(next);
      setStale(undefined);
    } catch (reason) {
      if (!lifecycle.isCurrent(request) || isAbortError(reason)) return;
      if (reason instanceof LifecycleStaleDigestError) {
        setStale(Object.freeze({ code: reason.code, message: reason.message, repaired: false }));
      } else {
        setError(errorMessage(reason));
      }
    } finally {
      if (lifecycle.isCurrent(request)) {
        setBusy(false);
        lifecycle.complete(request);
      }
    }
  };

  const repair = (): void => {
    lifecycle.invalidate();
    setBusy(false);
    setError(undefined);
    setListState('loading');
    setResult(undefined);
    const request = lifecycle.begin('list');
    void client.list(request.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        setList(next);
        setListState('ready');
        setStale((current) => current === undefined ? undefined : Object.freeze({ ...current, repaired: true }));
      },
      (reason: unknown) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        if (isAbortError(reason)) return;
        setListState('error');
        setError(errorMessage(reason));
      },
    );
  };

  return <div className="lifecycles-content">
    <div className="page-heading lifecycles-page-heading">
      <div>
        <p className="lifecycle-eyebrow">Host-aware replay</p>
        <h1>Lifecycles</h1>
        <p>Decode a native host receipt, execute its compiled event route, and inspect the correlated render and projection.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    <DiagnosticList diagnostics={view.listDiagnostics} label="Lifecycle availability diagnostics" />
    {stale === undefined ? undefined : <section className="lifecycle-stale" role="alert">
      <h2>Stale compiled manifest</h2>
      <p><strong>{stale.code}</strong> {stale.message}</p>
      {stale.repaired
        ? <p>The lifecycle list was refreshed. Review the preserved native input and run replay explicitly against the current manifest.</p>
        : <button disabled={busy} onClick={repair} type="button">Refresh lifecycle list</button>}
    </section>}
    {view.state === 'loading'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : view.state === 'list-error' || view.state === 'empty'
        ? <p className="empty-row" role="status">{view.summary}</p>
        : <>
          <section aria-label="Lifecycle replay" className="lifecycle-controls">
            <label htmlFor="lifecycle-binding">Lifecycle and target</label>
            <select
              disabled={busy || view.options.length === 0}
              id="lifecycle-binding"
              onChange={(event) => select(event.currentTarget.value)}
              value={view.selected?.key ?? ''}
            >
              {view.selected === undefined && selectedKey !== undefined
                ? <option value="">Previously selected lifecycle is unavailable in the current manifest</option>
                : undefined}
              {view.options.map((option) => <option key={option.key} value={option.key}>
                {option.label} · native {option.nativeEvent}
              </option>)}
            </select>
            {view.selected === undefined ? <p className="lifecycle-selection-error" role="alert">
              The refreshed manifest no longer exposes the previously selected lifecycle and target. Choose a current binding before replaying the preserved input.
            </p> : <dl className="lifecycle-selected-meta">
              <div><dt>Route</dt><dd>{view.selected.routePath}</dd></div>
              <div><dt>Native event</dt><dd>{view.selected.nativeEvent}</dd></div>
              <div><dt>Host contract</dt><dd>{view.selected.hostContractRevision}</dd></div>
            </dl>}
            <fieldset className="lifecycle-source">
              <legend>Replay source</legend>
              <label>
                <input
                  checked={sourceMode === 'fixture'}
                  disabled={busy || view.selected?.fixture === undefined}
                  name="lifecycle-source"
                  onChange={() => chooseSource('fixture')}
                  type="radio"
                />
                Checked-in adapter fixture
              </label>
              <label>
                <input
                  checked={sourceMode === 'observed'}
                  disabled={busy}
                  name="lifecycle-source"
                  onChange={() => chooseSource('observed')}
                  type="radio"
                />
                Observed native receipt
              </label>
            </fieldset>
            <p className={`lifecycle-draft-provenance lifecycle-draft-provenance--${submittedSource}`}>
              <strong>{submittedSource === 'fixture' ? 'Fixture' : 'Observed'}</strong>
              {sourceMode === 'fixture' && fixtureEdited
                ? ' Edited fixture JSON is treated as observed input.'
                : sourceMode === 'fixture'
                  ? ` ${view.selected?.fixture?.label ?? 'Checked-in adapter fixture'}`
                  : ' Pasted or edited native receipt.'}
            </p>
            <label htmlFor="lifecycle-native-input">Native receipt (JSON)</label>
            <textarea
              aria-describedby={parsed === null ? 'lifecycle-native-input-error' : undefined}
              aria-invalid={parsed === null ? true : undefined}
              disabled={busy}
              id="lifecycle-native-input"
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                if (sourceMode === 'fixture') setFixtureEdited(true);
              }}
              spellCheck={false}
              value={draft}
            />
            {parsed === null ? <p id="lifecycle-native-input-error" role="alert">{inputError}</p> : undefined}
            <button disabled={busy || parsed === null || view.selected === undefined} onClick={() => void run()} type="button">
              {busy ? 'Replaying…' : 'Run replay'}
            </button>
          </section>
          <LifecycleReplayView view={view} />
        </>}
  </div>;
};
