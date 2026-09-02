import { Agent, agent } from '@agent-bundle/runtime';
import React, { Suspense } from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { AudiobookCard } from '../../../components/audiobook-card.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { LibraryAnalysis } from '../../../components/library-analysis.js';
import { DataList } from '../../../components/primitives.js';
import type { LibraryAuditReceipt } from '../../../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).libraryAudit;

export const config = {"annotations":{"readOnlyHint":false},"description":"Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice.","exitCode":"result"};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as LibraryAuditReceipt;
  const context = await agent();
  await context.progress.report({
    completed: 0,
    message: 'Analyzing duplicate and multipart groups',
    total: 1,
  });
  return (
    <CuratorDocument
      headline={`Audited ${receipt.summary.files} library media files and found ${receipt.duplicateCandidates.length} duplicate candidate groups.`}
      receipt={receipt}
    >
      <DataList fields={[
        { label: 'Files', value: receipt.summary.files },
        { label: 'Total bytes', value: receipt.summary.bytes },
        { label: 'Missing album', value: receipt.summary.missingAlbum },
        { label: 'Missing artwork', value: receipt.summary.missingArtwork },
        { label: 'Missing author', value: receipt.summary.missingAuthor },
        { label: 'Missing chapters', value: receipt.summary.missingChapters },
        { label: 'Missing title', value: receipt.summary.missingTitle },
        { label: 'Probe failures', value: receipt.summary.probeFailures },
      ]} />
      {receipt.files.slice(0, 20).map((file) => (
        <AudiobookCard file={file} key={file.path} kind="file" />
      ))}
      {receipt.files.length > 20
        ? <Agent.Markdown>{`_+${String(receipt.files.length - 20)} more files retained in the structured receipt._`}</Agent.Markdown>
        : null}
      <Suspense fallback={<Agent.Progress completed={0} message="Analyzing duplicate and multipart groups" />}>
        <LibraryAnalysis receipt={receipt} signal={signal} />
      </Suspense>
    </CuratorDocument>
  );
}
