import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { LibraryShelf } from '../../../components/library-shelf.js';
import type { InspectionReceipt } from '../../../curator-core.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).inspect;

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Inspect a bounded directory tree and report supported audiobook media without changing it.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as InspectionReceipt;
  return (
    <CuratorDocument
      headline={`Inspected ${receipt.files.length} audio files (${receipt.totalBytes} bytes).`}
      receipt={receipt}
    >
      <LibraryShelf receipt={receipt} />
    </CuratorDocument>
  );
}
