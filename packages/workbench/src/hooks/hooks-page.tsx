import React, { useEffect, useState } from 'react';

import type {
  HookPlaygroundBinding,
  HookPlaygroundHook,
  HookPlaygroundReplay,
} from '../../../agent-bundle/src/dev/hook-playground-service.ts';

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

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The hook playground request could not be completed.';

export const runHookSimulation = async (
  client: HookClient,
  binding: HookPlaygroundBinding,
  input: ImmutableJsonRecord,
): Promise<HookSimulationResult> => client.simulate({
  epochId: binding.epochId,
  hook: binding.hook,
  input: { inline: input },
  target: binding.target,
});

/** A saved replay carries its own epoch binding, so the page never rebinds it to the selected epoch. */
export const runHookReplay = async (
  client: HookClient,
  replay: HookPlaygroundReplay,
): Promise<HookSimulationResult> => client.replay(replay);

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
  const [result, setResult] = useState<HookPlaygroundResult>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const view = hookPlaygroundViewFor({ epochId, hooks, result, selectedKey });
  const parsed = parseRawJsonRecord(draft);

  useEffect(() => {
    let current = true;
    setError(undefined);
    setResult(undefined);
    if (epochId === undefined) {
      setHooks([]);
      return () => { current = false; };
    }
    void client.list({ epochId }).then(
      (next) => { if (current) setHooks(next); },
      (reason) => {
        if (!current) return;
        setHooks([]);
        setError(errorMessage(reason));
      },
    );
    return () => { current = false; };
  }, [client, epochId]);

  const run = async (action: () => Promise<HookSimulationResult>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await action());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const simulate = async (): Promise<void> => {
    const binding = view.selected?.binding;
    if (binding === undefined || parsed === null) return;
    await run(() => runHookSimulation(client, binding, parsed));
  };

  const replay = async (): Promise<void> => {
    const saved = view.replay;
    if (saved === undefined) return;
    await run(() => runHookReplay(client, saved));
  };

  return <div className="hooks-content">
    <div className="page-heading hooks-page-heading">
      <div>
        <h1>Hooks</h1>
        <p>Canonical intent, host mapping, and emitted wrapper execution for one immutable epoch.</p>
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
          <label htmlFor="hook-canonical-input">Canonical input (JSON)</label>
          <textarea
            aria-describedby={parsed === null ? 'hook-canonical-input-error' : undefined}
            aria-invalid={parsed === null ? true : undefined}
            disabled={busy}
            id="hook-canonical-input"
            onChange={(event) => setDraft(event.currentTarget.value)}
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
