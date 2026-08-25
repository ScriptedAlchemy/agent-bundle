import { errorMessage as messageFrom } from '../client-helpers.ts';
import React, { useEffect, useState } from 'react';

import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type { ArtifactEpochDiff, ArtifactInspection } from '../../../agent-bundle/src/contracts/artifacts.ts';

import { ArtifactClient, ArtifactClientError } from './artifact-client.ts';
import {
  artifactViewFor,
  type ArtifactDetailRow,
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

const DetailRows = ({ label, rows }: {
  readonly label: string;
  readonly rows: readonly ArtifactDetailRow[];
}) => <section className="artifact-detail">
  <h2>{label}</h2>
  <dl className="artifact-detail-rows">
    {rows.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
  </dl>
</section>;

const TreeRow = ({ row }: { readonly row: ArtifactTreeRow }) => <tr>
  <th scope="row" style={{ paddingLeft: `${12 + row.depth * 18}px` }}>
    <span aria-hidden="true">{row.entry === 'directory' ? '▸' : '·'}</span> {row.name}
  </th>
  <td>{row.path}</td>
  <td>{row.kind ?? 'directory'}</td>
  <td>{row.bytes === undefined ? '—' : `${row.bytes}`}</td>
  <td>{row.mode ?? '—'}</td>
  <td className="artifact-digest">{row.sha256 ?? '—'}</td>
</tr>;

/** Epoch identity, the emitted file tree, runtime metadata, and declared provenance of one epoch. */
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
  {view.state !== 'ready' ? undefined : <>
    <DetailRows label="Build identity" rows={view.identity} />
    <section className="artifact-detail">
      <h2>Artifact tree</h2>
      {view.tree.length === 0
        ? <p className="empty-row">This target emitted no files.</p>
        : <table className="artifact-table">
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Path</th><th scope="col">Kind</th><th scope="col">Bytes</th><th scope="col">Mode</th><th scope="col">SHA-256</th></tr>
          </thead>
          <tbody>{view.tree.map((row) => <TreeRow key={row.key} row={row} />)}</tbody>
        </table>}
    </section>
    <section className="artifact-detail">
      <h2>Runtime</h2>
      <h3>Hooks</h3>
      {view.hooks.length === 0
        ? <p className="empty-row">This build contains no Hooks.</p>
        : <table className="artifact-table">
          <thead>
            <tr><th scope="col">Hook</th><th scope="col">Wrapper path</th><th scope="col">Timeout</th><th scope="col">Bytes</th><th scope="col">SHA-256</th></tr>
          </thead>
          <tbody>{view.hooks.map((hook) => <tr key={hook.key}>
            <th scope="row">{hook.label}</th>
            <td>{hook.path}</td>
            <td>{hook.timeout === undefined ? '—' : `${hook.timeout}s`}</td>
            <td>{hook.bytes}</td>
            <td className="artifact-digest">{hook.sha256}</td>
          </tr>)}</tbody>
        </table>}
      <h3>MCP servers</h3>
      {view.mcpServers.length === 0
        ? <p className="empty-row">This build contains no MCP servers.</p>
        : <table className="artifact-table">
          <thead>
            <tr><th scope="col">Server</th><th scope="col">Manifest path</th><th scope="col">Entry paths</th></tr>
          </thead>
          <tbody>{view.mcpServers.map((server) => <tr key={server.key}>
            <th scope="row">{server.label}</th>
            <td>{server.manifestPath}</td>
            <td>{server.entryPaths.length === 0 ? '—' : server.entryPaths.join(', ')}</td>
          </tr>)}</tbody>
        </table>}
      <h3>Executables</h3>
      {view.executables.length === 0
        ? <p className="empty-row">This build contains no executable files.</p>
        : <table className="artifact-table">
          <thead>
            <tr><th scope="col">Path</th><th scope="col">Kind</th><th scope="col">Mode</th><th scope="col">Bytes</th><th scope="col">SHA-256</th></tr>
          </thead>
          <tbody>{view.executables.map((executable) => <tr key={executable.key}>
            <th scope="row">{executable.path}</th>
            <td>{executable.kind}</td>
            <td>{executable.mode ?? '—'}</td>
            <td>{executable.bytes}</td>
            <td className="artifact-digest">{executable.sha256}</td>
          </tr>)}</tbody>
        </table>}
    </section>
    <section className="artifact-detail">
      <h2>Provenance</h2>
      {view.provenance.length === 0
        ? <p className="empty-row">This build contains no direct source provenance.</p>
        : <table className="artifact-table">
          <thead><tr><th scope="col">Output path</th><th scope="col">Source inputs</th></tr></thead>
          <tbody>{view.provenance.map((entry) => <tr key={entry.key}>
            <th scope="row">{entry.outputPath}</th>
            <td>
              {entry.sourceInputs.length === 0 ? '—' : <ul className="artifact-source-inputs">
                {entry.sourceInputs.map((input) => <li key={input.path}>
                  {input.path} <span className="artifact-digest">{input.sha256}</span>
                </li>)}
              </ul>}
            </td>
          </tr>)}</tbody>
        </table>}
    </section>
  </>}
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
              <tr><th scope="col">Path</th><th scope="col">Base bytes</th><th scope="col">Base SHA-256</th><th scope="col">Candidate bytes</th><th scope="col">Candidate SHA-256</th></tr>
            </thead>
            <tbody>{group.rows.map((row) => <tr key={row.key}>
              <th scope="row">{row.path}</th>
              <td>{row.beforeBytes === undefined ? '—' : `${row.beforeBytes}`}</td>
              <td className="artifact-digest">{row.beforeSha256 ?? '—'}</td>
              <td>{row.afterBytes === undefined ? '—' : `${row.afterBytes}`}</td>
              <td className="artifact-digest">{row.afterSha256 ?? '—'}</td>
            </tr>)}</tbody>
          </table>}
      </div>)}
    </>}
</section>;

/** Inspects one immutable published epoch and compares it against an authored base epoch. */
export const ArtifactsPage = ({ client, epochId }: ArtifactsPageProps) => {
  const [baseDraft, setBaseDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>(noDiagnostics);
  const [diff, setDiff] = useState<ArtifactEpochDiff>();
  const [error, setError] = useState<string>();
  const [inspection, setInspection] = useState<ArtifactInspection>();
  const [selectedTarget, setSelectedTarget] = useState<string>();
  const view = artifactViewFor({ diagnostics, diff, epochId, inspection, selectedTarget });

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
        <h1>Artifacts</h1>
        <p>Inspect generated files, runtime metadata, provenance, and changes between published builds.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {view.state === 'no-epoch'
      ? <p className="empty-row" role="status">{view.summary}</p>
      : <>
        <section aria-label="Artifact inspection" className="artifact-controls">
          <label htmlFor="artifact-target">Target</label>
          <select
            disabled={view.targets.length === 0}
            id="artifact-target"
            onChange={(event) => setSelectedTarget(event.currentTarget.value)}
            value={view.selected?.name ?? ''}
          >
            {view.targets.map((option) => <option key={option.key} value={option.name}>{option.label}</option>)}
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
