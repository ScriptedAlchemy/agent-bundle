import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { InspectionReceipt } from '../curator-core.ts';
import type { InventoryReceipt, LibraryAuditReceipt, SelectionReceipt } from '../library.ts';
import { FileCard } from './audiobook-card.tsx';
import { CandidateGroupCallout } from './candidate-group-callout.tsx';
import { Callout, DataList, FileList, type Field } from './primitives.tsx';
import { fileCardModel } from './view-models.ts';

export interface InspectionShelfProps {
  readonly receipt: InspectionReceipt;
}

const maximumCards = 20;

interface RemainingFilesProps {
  readonly count: number;
}

const RemainingFiles = ({ count }: RemainingFilesProps) => count > maximumCards
  ? <Agent.Markdown>{`_+${String(count - maximumCards)} more files retained in the structured receipt._`}</Agent.Markdown>
  : null;

export const InspectionShelf = ({ receipt }: InspectionShelfProps) => (
  <>
    <DataList fields={[
      { label: 'Files', value: receipt.files.length },
      { label: 'Total bytes', value: receipt.totalBytes },
      { label: 'Root', value: receipt.root },
    ]} />
    {receipt.files.slice(0, maximumCards).map((file) => (
      <FileCard {...fileCardModel(file)} key={file.path} />
    ))}
    <RemainingFiles count={receipt.files.length} />
  </>
);

export interface InventoryShelfProps {
  readonly receipt: InventoryReceipt;
}

export const InventoryShelf = ({ receipt }: InventoryShelfProps) => (
  <>
    <DataList fields={[
      { label: 'Files', value: receipt.summary.files },
      { label: 'Total bytes', value: receipt.summary.bytes },
      { label: 'Duration seconds', value: receipt.summary.durationSeconds },
      { label: 'Probe errors', value: receipt.summary.errors },
      { label: 'Source', value: receipt.source },
    ]} />
    {receipt.files.slice(0, maximumCards).map((file) => (
      <FileCard {...fileCardModel(file)} key={file.path} />
    ))}
    <RemainingFiles count={receipt.files.length} />
    {receipt.errors.map((row, index) => (
      <Callout key={`${row.path}:${String(index)}`} tone="error">{`${row.path}: ${row.error}`}</Callout>
    ))}
  </>
);

export interface AuditShelfProps {
  readonly receipt: LibraryAuditReceipt;
}

export const AuditShelf = ({ receipt }: AuditShelfProps) => {
  const summaryFields: Field[] = [
    { label: 'Files', value: receipt.summary.files },
    { label: 'Total bytes', value: receipt.summary.bytes },
    { label: 'Missing album', value: receipt.summary.missingAlbum },
    { label: 'Missing artwork', value: receipt.summary.missingArtwork },
    { label: 'Missing author', value: receipt.summary.missingAuthor },
    { label: 'Missing chapters', value: receipt.summary.missingChapters },
    { label: 'Missing title', value: receipt.summary.missingTitle },
    { label: 'Probe failures', value: receipt.summary.probeFailures },
  ];
  return (
    <>
      <DataList fields={summaryFields} />
      {receipt.files.slice(0, maximumCards).map((file) => (
        <FileCard {...fileCardModel(file)} key={file.path} />
      ))}
      <RemainingFiles count={receipt.files.length} />
      {receipt.duplicateCandidates.slice(0, 10).map((group) => (
        <CandidateGroupCallout
          files={group.files}
          identityKey={group.identityKey}
          key={group.identityKey}
          kind="duplicate"
          reviewNote={receipt.reviewNote}
        />
      ))}
      {receipt.multipartCandidates.slice(0, 10).map((group) => (
        <CandidateGroupCallout
          files={group.files.map((file) => `part ${String(file.part)} ${file.path}`)}
          identityKey={group.identityKey}
          key={`${group.directory}/${group.identityKey}`}
          kind="multipart"
          reviewNote={receipt.reviewNote}
        />
      ))}
      {receipt.duplicateCandidates.length === 0 && receipt.multipartCandidates.length === 0
        ? <Callout tone="review">{receipt.reviewNote}</Callout>
        : null}
    </>
  );
};

export interface SelectionShelfProps {
  readonly receipt: SelectionReceipt;
}

export const SelectionShelf = ({ receipt }: SelectionShelfProps) => (
  <>
    <DataList fields={[
      { label: 'Source groups', value: receipt.selections.length },
      { label: 'Review required', value: receipt.selections.filter((selection) => selection.reviewRequired).length },
      ...(receipt.inventory === undefined ? [] : [{ label: 'Inventory', value: receipt.inventory }]),
    ]} />
    {receipt.selections.slice(0, maximumCards).map((selection) => (
      <React.Fragment key={selection.identityKey}>
        <Agent.Markdown>{`## Source group: ${selection.identityKey}`}</Agent.Markdown>
        <FileCard {...fileCardModel(selection.selected)} />
        <Agent.Markdown>{`Selected because: ${selection.reason}.`}</Agent.Markdown>
        {selection.alternates.length === 0
          ? <Agent.Markdown>Alternates: none.</Agent.Markdown>
          : (
            <>
              <Agent.Markdown>Alternates:</Agent.Markdown>
              <FileList files={selection.alternates.map((file) => file.path)} />
            </>
          )}
        <Agent.Markdown>{`Duration spread: ${String(selection.durationSpreadSeconds)} seconds.`}</Agent.Markdown>
        {selection.reviewRequired
          ? <Callout tone="review">{selection.reviewReason ?? 'The source group requires human review.'}</Callout>
          : null}
      </React.Fragment>
    ))}
    {receipt.selections.length > maximumCards
      ? <Agent.Markdown>{`_+${String(receipt.selections.length - maximumCards)} more source groups retained in the structured receipt._`}</Agent.Markdown>
      : null}
  </>
);
