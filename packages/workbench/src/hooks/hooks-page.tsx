import { isAbortError, errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useRef, useState } from 'react';

import type {
  HookPlaygroundBinding,
  HookPlaygroundHook,
  HookPlaygroundReplay,
} from '../../../agent-bundle/src/contracts/hooks.ts';

import {
  parseRawJsonRecord,
  serializeJsonRecord,
  type ImmutableJsonRecord,
} from '../mcp/mcp-json-input.tsx';
import type { HookClient, HookSimulationResult } from './hook-client.ts';
import {
  hookPlaygroundViewFor,
  type HookDetailRow,
  type HookPlaygroundResult,
  type HookPlaygroundView,
} from './hooks-model.ts';
import './hooks-page.css';

export interface HookSimulationViewProps {
  readonly view: HookPlaygroundView;
}

export interface HooksPageProps {
  readonly client: HookClient;
  readonly epochId: string | undefined;
}

const draftError = 'Canonical hook input must be a JSON object.';

type CanonicalHookEvent = HookPlaygroundHook['hook']['event'];

const canonicalHookInputs: Readonly<Record<CanonicalHookEvent, ImmutableJsonRecord>> = Object.freeze({
  afterTool: Object.freeze({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: Object.freeze({}),
    toolName: 'shell',
    toolResponse: Object.freeze({}),
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  }),
  beforeTool: Object.freeze({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: Object.freeze({}),
    toolName: 'shell',
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  }),
  sessionStart: Object.freeze({
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    source: 'workbench',
    transcriptPath: '/workspace/transcript.json',
  }),
  stop: Object.freeze({
    cwd: '/workspace',
    lastAssistantMessage: 'Workbench preview completed.',
    sessionId: 'workbench-preview',
    stopHookActive: false,
    transcriptPath: '/workspace/transcript.json',
  }),
});

/** Provides one event-shaped document that can run a generated Hook without host-contract guesswork. */
export const canonicalHookInput = (event: CanonicalHookEvent): ImmutableJsonRecord => canonicalHookInputs[event];

/** Returns a runnable example only for the canonical Hook events understood by the Workbench. */
export const canonicalHookInputFor = (event: string): ImmutableJsonRecord | undefined =>
  Object.hasOwn(canonicalHookInputs, event) ? canonicalHookInputs[event as CanonicalHookEvent] : undefined;

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The hook playground request could not be completed.');

export type HookInputMode = 'fixture' | 'inline';

type HookRequestKind = 'list' | 'run';

interface HookRequest {
  readonly generation: number;
  readonly kind: HookRequestKind;
  readonly signal: AbortSignal;
}

/** Owns request cancellation and makes late completions harmless after a page epoch or run changes. */
export class HookRequestLifecycle {
  readonly #active = new Map<HookRequestKind, { readonly controller: AbortController; readonly request: HookRequest }>();
  #generation = 0;

