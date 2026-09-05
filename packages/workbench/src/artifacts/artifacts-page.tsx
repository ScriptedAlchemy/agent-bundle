import { errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useState } from 'react';

import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../../../agent-bundle/src/contracts/artifacts.ts';

import { ArtifactClient, ArtifactClientError } from './artifact-client.ts';
import {
  artifactViewFor,
  type ArtifactTreeRow,
  type ArtifactView,
} from './artifacts-model.ts';
import './artifacts-page.css';

export interface ArtifactInspectionViewProps {
  readonly view: ArtifactView;
}

export interface ArtifactEpochDiffViewProps {
  readonly view: ArtifactView;
}

export interface ArtifactsPageProps {
  readonly client: ArtifactClient;
  readonly epochId: string | undefined;
}

export interface ArtifactInspectionResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly error?: string;
  readonly inspection?: ArtifactInspection;
}

const noDiagnostics: readonly Diagnostic[] = Object.freeze([]);

const errorMessage = (reason: unknown): string => messageFrom(reason, 'The artifact inspection request could not be completed.');

/**
 * A refused epoch reports why through its validation diagnostics, so AB8064 is a
 * renderable result rather than an opaque failure.
 */
export const inspectArtifactEpoch = async (
  client: ArtifactClient,
  epochId: string,
): Promise<ArtifactInspectionResult> => {
  try {
    return Object.freeze({ diagnostics: noDiagnostics, inspection: await client.inspect(epochId) });
  } catch (reason) {
    return Object.freeze({
      diagnostics: reason instanceof ArtifactClientError ? reason.diagnostics : noDiagnostics,
      error: errorMessage(reason),
    });
  }
};

/** The page compares an authored base against the active epoch; it never names both sides itself. */
export const compareArtifactEpochs = async (
  client: ArtifactClient,
  baseEpochId: string,
  epochId: string,
): Promise<ArtifactEpochDiff | undefined> => {
  const base = baseEpochId.trim();
  if (base.length === 0) return undefined;
  return client.diff(base, epochId);
};

const provenanceFor = (view: ArtifactView, path: string): readonly string[] =>
  view.provenance.find((entry) => entry.outputPath === path)?.sourceInputs.map((input) => input.path) ?? [];

const TreeRow = ({
  detailsOpen,
  onToggle,
  provenance,
  row,
}: {
  readonly detailsOpen: boolean;
  readonly onToggle: () => void;
  readonly provenance: readonly string[];
  readonly row: ArtifactTreeRow;
}) => {
  if (row.entry === 'directory') {
    return <tr>
      <th scope="row" style={{ paddingLeft: `${12 + row.depth * 18}px` }}>
        <span aria-hidden="true">▸</span> {row.name}
      </th>
      <td>{row.path}</td>
      <td>—</td>
      <td />
    </tr>;
  }
  return <>
    <tr>
      <th scope="row" style={{ paddingLeft: `${12 + row.depth * 18}px` }}>
        <span aria-hidden="true">·</span> {row.name}
      </th>
      <td>{row.path}</td>
      <td>{row.bytes === undefined ? '—' : `${row.bytes}`}</td>
      <td>
        <button
          aria-expanded={detailsOpen}
          onClick={onToggle}
          type="button"
        >
          {detailsOpen ? 'Hide details' : 'Details'}
        </button>
      </td>
    </tr>
    {detailsOpen
      ? <tr className="artifact-file-details">
          <td colSpan={4} style={{ paddingLeft: `${30 + row.depth * 18}px` }}>
            <dl className="artifact-detail-rows">
              <div><dt>SHA-256</dt><dd className="artifact-digest">{row.sha256 ?? '—'}</dd></div>
              <div><dt>Mode</dt><dd>{row.mode ?? '—'}</dd></div>
              <div>
                <dt>Provenance</dt>
                <dd>{provenance.length === 0 ? '—' : provenance.join(', ')}</dd>
              </div>
            </dl>
          </td>
        </tr>
      : undefined}
  </>;
};

const ArtifactTree = ({ view }: { readonly view: ArtifactView }) => {
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string): void => {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return <section className="artifact-detail">
    <h2>Emitted files</h2>
    {view.tree.length === 0
      ? <p className="empty-row">This target emitted no files.</p>
      : <table className="artifact-table">
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Path</th><th scope="col">Size</th><th scope="col">Details</th></tr>
        </thead>
        <tbody>{view.tree.map((row) => <TreeRow
          detailsOpen={openPaths.has(row.path)}
          key={row.key}
          onToggle={() => toggle(row.path)}
          provenance={provenanceFor(view, row.path)}
          row={row}
        />)}</tbody>
      </table>}
  </section>;
};

