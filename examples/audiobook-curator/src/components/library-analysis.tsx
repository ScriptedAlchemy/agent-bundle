import { stat } from 'node:fs/promises';

import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { LibraryAuditReceipt } from '../library.ts';
import { Callout, DataList } from './primitives.tsx';

export interface LibraryAnalysisProps {
  readonly receipt: LibraryAuditReceipt;
  readonly signal: AbortSignal;
}

interface MeasuredFile {
  readonly bytes?: number;
  readonly error?: string;
  readonly path: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'File metadata is unavailable.';

const measureFiles = async (
  files: readonly string[],
  signal: AbortSignal,
): Promise<readonly MeasuredFile[]> => Promise.all(files.map(async (path) => {
  signal.throwIfAborted();
  try {
    const metadata = await stat(path);
    signal.throwIfAborted();
    return metadata.isFile()
      ? { bytes: metadata.size, path }
      : { error: 'Path is no longer a regular file.', path };
  } catch (error) {
    signal.throwIfAborted();
    return { error: errorMessage(error), path };
  }
}));

export const LibraryAnalysis = async ({ receipt, signal }: LibraryAnalysisProps) => {
  const duplicateGroups = receipt.duplicateCandidates.slice(0, 10);
  const measuredGroups = await Promise.all(duplicateGroups.map(async (group) => ({
    group,
    measured: await measureFiles(group.files, signal),
  })));
  signal.throwIfAborted();

  return (
    <>
      {measuredGroups.map(({ group, measured }) => {
        const available = measured.flatMap((file) => file.bytes === undefined ? [] : [file.bytes]);
        const unavailable = measured.filter((file) => file.error !== undefined);
        const reclaimableBytes = available.length < 2
          ? 0
          : available.reduce((total, bytes) => total + bytes, 0) - Math.max(...available);
        return (
          <React.Fragment key={group.identityKey}>
            <Agent.Markdown>{`### Duplicate analysis: ${group.identityKey}`}</Agent.Markdown>
            <DataList fields={[
              { label: 'Candidate files', value: group.files.length },
              { label: 'Measured files', value: available.length },
              { label: 'Reclaimable bytes', value: reclaimableBytes },
            ]} />
            {unavailable.length > 0
              ? (
                <Callout tone="warning">
                  {`Could not measure ${String(unavailable.length)} candidate files: ${unavailable.map((file) => `${file.path} (${file.error})`).join(', ')}. Reclaimable bytes include only files that remain measurable.`}
                </Callout>
              )
              : null}
            <Callout tone="review">
              {`Duplicate candidate group ${group.identityKey}: ${group.files.join(', ')}. ${receipt.reviewNote}`}
            </Callout>
          </React.Fragment>
        );
      })}
      {receipt.multipartCandidates.slice(0, 10).map((group) => (
        <Callout key={`${group.directory}/${group.identityKey}`} tone="review">
          {`Multipart candidate group ${group.identityKey}: ${group.files.map((file) => `part ${String(file.part)} ${file.path}`).join(', ')}. ${receipt.reviewNote}`}
        </Callout>
      ))}
      {receipt.duplicateCandidates.length === 0 && receipt.multipartCandidates.length === 0
        ? (
          <>
            <Agent.Markdown>No duplicate or multipart candidate groups were found.</Agent.Markdown>
            <Callout tone="review">{receipt.reviewNote}</Callout>
          </>
        )
        : null}
    </>
  );
};
