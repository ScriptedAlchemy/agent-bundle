import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { LibraryShelf } from '../../../components/library-shelf.js';
import type { LibraryAuditReceipt } from '../../../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).libraryAudit;

export const config = {"annotations":{"readOnlyHint":false},"description":"Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as LibraryAuditReceipt;
  return (
    <CuratorDocument
      headline={`Audited ${receipt.summary.files} library media files and found ${receipt.duplicateCandidates.length} duplicate candidate groups.`}
      receipt={receipt}
    >
      <LibraryShelf receipt={receipt} />
    </CuratorDocument>
  );
}