  begin(kind: HookRequestKind): HookRequest {
    this.#active.get(kind)?.controller.abort();
    const controller = new AbortController();
    const request = Object.freeze({ generation: this.#generation, kind, signal: controller.signal });
    this.#active.set(kind, { controller, request });
    return request;
  }

  complete(request: HookRequest): void {
    if (this.#active.get(request.kind)?.request === request) this.#active.delete(request.kind);
  }

  invalidate(): void {
    this.#generation += 1;
    for (const { controller } of this.#active.values()) controller.abort();
    this.#active.clear();
  }

  isCurrent(request: HookRequest): boolean {
    return request.generation === this.#generation && !request.signal.aborted && this.#active.get(request.kind)?.request === request;
  }
}

export const runHookSimulation = async (
  client: HookClient,
  binding: HookPlaygroundBinding,
  input: ImmutableJsonRecord,
  mode: HookInputMode = 'inline',
  signal?: AbortSignal,
): Promise<HookSimulationResult> => client.simulate({
  epochId: binding.epochId,
  hook: binding.hook,
  input: mode === 'fixture' ? { fixture: input } : { inline: input },
  target: binding.target,
}, signal);

/** A saved replay carries its own epoch binding, so the page never rebinds it to the selected epoch. */
export const runHookReplay = async (
  client: HookClient,
  replay: HookPlaygroundReplay,
  signal?: AbortSignal,
): Promise<HookSimulationResult> => client.replay(replay, signal);

const DetailRows = ({ label, rows }: {
  readonly label: string;
  readonly rows: readonly HookDetailRow[];
}) => <section className="hook-detail">
  <h2>{label}</h2>
  <dl className="hook-detail-rows">
    {rows.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
  </dl>
</section>;

const JsonBlock = ({ empty, label, value }: {
  readonly empty: string;
  readonly label: string;
  readonly value: Readonly<Record<string, unknown>> | undefined;
}) => <section className="hook-detail">
  <h2>{label}</h2>
  {value === undefined
    ? <p className="empty-row">{empty}</p>
    : <pre className="hook-json"><code>{serializeJsonRecord(value)}</code></pre>}
</section>;

/** The canonical intent, host mapping, and native codec trace of the latest hook run. */
export const HookSimulationView = ({ view }: HookSimulationViewProps) => <div className="hook-simulation">
  <p className="hook-summary" role="status">{view.summary}</p>
  {view.diagnostics.length === 0 ? undefined : <div className="hook-diagnostics" role="alert">
    <h2>Hook playground diagnostics</h2>
    {view.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
      <strong>{diagnostic.code}</strong> {diagnostic.message}
      <span className="hook-diagnostic-metadata">Severity: {diagnostic.severity} · Event: {diagnostic.event} · Target: {diagnostic.target}</span>
    </p>)}
  </div>}
  {view.state !== 'simulated' ? undefined : <>
    <DetailRows label="Canonical intent" rows={view.intent} />
    <JsonBlock empty="This simulation carried no canonical input." label="Canonical input" value={view.canonicalInput} />
    <DetailRows label="Host mapping" rows={view.mapping} />
    <JsonBlock empty="The host codec produced no native input." label="Native input" value={view.nativeInput} />
    <JsonBlock empty="The host codec produced no native output." label="Native output" value={view.nativeOutput} />
    <JsonBlock empty="The emitted wrapper returned no canonical result." label="Canonical result" value={view.canonicalResult} />
  </>}
</div>;

/** Lists the hooks of one immutable epoch and runs the emitted wrapper against authored canonical input. */
export const HooksPage = ({ client, epochId }: HooksPageProps) => {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => serializeJsonRecord({}));
  const [error, setError] = useState<string>();
  const [hooks, setHooks] = useState<readonly HookPlaygroundHook[]>([]);
  const [inputMode, setInputMode] = useState<HookInputMode>('inline');
  const [listedEpochId, setListedEpochId] = useState<string>();
  const [listState, setListState] = useState<'error' | 'loading' | 'ready'>(() => epochId === undefined ? 'ready' : 'loading');
  const [result, setResult] = useState<HookPlaygroundResult>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const draftIsDirty = useRef(false);
  const lifecycle = useRef<HookRequestLifecycle>(new HookRequestLifecycle()).current;
  const currentEpochIsListed = listedEpochId === epochId;
  const view = hookPlaygroundViewFor({
    epochId,
    hooks: currentEpochIsListed ? hooks : [],
    listState: epochId === undefined ? 'ready' : currentEpochIsListed ? listState : 'loading',
    result: currentEpochIsListed ? result : undefined,
    selectedKey,
  });
  const parsed = parseRawJsonRecord(draft);

  useEffect(() => {
    if (view.selected === undefined || draftIsDirty.current) return;
    setDraft(serializeJsonRecord(canonicalHookInput(view.selected.event as CanonicalHookEvent)));
  }, [view.selected?.event]);

  useEffect(() => {
    lifecycle.invalidate();
    setBusy(false);
    setError(undefined);
    setResult(undefined);
    setListedEpochId(undefined);
    if (epochId === undefined) {
      setHooks([]);
      setListState('ready');
      return () => lifecycle.invalidate();
    }
    setHooks([]);
    setListState('loading');
    const request = lifecycle.begin('list');
    void client.list({ epochId }, request.signal).then(
      (next) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        setHooks(next);
        setListedEpochId(epochId);
        setListState('ready');
      },
      (reason) => {
        if (!lifecycle.isCurrent(request)) return;
        lifecycle.complete(request);
        if (isAbortError(reason)) return;
        setHooks([]);
        setListedEpochId(epochId);
        setListState('error');
        setError(errorMessage(reason));
      },
    );
    return () => lifecycle.invalidate();
  }, [client, epochId, lifecycle]);

  const run = async (
    action: (signal: AbortSignal) => Promise<HookSimulationResult>,
  ): Promise<void> => {
    const request = lifecycle.begin('run');
    setBusy(true);
    setError(undefined);
    try {
      const next = await action(request.signal);
      if (!lifecycle.isCurrent(request)) return;
      setResult(next);
    } catch (reason) {
      if (lifecycle.isCurrent(request) && !isAbortError(reason)) setError(errorMessage(reason));
    } finally {
      if (lifecycle.isCurrent(request)) {
        setBusy(false);
        lifecycle.complete(request);
      }
    }
  };

  const simulate = async (): Promise<void> => {
    const binding = view.selected?.binding;
    if (binding === undefined || parsed === null) return;
    await run((signal) => runHookSimulation(client, binding, parsed, inputMode, signal));
  };

  const replay = async (): Promise<void> => {
    const saved = view.replay;
    if (saved === undefined) return;
    await run((signal) => runHookReplay(client, saved, signal));
  };

  return <div className="hooks-content">
    <div className="page-heading hooks-page-heading">
      <div>
        <h1>Hooks</h1>
        <p>Choose a generated Hook, review its host mapping, and simulate a canonical event.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {view.state === 'no-epoch'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <section aria-label="Hook simulation" className="hook-controls">
          <label htmlFor="hook-binding">Hook</label>
          <select
            disabled={busy || view.hooks.length === 0}
            id="hook-binding"
            onChange={(event) => setSelectedKey(event.currentTarget.value)}
            value={view.selected?.key ?? ''}
          >
            {view.hooks.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          <fieldset className="hook-input-mode">
            <legend>Canonical input mode</legend>
            <label><input checked={inputMode === 'inline'} name="hook-input-mode" onChange={() => setInputMode('inline')} type="radio" value="inline" /> Inline JSON</label>
            <label><input checked={inputMode === 'fixture'} name="hook-input-mode" onChange={() => setInputMode('fixture')} type="radio" value="fixture" /> Fixture JSON</label>
          </fieldset>
          <label htmlFor="hook-canonical-input">Canonical input (JSON)</label>
          <textarea
            aria-describedby={parsed === null ? 'hook-canonical-input-error' : undefined}
            aria-invalid={parsed === null ? true : undefined}
            disabled={busy}
            id="hook-canonical-input"
            onChange={(event) => {
              draftIsDirty.current = true;
              setDraft(event.currentTarget.value);
            }}
            spellCheck={false}
            value={draft}
          />
          {parsed === null ? <p id="hook-canonical-input-error" role="alert">{draftError}</p> : undefined}
          <div className="hook-actions">
            <button
              disabled={busy || parsed === null || view.selected === undefined}
              onClick={() => void simulate()}
              type="button"
            >
              Run simulation
            </button>
            <button disabled={busy || view.replay === undefined} onClick={() => void replay()} type="button">
              Replay saved simulation
            </button>
          </div>
        </section>
        <HookSimulationView view={view} />
      </>}
  </div>;
};
