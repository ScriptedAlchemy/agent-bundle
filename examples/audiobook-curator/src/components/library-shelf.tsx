import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { InspectionReceipt } from '../curator-core.ts';
import type { InventoryReceipt, LibraryAuditReceipt, SelectionReceipt } from '../library.ts';
import { AudiobookCard } from './audiobook-card.tsx';
import { Callout, DataList, type Field } from './primitives.tsx';

type ShelfReceipt = InspectionReceipt | InventoryReceipt | LibraryAuditReceipt | SelectionReceipt;

export interface LibraryShelfProps {
  readonly receipt: ShelfReceipt;
}

const maximumCards = 20;

const remaining = (count: number): React.ReactNode => count > maximumCards
  ? <Agent.Markdown>{`_+${String(count - maximumCards)} more files retained in the structured receipt._`}</Agent.Markdown>
  : null;

const inspectionShelf = (receipt: InspectionReceipt) => (
  <>
    <DataList fields={[
      { label: 'Files', value: receipt.files.length },
      { label: 'Total bytes', value: receipt.totalBytes },
      { label: 'Root', value: receipt.root },
    ]} />
    {receipt.files.slice(0, maximumCards).map((file) => (
      <AudiobookCard file={file} key={file.path} kind="file" />
    ))}
    {remaining(receipt.files.length)}
  </>
);

const inventoryShelf = (receipt: InventoryReceipt) => (
  <>
    <DataList fields={[
      { label: 'Files', value: receipt.summary.files },
      { label: 'Total bytes', value: receipt.summary.bytes },
      { label: 'Duration seconds', value: receipt.summary.durationSeconds },
      { label: 'Probe errors', value: receipt.summary.errors },
      { label: 'Source', value: receipt.source },
    ]} />
    {receipt.files.slice(0, maximumCards).map((file) => (
      <AudiobookCard file={file} key={file.path} kind="file" />
    ))}
    {remaining(receipt.files.length)}
    {receipt.errors.length > 0
      ? <Callout tone="error">{receipt.errors.map((row) => `${row.path}: ${row.error}`).join('; ')}</Callout>
      : null}
  </>
);

const auditShelf = (receipt: LibraryAuditReceipt) => {
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
        <AudiobookCard file={file} key={file.path} kind="file" />
      ))}
      {remaining(receipt.files.length)}
      {receipt.duplicateCandidates.slice(0, 10).map((group) => (
        <Callout key={group.identityKey} tone="review">
          {`Duplicate candidate group ${group.identityKey}: ${group.files.join(', ')}. ${receipt.reviewNote}`}
        </Callout>
      ))}
      {receipt.multipartCandidates.slice(0, 10).map((group) => (
        <Callout key={`${group.directory}/${group.identityKey}`} tone="review">
          {`Multipart candidate group ${group.identityKey}: ${group.files.map((file) => `part ${String(file.part)} ${file.path}`).join(', ')}. ${receipt.reviewNote}`}
        </Callout>
      ))}
      {receipt.duplicateCandidates.length === 0 && receipt.multipartCandidates.length === 0
        ? <Callout tone="review">{receipt.reviewNote}</Callout>
        : null}
    </>
  );
};

const selectionShelf = (receipt: SelectionReceipt) => (
  <>
    <DataList fields={[
      { label: 'Source groups', value: receipt.selections.length },
      { label: 'Review required', value: receipt.selections.filter((selection) => selection.reviewRequired).length },
      ...(receipt.inventory === undefined ? [] : [{ label: 'Inventory', value: receipt.inventory }]),
    ]} />
    {receipt.selections.slice(0, maximumCards).map((selection) => (
      <React.Fragment key={selection.identityKey}>
        <Agent.Markdown>{`## Source group: ${selection.identityKey}`}</Agent.Markdown>
        <AudiobookCard file={selection.selected} kind="file" />
        <Agent.Markdown>
          {[
            `Selected because: ${selection.reason}.`,
            `Alternates: ${selection.alternates.length === 0 ? 'none' : selection.alternates.map((file) => file.path).join(', ')}`,
            `Duration spread: ${String(selection.durationSpreadSeconds)} seconds.`,
          ].join('\n\n')}
        </Agent.Markdown>
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

export const LibraryShelf = ({ receipt }: LibraryShelfProps) => {
  switch (receipt.operation) {
    case 'inspect':
      return inspectionShelf(receipt);
    case 'inventory':
      return inventoryShelf(receipt);
    case 'library-audit':
      return auditShelf(receipt);
    case 'quality-selection':
      return selectionShelf(receipt);
    default: {
      const unhandled: never = receipt;
      throw new Error(`Unhandled shelf receipt: ${JSON.stringify(unhandled)}`);
    }
  }
};
