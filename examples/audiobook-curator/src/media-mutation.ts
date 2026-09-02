import { chmod, lstat, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { chapterMappingIssues, type ChapterRow } from './conversion.ts';
import {
  CuratorError,
  asRecord,
  contributorNames,
  escapeFfmetadata,
  readJson,
  sha256File,
  syncDirectory,
  syncFile,
  utcNow,
  writeReceipt,
} from './foundation.ts';
import { probeMediaDetails, type LibraryDependencies, type MediaDetails } from './library.ts';
import { runMediaProcess, type MediaProcess } from './media-process.ts';

export interface MetadataInput {
  readonly apply?: boolean;
  readonly artwork?: string;
  readonly author?: string;
  readonly file: string;
  readonly language?: string;
  readonly narrator?: string;
  readonly product: string;
  readonly receipt?: string;
  readonly title?: string;
  readonly year?: string;
}

export interface ChapterInput {
  readonly apply?: boolean;
  readonly chapters: string;
  readonly file: string;
  readonly receipt?: string;
}

export type MetadataReceipt = {
  readonly apply: boolean;
  readonly artwork?: string;
  readonly artworkStreamsAfter?: number;
  readonly audioLanguage?: string;
  readonly audioSha256After?: string;
  readonly audioSha256Before: string;
  readonly audioStreamHashesAfter?: readonly string[];
  readonly audioStreamHashesBefore: readonly string[];
  readonly bytesAfter?: number;
  readonly chapterCountAfter?: number;
  readonly chapterCountBefore: number;
  readonly file: string;
  readonly generatedAt: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly mutation: boolean;
  readonly operation: 'apply-metadata';
  readonly product: string;
  readonly sha256After?: string;
  readonly status: 'applied-verified' | 'planned';
  readonly streamCountAfter?: number;
  readonly verifiedMetadataKeys?: readonly string[];
};

export type ChapterReceipt = {
  readonly apply: boolean;
  readonly audioSha256After?: string;
  readonly audioSha256Before: string;
  readonly audioStreamHashesAfter?: readonly string[];
  readonly audioStreamHashesBefore: readonly string[];
  readonly bytesAfter?: number;
  readonly chapterCountAfter?: number;
  readonly chapterCountBefore: number;
  readonly chapterDocument: string;
  readonly chapters: readonly Omit<ChapterRow, 'number'>[];
  readonly durationSeconds?: number;
  readonly file: string;
  readonly generatedAt: string;
  readonly mutation: boolean;
  readonly operation: 'apply-chapters';
  readonly sha256After?: string;
  readonly status: 'applied-verified' | 'planned';
  readonly verifiedBoundaries?: true;
};

export interface MediaMutationDependencies extends LibraryDependencies {
  readonly ffmpeg?: string;
  readonly process?: MediaProcess;
}

const streams = (details: MediaDetails): Record<string, unknown>[] => {
  if (!Array.isArray(details.streams) || details.streams.length > 256) throw new CuratorError('ffprobe returned invalid streams.');
  return details.streams.map(asRecord);
};

const chaptersFromDetails = (details: MediaDetails): Omit<ChapterRow, 'number'>[] => {
  if (!Array.isArray(details.chapters) || details.chapters.length > 16_384) throw new CuratorError('ffprobe returned invalid chapters.');
  return details.chapters.map((chapter) => {
    const row = asRecord(chapter);
    return Object.freeze({
      endSeconds: Number(row.end_time ?? 0),
      startSeconds: Number(row.start_time ?? 0),
      title: String(asRecord(row.tags).title ?? '').trim(),
    });
  });
};

const duration = (details: MediaDetails): number => Number(asRecord(details.format).duration ?? 0);

const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Media mutation failed.';

export const cleanCatalogText = (value: unknown): string => String(value ?? '')
  .replaceAll(/<br\s*\/?>/giu, '\n')
  .replaceAll(/<[^>]+>/gu, '')
  .replaceAll(/&(?:amp|#38);/giu, '&')
  .replaceAll(/&(?:quot|#34);/giu, '"')
  .replaceAll(/&(?:apos|#39);/giu, "'")
  .replaceAll(/&(?:lt|#60);/giu, '<')
  .replaceAll(/&(?:gt|#62);/giu, '>')
  .replaceAll(/\n\s*\n\s*\n+/gu, '\n\n')
  .trim();

export const chapterRowsFromPayload = (
  payload: unknown,
  durationSeconds: number,
): readonly Omit<ChapterRow, 'number'>[] => {
  const payloadObject = asRecord(payload);
  const nested = asRecord(asRecord(payloadObject.content_metadata).chapter_info).chapters;
  const chapterData = Array.isArray(payload) ? payload : Array.isArray(payloadObject.chapters) ? payloadObject.chapters : nested;
  if (!Array.isArray(chapterData) || chapterData.length === 0 || chapterData.length > 16_384) {
    throw new CuratorError('chapter document contains no chapters');
  }
  const rows = chapterData.map((source, index) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new CuratorError(`chapter ${index + 1} is not an object`);
    const row = source as Record<string, unknown>;
    const title = String(row.title ?? row.name ?? '').trim();
    if (title === '') throw new CuratorError(`chapter ${index + 1} has no title`);
    const start = row.startSeconds === undefined ? Number(row.start_offset_ms ?? 0) / 1000 : Number(row.startSeconds);
    const end = row.endSeconds !== undefined ? Number(row.endSeconds)
      : row.length_ms !== undefined ? start + Number(row.length_ms) / 1000 : -1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new CuratorError(`chapter ${index + 1} has an invalid time range`);
    return { endSeconds: end, startSeconds: start, title };
  });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.endSeconds < 0) row.endSeconds = rows[index + 1]?.startSeconds ?? durationSeconds;
    if (rows[index + 1] !== undefined && Math.abs(row.endSeconds - rows[index + 1]!.startSeconds) <= 1) row.endSeconds = rows[index + 1]!.startSeconds;
  }
  if (Math.abs(rows.at(-1)!.endSeconds - durationSeconds) <= 1) rows.at(-1)!.endSeconds = durationSeconds;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.startSeconds < 0 || row.endSeconds <= row.startSeconds) throw new CuratorError(`chapter ${index + 1} has an invalid time range`);
    if (index > 0 && Math.abs(row.startSeconds - rows[index - 1]!.endSeconds) > 0.05) {
      throw new CuratorError(`chapter boundary ${index}/${index + 1} is discontinuous`);
    }
  }
  if (Math.abs(rows[0]!.startSeconds) > 0.1) throw new CuratorError('first chapter does not start at zero');
  if (Math.abs(rows.at(-1)!.endSeconds - durationSeconds) > 1) throw new CuratorError('last chapter does not reach media end');
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
};

const ensureSupportedAuxiliaryStreams = (details: MediaDetails): void => {
  if (streams(details).some((stream) => stream.codec_type === 'data' && stream.codec_tag_string !== 'text')) {
    throw new CuratorError('unsupported non-chapter data stream; refusing a metadata-only replacement');
  }
};

const audioHashes = async (
  path: string,
  details: MediaDetails,
  dependencies: MediaMutationDependencies,
): Promise<readonly string[]> => {
  const count = streams(details).filter((stream) => stream.codec_type === 'audio').length;
  const process = dependencies.process ?? runMediaProcess;
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await process(dependencies.ffmpeg ?? 'ffmpeg', [
      '-v', 'error', '-i', path, '-map', `0:a:${index}`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-',
    ], { signal: dependencies.signal });
    hashes.push(result.stdout.trim().replace(/^SHA256=/u, ''));
  }
  return Object.freeze(hashes);
};

interface StreamSignature {
  readonly attachedPicture: boolean;
  readonly channels?: unknown;
  readonly codec?: unknown;
  readonly codecType?: unknown;
  readonly height?: unknown;
  readonly sampleRate?: unknown;
  readonly width?: unknown;
}

const streamSignature = (details: MediaDetails, includeArtwork = true): readonly StreamSignature[] => Object.freeze(streams(details).flatMap((stream) => {
  const artwork = Boolean(asRecord(stream.disposition).attached_pic);
  if (stream.codec_type === 'data' && stream.codec_tag_string === 'text') return [];
  if (artwork && !includeArtwork) return [];
  return [Object.freeze({
    attachedPicture: artwork,
    channels: stream.channels,
    codec: stream.codec_name,
    codecType: stream.codec_type,
    height: stream.height,
    sampleRate: stream.sample_rate,
    width: stream.width,
  })];
}));

const stableFormatTags = (details: MediaDetails): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(asRecord(asRecord(details.format).tags))
    .filter(([key]) => key.toLowerCase() !== 'encoder')
    .map(([key, value]) => [key.toLowerCase(), String(value)]),
));

const chapterMetadata = (rows: readonly Omit<ChapterRow, 'number'>[]): string => `${[
  ';FFMETADATA1',
  ...rows.flatMap((row) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(row.startSeconds * 1000)}`, `END=${Math.round(row.endSeconds * 1000)}`, `title=${escapeFfmetadata(row.title)}`]),
].join('\n')}\n`;

const publishReplacement = async (source: string, temporary: string, before: Awaited<ReturnType<typeof lstat>>): Promise<void> => {
  const current = await lstat(source);
  if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
    throw new CuratorError('Audiobook changed while its replacement was prepared; original left untouched.');
  }
  await chmod(temporary, Number(before.mode));
  await utimes(temporary, before.atime, before.mtime);
  await syncFile(temporary);
  await rename(temporary, source);
  await syncDirectory(dirname(source));
};

const names = (value: unknown): string => contributorNames(value).filter((name) => name !== '').join(' & ');

export const applyAudiobookMetadata = async (
  input: MetadataInput,
  dependencies: MediaMutationDependencies = {},
): Promise<MetadataReceipt> => {
  const path = resolve(input.file);
  const productPath = resolve(input.product);
  const product = asRecord(await readJson(productPath));
  const authors = names(product.authors);
  const narrators = names(product.narrators);
  const title = input.title ?? String(product.title ?? '');
  const narrator = input.narrator ?? narrators;
  const metadata = Object.freeze({
    album: title,
    album_artist: input.author ?? authors,
    artist: input.author ?? authors,
    comment: `Narrated by ${narrator}. Published by ${cleanCatalogText(product.publisher_name)}. Audible ASIN: ${String(product.asin ?? '')}.`,
    composer: narrator,
    date: input.year ?? String(product.release_date ?? ''),
    description: cleanCatalogText(product.publisher_summary ?? product.merchandising_summary),
    title,
  });
  const beforeFile = await lstat(path);
  const before = await probeMediaDetails(path, dependencies);
  ensureSupportedAuxiliaryStreams(before);
  const beforeRows = chaptersFromDetails(before);
  const beforeDuration = duration(before);
  const beforeHashes = await audioHashes(path, before, dependencies);
  const plan = {
    apply: input.apply === true,
    ...(input.artwork === undefined ? {} : { artwork: resolve(input.artwork) }),
    ...(input.language === undefined ? {} : { audioLanguage: input.language }),
    audioSha256Before: beforeHashes[0]!,
    audioStreamHashesBefore: beforeHashes,
    chapterCountBefore: beforeRows.length,
    file: path,
    generatedAt: utcNow(),
    metadata,
    mutation: input.apply === true,
    operation: 'apply-metadata' as const,
    product: productPath,
  };
  if (input.apply !== true) {
    const receipt = Object.freeze<MetadataReceipt>({ ...plan, status: 'planned' });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [path, productPath, input.artwork]);
    return receipt;
  }
  const work = await mkdtemp(join(dirname(path), '.audiobook-curator-metadata-'));
  const temporary = join(work, 'replacement.m4b');
  const process = dependencies.process ?? runMediaProcess;
  try {
    const args = ['-v', 'error', '-xerror', '-i', path];
    if (input.artwork !== undefined) args.push('-i', resolve(input.artwork));
    if (input.artwork !== undefined) args.push('-map', '0:a?', '-map', '0:s?', '-map', '1:v:0', '-disposition:v:0', 'attached_pic');
    else args.push('-map', '0:a?', '-map', '0:v?', '-map', '0:s?');
    args.push('-map_chapters', '0', '-map_metadata', '0', '-c', 'copy');
    for (const [key, value] of Object.entries(metadata)) if (value !== '') args.push('-metadata', `${key}=${value}`);
    if (input.language !== undefined) args.push('-metadata:s:a:0', `language=${input.language}`);
    args.push('-movflags', '+faststart', temporary);
    await process(dependencies.ffmpeg ?? 'ffmpeg', args, { signal: dependencies.signal });
    const after = await probeMediaDetails(temporary, dependencies);
    const afterHashes = await audioHashes(temporary, after, dependencies);
    const afterRows = chaptersFromDetails(after);
    if (JSON.stringify(afterHashes) !== JSON.stringify(beforeHashes)) throw new CuratorError('an audio stream changed during metadata update; original left untouched');
    if (chapterMappingIssues(beforeRows.map((row, index) => ({ ...row, number: index + 1 })), afterRows.map((row, index) => ({ ...row, number: index + 1 })), { tolerance: 0.01 }).length > 0
      || Math.abs(duration(after) - beforeDuration) > 0.01) {
      throw new CuratorError('chapter structure or duration changed during metadata update; original left untouched');
    }
    const afterTags = Object.fromEntries(Object.entries(asRecord(asRecord(after.format).tags)).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const missingKeys = Object.entries(metadata).filter(([key, value]) => value !== '' && afterTags[key.toLowerCase()] !== value).map(([key]) => key);
    if (missingKeys.length > 0) throw new CuratorError(`metadata verification failed for: ${missingKeys.join(', ')}; original left untouched`);
    const afterStreams = streams(after);
    const firstAudio = afterStreams.find((stream) => stream.codec_type === 'audio');
    if (input.language !== undefined && String(asRecord(firstAudio?.tags).language ?? '').toLowerCase() !== input.language.toLowerCase()) {
      throw new CuratorError('audio language metadata verification failed; original left untouched');
    }
    const beforeArtwork = streams(before).filter((stream) => Boolean(asRecord(stream.disposition).attached_pic)).length;
    const afterArtwork = afterStreams.filter((stream) => Boolean(asRecord(stream.disposition).attached_pic)).length;
    if (afterArtwork < (input.artwork === undefined ? beforeArtwork : 1)) throw new CuratorError('artwork verification failed; original left untouched');
    if (JSON.stringify(streamSignature(before, input.artwork === undefined)) !== JSON.stringify(streamSignature(after, input.artwork === undefined))) {
      throw new CuratorError('non-artwork stream inventory changed; original left untouched');
    }
    await publishReplacement(path, temporary, beforeFile);
    const final = await lstat(path);
    const receipt = Object.freeze<MetadataReceipt>({
      ...plan,
      artworkStreamsAfter: afterArtwork,
      audioSha256After: afterHashes[0]!,
      audioStreamHashesAfter: afterHashes,
      bytesAfter: final.size,
      chapterCountAfter: afterRows.length,
      sha256After: await sha256File(path),
      status: 'applied-verified',
      streamCountAfter: afterStreams.length,
      verifiedMetadataKeys: Object.freeze([...Object.entries(metadata).filter(([, value]) => value !== '').map(([key]) => key), ...(input.language === undefined ? [] : ['audio.language'])]),
    });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [path, productPath, input.artwork]);
    return receipt;
  } finally { await rm(work, { force: true, recursive: true }); }
};

export const applyAudiobookChapters = async (
  input: ChapterInput,
  dependencies: MediaMutationDependencies = {},
): Promise<ChapterReceipt> => {
  const path = resolve(input.file);
  const document = resolve(input.chapters);
  const beforeFile = await lstat(path);
  const before = await probeMediaDetails(path, dependencies);
  ensureSupportedAuxiliaryStreams(before);
  const rows = chapterRowsFromPayload(await readJson(document), duration(before));
  const beforeHashes = await audioHashes(path, before, dependencies);
  const beforeRows = chaptersFromDetails(before);
  const plan = {
    apply: input.apply === true,
    audioSha256Before: beforeHashes[0]!,
    audioStreamHashesBefore: beforeHashes,
    chapterCountBefore: beforeRows.length,
    chapterDocument: document,
    chapters: rows,
    file: path,
    generatedAt: utcNow(),
    mutation: input.apply === true,
    operation: 'apply-chapters' as const,
  };
  if (input.apply !== true) {
    const receipt = Object.freeze<ChapterReceipt>({ ...plan, status: 'planned' });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [path, document]);
    return receipt;
  }
  const work = await mkdtemp(join(dirname(path), '.audiobook-curator-chapters-'));
  const metadata = join(work, 'chapters.ffmetadata');
  const temporary = join(work, 'replacement.m4b');
  try {
    await writeFile(metadata, chapterMetadata(rows));
    const process = dependencies.process ?? runMediaProcess;
    await process(dependencies.ffmpeg ?? 'ffmpeg', [
      '-v', 'error', '-xerror', '-i', path, '-f', 'ffmetadata', '-i', metadata,
      '-map', '0:a?', '-map', '0:v?', '-map', '0:s?', '-map_metadata', '0', '-map_chapters', '1',
      '-c', 'copy', '-movflags', '+faststart', temporary,
    ], { signal: dependencies.signal });
    const after = await probeMediaDetails(temporary, dependencies);
    const afterHashes = await audioHashes(temporary, after, dependencies);
    const afterRows = chaptersFromDetails(after);
    const issues = chapterMappingIssues(rows.map((row, index) => ({ ...row, number: index + 1 })), afterRows.map((row, index) => ({ ...row, number: index + 1 })), { tolerance: 0.05 });
    if (JSON.stringify(afterHashes) !== JSON.stringify(beforeHashes)) throw new CuratorError('an audio stream changed during chapter update; original left untouched');
    if (JSON.stringify(streamSignature(after)) !== JSON.stringify(streamSignature(before))
      || JSON.stringify(stableFormatTags(after)) !== JSON.stringify(stableFormatTags(before))) {
      throw new CuratorError('non-chapter media state changed during chapter update; original left untouched');
    }
    if (Math.abs(duration(after) - duration(before)) > 0.01 || issues.length > 0) {
      throw new CuratorError(`chapter verification failed; original left untouched: ${issues.join('; ')}`);
    }
    await publishReplacement(path, temporary, beforeFile);
    const final = await lstat(path);
    const receipt = Object.freeze<ChapterReceipt>({
      ...plan,
      audioSha256After: afterHashes[0]!,
      audioStreamHashesAfter: afterHashes,
      bytesAfter: final.size,
      chapterCountAfter: afterRows.length,
      durationSeconds: duration(after),
      sha256After: await sha256File(path),
      status: 'applied-verified',
      verifiedBoundaries: true,
    });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [path, document]);
    return receipt;
  } catch (error) {
    if (error instanceof CuratorError) throw error;
    throw new CuratorError(errorText(error));
  } finally { await rm(work, { force: true, recursive: true }); }
};
