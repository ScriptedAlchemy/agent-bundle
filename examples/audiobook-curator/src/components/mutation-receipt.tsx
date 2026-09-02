import React from 'react';

import type { ConvertReceipt } from '../conversion.ts';
import type { PrepareReceipt } from '../curator-core.ts';
import type { ChapterReceipt, MetadataReceipt } from '../media-mutation.ts';
import { Callout, DataList } from './primitives.tsx';

export interface MetadataMutationProps {
  readonly receipt: MetadataReceipt;
}

export interface ChapterMutationProps {
  readonly receipt: ChapterReceipt;
}

export interface ConversionMutationProps {
  readonly receipt: ConvertReceipt;
}

export interface PrepareMutationProps {
  readonly receipt: PrepareReceipt;
}

export const MetadataMutation = ({ receipt }: MetadataMutationProps) => (
  <>
    <DataList fields={[
      { label: 'Status', value: receipt.status },
      { label: 'Target', value: receipt.file },
      { label: 'Metadata fields', value: Object.values(receipt.metadata).filter((value) => value !== undefined && value !== '').length },
      { label: 'Audio hash before', value: receipt.audioSha256Before },
      ...(receipt.audioSha256After === undefined ? [] : [{ label: 'Audio hash after', value: receipt.audioSha256After }]),
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Plan only: the audiobook, every audio stream, and its chapter structure remain unchanged.'
        : 'Applied and verified: every audio stream and the existing chapter structure remain unchanged.'}
    </Callout>
  </>
);

export const ChapterMutation = ({ receipt }: ChapterMutationProps) => (
  <>
    <DataList fields={[
      { label: 'Status', value: receipt.status },
      { label: 'Target', value: receipt.file },
      { label: 'Planned chapters', value: receipt.chapters.length },
      { label: 'Chapters before', value: receipt.chapterCountBefore },
      ...(receipt.chapterCountAfter === undefined ? [] : [{ label: 'Chapters after', value: receipt.chapterCountAfter }]),
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Plan only: the audiobook and all non-chapter media state remain unchanged.'
        : 'Applied and verified: audio streams, metadata, artwork, duration, and other non-chapter media state remain unchanged.'}
    </Callout>
  </>
);

export const ConversionMutation = ({ receipt }: ConversionMutationProps) => (
  <>
    <DataList fields={[
      { label: 'Status', value: receipt.status },
      { label: 'Output', value: receipt.output },
      { label: 'Audio mode', value: receipt.audioMode },
      { label: 'Engine', value: receipt.engine },
      { label: 'Input files', value: receipt.inputs.length },
      { label: 'Expected chapters', value: receipt.expectedChapterCount },
      { label: 'Expected duration seconds', value: receipt.expectedDurationSeconds },
    ]} />
    <Callout tone="review">
      {receipt.status === 'planned'
        ? 'Plan only: no output was written and every source file remains unchanged.'
        : 'Converted and verified: the derived output passed duration and chapter checks; every source file remains unchanged.'}
    </Callout>
  </>
);

export const PrepareMutation = ({ receipt }: PrepareMutationProps) => (
  <>
    <DataList fields={[
      { label: 'Status', value: receipt.applied ? 'applied' : 'planned' },
      { label: 'Source', value: receipt.source },
      { label: 'Output', value: receipt.output },
      { label: 'Format', value: receipt.probe.format },
      { label: 'Codec', value: receipt.probe.codec },
      { label: 'Duration seconds', value: receipt.probe.durationSeconds },
    ]} />
    <Callout tone="review">
      {receipt.applied
        ? 'Applied: the derived output was probed after preparation; the source file remains unchanged.'
        : 'Plan only: no output was written and the source file remains unchanged.'}
    </Callout>
  </>
);
