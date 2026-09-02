import React from 'react';

import type { ConvertReceipt } from '../conversion.ts';
import type { IntegrityAuditReceipt } from '../integrity-audit.ts';
import type { ChapterReceipt, MetadataReceipt } from '../media-mutation.ts';
import { Callout, DataList, type Field } from './primitives.tsx';

export interface IntegrityAuditReportProps {
  readonly receipt: IntegrityAuditReceipt;
}

export interface MetadataIntegrityReportProps {
  readonly receipt: MetadataReceipt;
}

export interface ChapterIntegrityReportProps {
  readonly receipt: ChapterReceipt;
}

export interface ConversionIntegrityReportProps {
  readonly receipt: ConvertReceipt;
}

export const IntegrityAuditReport = ({ receipt }: IntegrityAuditReportProps) => {
  const fields: Field[] = [
    { label: 'Audit status', value: receipt.status },
    { label: 'File', value: receipt.file },
    { label: 'Bytes', value: receipt.bytes },
    { label: 'File SHA-256', value: receipt.sha256 },
    { label: 'Audio SHA-256', value: receipt.audioSha256 },
    { label: 'Codec', value: receipt.probe.codec },
    { label: 'Duration seconds', value: receipt.probe.durationSeconds },
    { label: 'Chapters', value: receipt.chapters.length },
    { label: 'Full decode', value: receipt.fullDecode },
    { label: 'Source mapping', value: receipt.sourceChapterMapping.status },
    { label: 'Defects', value: receipt.chapterIssues.length },
  ];
  const issues = [...receipt.chapterIssues, ...receipt.sourceChapterMapping.issues];
  return (
    <>
      <DataList fields={fields} />
      <Callout tone="review">
        {issues.length === 0
          ? 'Verified: hashes, probe facts, chapter structure, and requested source mapping checks passed.'
          : `Review required: ${issues.join('; ')}`}
      </Callout>
    </>
  );
};

export const MetadataIntegrityReport = ({ receipt }: MetadataIntegrityReportProps) => (
  <>
    <DataList fields={[
      { label: 'Integrity status', value: receipt.status },
      { label: 'Audio SHA-256 before', value: receipt.audioSha256Before },
      ...(receipt.audioSha256After === undefined ? [] : [{ label: 'Audio SHA-256 after', value: receipt.audioSha256After }]),
      ...(receipt.sha256After === undefined ? [] : [{ label: 'File SHA-256 after', value: receipt.sha256After }]),
      { label: 'Chapters before', value: receipt.chapterCountBefore },
      ...(receipt.chapterCountAfter === undefined ? [] : [{ label: 'Chapters after', value: receipt.chapterCountAfter }]),
      ...(receipt.streamCountAfter === undefined ? [] : [{ label: 'Streams after', value: receipt.streamCountAfter }]),
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Integrity verification is pending because this receipt is a plan.'
        : `Verified metadata keys: ${(receipt.verifiedMetadataKeys ?? []).join(', ')}. Audio hashes and chapter boundaries were preserved.`}
    </Callout>
  </>
);

export const ChapterIntegrityReport = ({ receipt }: ChapterIntegrityReportProps) => (
  <>
    <DataList fields={[
      { label: 'Integrity status', value: receipt.status },
      { label: 'Audio SHA-256 before', value: receipt.audioSha256Before },
      ...(receipt.audioSha256After === undefined ? [] : [{ label: 'Audio SHA-256 after', value: receipt.audioSha256After }]),
      ...(receipt.sha256After === undefined ? [] : [{ label: 'File SHA-256 after', value: receipt.sha256After }]),
      { label: 'Chapters before', value: receipt.chapterCountBefore },
      ...(receipt.chapterCountAfter === undefined ? [] : [{ label: 'Chapters after', value: receipt.chapterCountAfter }]),
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Integrity verification is pending because this receipt is a plan.'
        : 'Verified: chapter boundaries match the plan and all audio streams and non-chapter media state were preserved.'}
    </Callout>
  </>
);

export const ConversionIntegrityReport = ({ receipt }: ConversionIntegrityReportProps) => (
  <>
    <DataList fields={[
      { label: 'Integrity status', value: receipt.status },
      { label: 'Output', value: receipt.output },
      ...(receipt.outputSha256 === undefined ? [] : [{ label: 'Output SHA-256', value: receipt.outputSha256 }]),
      ...(receipt.audioSha256 === undefined ? [] : [{ label: 'Audio SHA-256', value: receipt.audioSha256 }]),
      ...(receipt.outputBytes === undefined ? [] : [{ label: 'Output bytes', value: receipt.outputBytes }]),
      ...(receipt.probe === undefined ? [] : [
        { label: 'Codec', value: receipt.probe.codec },
        { label: 'Duration seconds', value: receipt.probe.durationSeconds },
      ]),
      ...(receipt.durationDeltaSeconds === undefined ? [] : [{ label: 'Duration delta seconds', value: receipt.durationDeltaSeconds }]),
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Integrity verification is pending because this receipt is a conversion plan.'
        : 'Verified: the output duration and chapter mapping match the source plan; source files were preserved.'}
    </Callout>
  </>
);
