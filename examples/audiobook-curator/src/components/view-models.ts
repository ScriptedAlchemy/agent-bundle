import type { AudibleCandidate } from '../audible.ts';
import type { InspectionReceipt } from '../curator-core.ts';
import type { AcousticIdentifyReceipt } from '../evidence.ts';
import type { LibraryAuditFile, MediaRecord } from '../library.ts';

export interface FileCardModel {
  readonly author?: string;
  readonly durationSeconds?: number;
  readonly format?: string;
  readonly narrator?: string;
  readonly path: string;
  readonly title: string;
}

export type FileCardProps = FileCardModel;

export interface EditionCardModel {
  readonly asin?: string;
  readonly author?: string;
  readonly durationSeconds?: number;
  readonly format?: string;
  readonly narrator?: string;
  readonly region?: string;
  readonly title: string;
}

export type EditionCardProps = EditionCardModel;

export type FileCardSource =
  | InspectionReceipt['files'][number]
  | LibraryAuditFile
  | MediaRecord;

export type EditionCardSource =
  | AcousticIdentifyReceipt['attempts'][number]
  | AudibleCandidate;

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const contributorList = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return text(value);
  const names = value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [entry.trim()];
    const contributor = record(entry);
    if (contributor === undefined) return [];
    const name = text(contributor.name ?? contributor.display_name);
    return name === undefined ? [] : [name];
  });
  return names.length === 0 ? undefined : names.join(', ');
};

const normalizedFileCard = (
  file: Readonly<{
    durationSeconds?: number;
    format?: string;
    path: string;
    relativePath?: string;
    tags?: Readonly<Record<string, string>>;
  }>,
): FileCardModel => {
  const tags = file.tags ?? {};
  const title = text(tags.title ?? tags.album) ?? file.relativePath ?? file.path;
  const author = text(tags.artist ?? tags.album_artist ?? tags.author);
  const narrator = text(tags.composer);
  return {
    ...(author === undefined ? {} : { author }),
    ...(file.durationSeconds === undefined ? {} : { durationSeconds: file.durationSeconds }),
    ...(file.format === undefined || file.format === '' ? {} : { format: file.format }),
    ...(narrator === undefined ? {} : { narrator }),
    path: file.path,
    title,
  };
};

const inspectionFileCardModel = (
  file: InspectionReceipt['files'][number],
): FileCardModel => normalizedFileCard(file);

const libraryAuditFileCardModel = (
  file: LibraryAuditFile,
): FileCardModel => normalizedFileCard({
  ...(file.durationSeconds === undefined ? {} : { durationSeconds: file.durationSeconds }),
  format: [file.codec, file.extension].filter((value) => value !== undefined && value !== '').join(' / '),
  path: file.path,
  relativePath: file.relativePath,
  ...(file.tags === undefined ? {} : { tags: file.tags }),
});

const mediaFileCardModel = (
  file: MediaRecord,
): FileCardModel => normalizedFileCard({
  durationSeconds: file.durationSeconds,
  format: [file.codec, file.extension].filter((value) => value !== '').join(' / '),
  path: file.path,
  relativePath: file.relativePath,
  tags: file.tags,
});

export const fileCardModel = (file: FileCardSource): FileCardModel => {
  if ('format' in file) return inspectionFileCardModel(file);
  if ('error' in file) return libraryAuditFileCardModel(file);
  return mediaFileCardModel(file);
};

export const editionCardModel = (edition: EditionCardSource): EditionCardModel => {
  const title = text(edition.title) ?? 'Untitled Audible edition';
  const author = contributorList(edition.authors);
  const narrator = contributorList(edition.narrators);
  const runtimeMinutes = typeof edition.runtime_length_min === 'number'
    ? edition.runtime_length_min
    : undefined;
  const format = text(edition.format_type);
  const region = text(edition.region);
  const asin = text(edition.asin);
  return {
    ...(asin === undefined ? {} : { asin }),
    ...(author === undefined ? {} : { author }),
    ...(runtimeMinutes === undefined ? {} : { durationSeconds: runtimeMinutes * 60 }),
    ...(format === undefined ? {} : { format }),
    ...(narrator === undefined ? {} : { narrator }),
    ...(region === undefined ? {} : { region }),
    title,
  };
};