/** Epoch summary, emitted file tree, and optional per-file details. */
export const ArtifactInspectionView = ({ view }: ArtifactInspectionViewProps) => <div className="artifact-inspection">
  <p className="artifact-summary" role="status">{view.summary}</p>
  {view.diagnostics.length === 0 ? undefined : <div className="artifact-diagnostics" role="alert">
    <h2>Artifact validation diagnostics</h2>
    {view.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
      <strong>{diagnostic.code}</strong> <em>{diagnostic.severity}</em> {diagnostic.message}
      {diagnostic.target === undefined ? undefined : ` (${diagnostic.target})`}
      {diagnostic.recovery === undefined ? undefined : <span className="artifact-recovery">{diagnostic.recovery}</span>}
    </p>)}
  </div>}
  {view.state !== 'ready' ? undefined : <ArtifactTree view={view} />}
</div>;

/** The counted added, removed, changed, and unchanged files between a base epoch and the active one. */
export const ArtifactEpochDiffView = ({ view }: ArtifactEpochDiffViewProps) => <section className="artifact-detail">
  <h2>Build comparison</h2>
  {view.diff === undefined
    ? <p className="empty-row">No build comparison has been requested.</p>
    : <>
      <p className="artifact-summary" role="status">{view.diff.summary}</p>
      {view.diff.groups.map((group) => <div className="artifact-diff-group" key={group.change}>
        <h3>{group.label} ({group.count})</h3>
        {group.rows.length === 0
          ? <p className="empty-row">No files were {group.change}.</p>
          : <table className="artifact-table">
            <thead>
              <tr><th scope="col">Path</th><th scope="col">Base bytes</th><th scope="col">Candidate bytes</th></tr>
            </thead>
            <tbody>{group.rows.map((row) => <tr key={row.key}>
              <th scope="row">{row.path}</th>
              <td>{row.beforeBytes === undefined ? '—' : `${row.beforeBytes}`}</td>
              <td>{row.afterBytes === undefined ? '—' : `${row.afterBytes}`}</td>
            </tr>)}</tbody>
          </table>}
      </div>)}
    </>}
</section>;

/** Inspects one immutable published epoch as an emitted-file tree. */
export const ArtifactsPage = ({ client, epochId }: ArtifactsPageProps) => {
  const [baseDraft, setBaseDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>(noDiagnostics);
  const [diff, setDiff] = useState<ArtifactEpochDiff>();
  const [error, setError] = useState<string>();
  const [inspection, setInspection] = useState<ArtifactInspection>();
  const [selectedProjection, setSelectedProjection] = useState<string>();
  const view = artifactViewFor({ diagnostics, diff, epochId, inspection, selectedProjection });

  useEffect(() => {
    let current = true;
    setDiagnostics(noDiagnostics);
    setDiff(undefined);
    setError(undefined);
    if (epochId === undefined) {
      setInspection(undefined);
      return () => { current = false; };
    }
    void inspectArtifactEpoch(client, epochId).then((result) => {
      if (!current) return;
      setDiagnostics(result.diagnostics);
      setError(result.error);
      setInspection(result.inspection);
    });
    return () => { current = false; };
  }, [client, epochId]);

  const compare = async (): Promise<void> => {
    if (epochId === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      setDiff(await compareArtifactEpochs(client, baseDraft, epochId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div className="artifacts-content">
    <div className="page-heading artifacts-page-heading">
      <div>
        <h1>Artifact</h1>
        <p>Emitted files for the published build. Hash, mode, and provenance sit behind each file&apos;s details toggle.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {view.state === 'no-epoch'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <section aria-label="Artifact inspection" className="artifact-controls">
          <label htmlFor="artifact-projection">Host</label>
          <select
            disabled={view.projections.length === 0}
            id="artifact-projection"
            onChange={(event) => setSelectedProjection(event.currentTarget.value)}
            value={view.selected?.host ?? ''}
          >
            {view.projections.map((option) => <option key={option.key} value={option.host}>{option.label}</option>)}
          </select>
          <label htmlFor="artifact-diff-base">Earlier build ID</label>
          <input
            disabled={busy}
            id="artifact-diff-base"
            onChange={(event) => setBaseDraft(event.currentTarget.value)}
            spellCheck={false}
            value={baseDraft}
          />
          <div className="artifact-actions">
            <button disabled={busy || baseDraft.trim().length === 0} onClick={() => void compare()} type="button">
              Compare builds
            </button>
          </div>
        </section>
        <ArtifactInspectionView view={view} />
        <ArtifactEpochDiffView view={view} />
      </>}
  </div>;
};
