import type { AudibleSearchReceipt } from '../audible.ts';
import type { ConvertReceipt } from '../conversion.ts';
import type { IntegrityAuditReceipt } from '../integrity-audit.ts';
import type { InventoryReceipt, SelectionReceipt } from '../library.ts';

export const inventoryHeadline = (receipt: InventoryReceipt): string =>
  `Inventoried ${receipt.summary.files} media files with ${receipt.summary.errors} retained errors.`;

export const selectionHeadline = (receipt: SelectionReceipt): string => {
  const reviewCount = receipt.selections.filter((selection) => selection.reviewRequired).length;
  return `Selected ${receipt.selections.length} source groups; ${reviewCount} require review.`;
};

export const audibleSearchHeadline = (receipt: AudibleSearchReceipt): string =>
  `Ranked ${receipt.candidates.length} Audible candidates across reviewed regions; human selection is required.`;

export const integrityAuditHeadline = (receipt: IntegrityAuditReceipt): string =>
  `Audited ${receipt.bytes} bytes with SHA-256 ${receipt.sha256}; status is ${receipt.status}.`;

export const convertHeadline = (receipt: ConvertReceipt): string =>
  receipt.status === 'planned'
    ? `Planned ${receipt.audioMode} output at ${receipt.output}; sources remain unchanged.`
    : `Converted and verified ${receipt.output}; sources remain unchanged.`;
