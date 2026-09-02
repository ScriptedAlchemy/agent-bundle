import { Agent, type JsonValue } from '@agent-bundle/runtime';
import React, { type ReactNode } from 'react';

import type { AudibleCacheReceipt, AudibleSearchReceipt, AudibleSelectionReceipt } from '../audible.ts';
import type { ConvertReceipt } from '../conversion.ts';
import type { InspectionReceipt, PrepareReceipt } from '../curator-core.ts';
import type { AcousticIdentifyReceipt, AcousticReceipt, WhisperReceipt } from '../evidence.ts';
import type { IntegrityAuditReceipt } from '../integrity-audit.ts';
import type { InventoryReceipt, LibraryAuditReceipt, SelectionReceipt } from '../library.ts';
import type { ChapterReceipt, MetadataReceipt } from '../media-mutation.ts';

export type CuratorReceipt =
  | AcousticIdentifyReceipt
  | AcousticReceipt
  | AudibleCacheReceipt
  | AudibleSearchReceipt
  | AudibleSelectionReceipt
  | ChapterReceipt
  | ConvertReceipt
  | InspectionReceipt
  | IntegrityAuditReceipt
  | InventoryReceipt
  | LibraryAuditReceipt
  | MetadataReceipt
  | PrepareReceipt
  | SelectionReceipt
  | WhisperReceipt;

export interface CuratorDocumentProps {
  readonly children: ReactNode;
  readonly headline: string;
  readonly receipt: CuratorReceipt;
}

export const CuratorDocument = ({ children, headline, receipt }: CuratorDocumentProps) => (
  <Agent.Result value={receipt as unknown as JsonValue}>
    <Agent.Text>{headline}</Agent.Text>
    {children}
  </Agent.Result>
);
