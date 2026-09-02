import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { AudibleCandidate } from '../audible.ts';
import type { InspectionReceipt } from '../curator-core.ts';
import type { AcousticIdentifyReceipt } from '../evidence.ts';
import type { LibraryAuditFile, MediaRecord } from '../library.ts';
import { DataList, type Field } from './primitives.tsx';

type FileRecord = InspectionReceipt['files'][number] | LibraryAuditFile | MediaRecord;
type EditionRecord = AcousticIdentifyReceipt['attempts'][number] | AudibleCandidate;

export type AudiobookCardProps =
  | { readonly edition: EditionRecord; readonly file?: never; readonly kind: 'edition' }
  | { readonly edition?: never; readonly file: FileRecord; readonly kind: 'file' };

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const contributorList = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return text(value);
  const names = value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [entry.trim()];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Readonly<Record<string, unknown>>;
    const name = text(record.name ?? record.display_name);
    return name === undefined ? [] : [name];
  });
  return names.length === 0 ? undefined : names.join(', ');
};

const seconds = (value: number): string => {
  const rounded = Math.max(0, Math.round(value));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded % 3600 / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${String(hours)}h ${String(minutes)}m ${String(remaining)}s`
    : `${String(minutes)}m ${String(remaining)}s`;
};

const fileCard = (file: FileRecord) => {
  const tags = 'tags' in file && file.tags !== undefined ? file.tags : {};
  const relativePath = 'relativePath' in file ? file.relativePath : undefined;
  const title = text(tags.title ?? tags.album) ?? relativePath ?? file.path;
  const author = text(tags.artist ?? tags.album_artist ?? tags.author);
  const narrator = text(tags.composer);
  const duration = 'durationSeconds' in file ? file.durationSeconds : undefined;
  const format = 'format' in file
    ? file.format
    : [file.codec, file.extension].filter((value) => value !== undefined && value !== '').join(' / ');
  const fields: Field[] = [
    { label: 'File', value: file.path },
    ...(author === undefined ? [] : [{ label: 'Author', value: author }]),
    ...(narrator === undefined ? [] : [{ label: 'Narrator', value: narrator }]),
    ...(duration === undefined ? [] : [{ label: 'Duration', value: seconds(duration) }]),
    ...(format === '' ? [] : [{ label: 'Format', value: format }]),
  ];
  return (
    <>
      <Agent.Markdown>{`### ${title}`}</Agent.Markdown>
      <DataList fields={fields} />
    </>
  );
};

const editionCard = (edition: EditionRecord) => {
  const title = text(edition.title) ?? 'Untitled Audible edition';
  const author = contributorList(edition.authors);
  const narrator = contributorList(edition.narrators);
  const runtimeMinutes = typeof edition.runtime_length_min === 'number' ? edition.runtime_length_min : undefined;
  const fields: Field[] = [
    ...(author === undefined ? [] : [{ label: 'Author', value: author }]),
    ...(narrator === undefined ? [] : [{ label: 'Narrator', value: narrator }]),
    ...(runtimeMinutes === undefined ? [] : [{ label: 'Duration', value: seconds(runtimeMinutes * 60) }]),
    ...(text(edition.format_type) === undefined ? [] : [{ label: 'Format', value: text(edition.format_type)! }]),
    ...(text(edition.region) === undefined ? [] : [{ label: 'Region', value: text(edition.region)! }]),
    ...(text(edition.asin) === undefined ? [] : [{ label: 'ASIN', value: text(edition.asin)! }]),
  ];
  return (
    <>
      <Agent.Markdown>{`### ${title}`}</Agent.Markdown>
      <DataList fields={fields} />
    </>
  );
};

export const AudiobookCard = (props: AudiobookCardProps) => {
  switch (props.kind) {
    case 'file':
      return fileCard(props.file);
    case 'edition':
      return editionCard(props.edition);
    default: {
      const unhandled: never = props;
      throw new Error(`Unhandled audiobook card: ${JSON.stringify(unhandled)}`);
    }
  }
};
