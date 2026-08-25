import { Mcp, lowerMcpResult } from '@agent-bundle/rsc-runtime';
import type { CallToolResult } from '@modelcontextprotocol/server';
import React from 'react';

import type { AuditReceipt, InspectionReceipt, PrepareReceipt } from './curator-core.js';

export type CuratorReceipt = AuditReceipt | InspectionReceipt | PrepareReceipt;

const summary = (receipt: CuratorReceipt): string => {
  switch (receipt.operation) {
    case 'inspect':
      return `Inspected ${receipt.files.length} audio files (${receipt.totalBytes} bytes).`;
    case 'prepare':
      return receipt.applied
        ? `Prepared audiobook output at ${receipt.output}.`
        : `Planned audiobook output at ${receipt.output}; no media was changed.`;
    case 'audit':
      return `Audited ${receipt.bytes} bytes with SHA-256 ${receipt.sha256}.`;
  }
};

const CuratorResult = ({ receipt }: { readonly receipt: CuratorReceipt }) => (
  <Mcp.Result structuredContent={receipt}>
    <Mcp.Text>{summary(receipt)}</Mcp.Text>
  </Mcp.Result>
);

export const renderCuratorResult = (receipt: CuratorReceipt): CallToolResult =>
  lowerMcpResult(CuratorResult({ receipt }));
