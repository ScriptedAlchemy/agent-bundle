import { Mcp, lowerMcpResult } from '@agent-bundle/rsc-runtime';
import type { CallToolResult } from '@modelcontextprotocol/server';
import React from 'react';

import type { AudibleCacheReceipt, AudibleSearchReceipt, AudibleSelectionReceipt } from './audible.ts';
import type { InspectionReceipt, PrepareReceipt } from './curator-core.ts';
import type { IntegrityAuditReceipt } from './integrity-audit.ts';
import type { ConvertReceipt } from './conversion.ts';
import type { InventoryReceipt, LibraryAuditReceipt, SelectionReceipt } from './library.ts';
import type { ChapterReceipt, MetadataReceipt } from './media-mutation.ts';
import type { AcousticIdentifyReceipt, AcousticReceipt, WhisperReceipt } from './evidence.ts';

export type CuratorReceipt =
  | AcousticIdentifyReceipt
  | AcousticReceipt
  | AudibleCacheReceipt
  | AudibleSearchReceipt
  | AudibleSelectionReceipt
  | ChapterReceipt
  | MetadataReceipt
  | WhisperReceipt
  | IntegrityAuditReceipt
  | ConvertReceipt
  | InspectionReceipt
  | InventoryReceipt
  | LibraryAuditReceipt
  | PrepareReceipt
  | SelectionReceipt;

const summary = (receipt: CuratorReceipt): string => {
  switch (receipt.operation) {
    case 'audiolocate':
      return receipt.verifiedRecording ? `Audiolocate matched Audible ${receipt.asin} to the local recording.` : `Audiolocate did not match Audible ${receipt.asin}; review is required.`;
    case 'acoustic-identify':
      return receipt.verifiedRecording ? `Identified an acoustic match after ${receipt.attempts.length} candidate attempts.` : `No acoustic match after ${receipt.attempts.length} candidate attempts.`;
    case 'whisper-identity':
      return `Collected ${receipt.usableWindows} usable transcript windows; human identity review is required.`;
    case 'audible-search':
      return `Ranked ${receipt.candidates.length} Audible candidates across reviewed regions; human selection is required.`;
    case 'audible-select':
      return `Recorded human-reviewed Audible candidate ${receipt.candidateNumber}.`;
    case 'audible-cache':
      return `Cached Audible ${receipt.region}/${receipt.asin} product evidence${receipt.chapters === undefined ? ' without chapter metadata' : ' with chapter metadata'}.`;
    case 'apply-metadata':
      return receipt.status === 'planned' ? `Planned metadata for ${receipt.file}; audio remains unchanged.` : `Applied and verified metadata for ${receipt.file}.`;
    case 'apply-chapters':
      return receipt.status === 'planned' ? `Planned ${receipt.chapters.length} chapters for ${receipt.file}.` : `Applied and verified ${receipt.chapters.length} chapters for ${receipt.file}.`;
    case 'inspect':
      return `Inspected ${receipt.files.length} audio files (${receipt.totalBytes} bytes).`;
    case 'prepare':
      return receipt.applied
        ? `Prepared audiobook output at ${receipt.output}.`
        : `Planned audiobook output at ${receipt.output}; no media was changed.`;
    case 'audit':
      return `Audited ${receipt.bytes} bytes with SHA-256 ${receipt.sha256}; status is ${receipt.status}.`;
    case 'inventory':
      return `Inventoried ${receipt.summary.files} media files with ${receipt.summary.errors} retained errors.`;
    case 'library-audit':
      return `Audited ${receipt.summary.files} library media files and found ${receipt.duplicateCandidates.length} duplicate candidate groups.`;
    case 'quality-selection':
      return `Selected ${receipt.selections.length} source groups; ${receipt.selections.filter((selection) => selection.reviewRequired).length} require review.`;
    case 'convert':
      return receipt.status === 'planned'
        ? `Planned ${receipt.audioMode} output at ${receipt.output}; sources remain unchanged.`
        : `Converted and verified ${receipt.output}; sources remain unchanged.`;
  }
};

export const CuratorResult = ({ receipt }: { readonly receipt: CuratorReceipt }) => (
  <Mcp.Result structuredContent={receipt}>
    <Mcp.Text>{summary(receipt)}</Mcp.Text>
  </Mcp.Result>
);

export const renderCuratorResult = (receipt: CuratorReceipt): CallToolResult =>
  lowerMcpResult(CuratorResult({ receipt }));
