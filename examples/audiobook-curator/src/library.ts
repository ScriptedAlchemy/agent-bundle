import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import { audioExtensions, naturalCompare, normalizedIdentity, utcNow } from './foundation.ts';
import { runMediaProcess, type MediaProcess } from './media-process.ts';

const maximumEntries = 65_536;
const maximumFiles = 4096;

type JsonRecord = Record<string, unknown>;

export interface MediaRecord {
  readonly artworkStreams?: number;
  readonly bitDepth?: number;
  readonly bitRate?: number;
  readonly bytes: number;
  readonly channelLayout?: string;
  readonly channels?: number;
  readonly chapters: number;
  readonly codec: string;
  readonly durationSeconds: number;
  readonly extension: string;
  readonly path: string;
  readonly relativePath: string;
  readonly sampleFormat?: string;
  readonly sampleRate: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface InventoryReceipt {
  readonly errors: readonly { readonly error: string; readonly path: string }[];
  readonly exitCode: 0 | 1;
  readonly files: readonly MediaRecord[];
  readonly generatedAt: string;
  readonly mutation: false;
  readonly operation: 'inventory';
  readonly source: string;
  readonly summary: Readonly<{
    bytes: number;
    durationSeconds: number;
    errors: number;
    files: number;
  }>;
}

export interface LibraryAuditFile extends Partial<MediaRecord> {
  readonly bytes: number;
  readonly error: string | null;
  readonly extension: string;
  readonly missing: Readonly<{
    album: boolean;
    artwork: boolean;
    author: boolean;
    chapters: boolean;
    title: boolean;
  }>;
  readonly path: string;
  readonly relativePath: string;
}

export interface LibraryAuditReceipt {
  readonly duplicateCandidates: readonly { readonly files: readonly string[]; readonly identityKey: string }[];
  readonly exitCode: 0 | 1;
  readonly files: readonly LibraryAuditFile[];
  readonly generatedAt: string;
  readonly multipartCandidates: readonly {
    readonly directory: string;
    readonly files: readonly { readonly part: number; readonly path: string; readonly total: number | null }[];
    readonly identityKey: string;
  }[];
  readonly mutation: false;
  readonly operation: 'library-audit';
  readonly reviewNote: string;
  readonly sources: readonly string[];
  readonly summary: Readonly<Record<'bytes' | 'files' | 'missingAlbum' | 'missingArtwork' | 'missingAuthor' | 'missingChapters' | 'missingTitle' | 'probeFailures', number>>;
}

export interface SelectionRow {
  readonly alternates: readonly MediaRecord[];
  readonly durationSpreadSeconds: number;
  readonly identityKey: string;
  readonly reason: string;
  readonly reviewReason: string | null;
  readonly reviewRequired: boolean;
  readonly selected: MediaRecord;
}

export interface SelectionReceipt {
  readonly generatedAt: string;
  readonly inventory?: string;
  readonly mutation: false;
  readonly operation: 'quality-selection';
  readonly selections: readonly SelectionRow[];
}

export interface LibraryDependencies {
  readonly ffprobe?: string;
  readonly process?: MediaProcess;
  readonly signal?: AbortSignal;
}

const record = (value: unknown, label: string): JsonRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ffprobe returned invalid ${label}.`);
  return value as JsonRecord;
};

const number = (value: unknown): number => {
  const result = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof result === 'number' && Number.isFinite(result) && result >= 0 ? result : 0;
};

const tags = (value: unknown): Readonly<Record<string, string>> => {
  if (value === undefined) return Object.freeze({});
  const input = record(value, 'tags');
  const entries = Object.entries(input);
  if (entries.length > 128) throw new Error('ffprobe returned too many tags.');
  return Object.freeze(Object.fromEntries(entries.map(([key, item]) => {
    if (key.length > 128 || typeof item !== 'string' || Buffer.byteLength(item) > 16_384) {
      throw new Error('ffprobe returned an invalid tag.');
    }
    return [key, item];
  })));
};

const probe = async (path: string, dependencies: LibraryDependencies): Promise<JsonRecord> => {
  const process = dependencies.process ?? runMediaProcess;
  const result = await process(dependencies.ffprobe ?? 'ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path,
  ], { signal: dependencies.signal });
  try {
    return record(JSON.parse(result.stdout), 'result');
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('ffprobe returned invalid JSON.');
    throw error;
  }
};

const mediaRecord = async (path: string, root: string, dependencies: LibraryDependencies): Promise<MediaRecord> => {
  dependencies.signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error(`Audiobook source must be one regular file: ${path}`);
  const details = await probe(path, dependencies);
  const streams = details.streams;
  if (!Array.isArray(streams) || streams.length > 256) throw new Error('ffprobe returned invalid streams.');
  const streamRows = streams.map((stream) => record(stream, 'stream'));
  const audio = streamRows.find((stream) => stream.codec_type === 'audio'
    && !record(stream.disposition ?? {}, 'disposition').attached_pic);
  if (audio === undefined || typeof audio.codec_name !== 'string') throw new Error(`no audio stream: ${path}`);
  const format = record(details.format, 'format');
  const chapters = details.chapters;
  if (!Array.isArray(chapters) || chapters.length > 16_384) throw new Error('ffprobe returned invalid chapters.');
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`Audiobook source changed while it was probed: ${path}`);
  }
  return Object.freeze({
    artworkStreams: streamRows.filter((stream) => Boolean(record(stream.disposition ?? {}, 'disposition').attached_pic)).length,
    bitDepth: number(audio.bits_per_raw_sample ?? audio.bits_per_sample),
    bitRate: number(audio.bit_rate ?? format.bit_rate),
    bytes: after.size,
    ...(typeof audio.channel_layout === 'string' ? { channelLayout: audio.channel_layout } : {}),
    ...(number(audio.channels) > 0 ? { channels: number(audio.channels) } : {}),
    chapters: chapters.length,
    codec: audio.codec_name,
    durationSeconds: number(format.duration),
    extension: extname(path).toLowerCase(),
    path: resolve(path),
    relativePath: relative(root, path),
    ...(typeof audio.sample_fmt === 'string' ? { sampleFormat: audio.sample_fmt } : {}),
    sampleRate: number(audio.sample_rate),
    tags: tags(format.tags),
  });
};

const discover = async (source: string): Promise<{ readonly files: string[]; readonly root: string }> => {
  const selected = resolve(source);
  const metadata = await lstat(selected);
  if (metadata.isFile()) {
    return { files: audioExtensions.has(extname(selected).toLowerCase()) ? [selected] : [], root: dirname(selected) };
  }
  if (!metadata.isDirectory()) throw new Error(`source does not exist: ${selected}`);
  const files: string[] = [];
  const queue = [selected];
  let entries = 0;
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > maximumEntries) throw new Error(`Library traversal exceeded ${maximumEntries} entries.`);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && audioExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(path);
        if (files.length > maximumFiles) throw new Error(`Library traversal exceeded ${maximumFiles} media files.`);
      }
    }
  }
  files.sort((left, right) => naturalCompare(relative(selected, left), relative(selected, right)));
  return { files, root: selected };
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Audiobook inspection failed.';

export const createInventory = async (
  input: { readonly source: string; readonly strict?: boolean },
  dependencies: LibraryDependencies = {},
): Promise<InventoryReceipt> => {
  const discovered = await discover(input.source);
  const files: MediaRecord[] = [];
  const errors: Array<{ error: string; path: string }> = [];
  for (const path of discovered.files) {
    dependencies.signal?.throwIfAborted();
    try {
      files.push(await mediaRecord(path, discovered.root, dependencies));
    } catch (error) {
      errors.push(Object.freeze({ error: errorMessage(error), path }));
    }
  }
  return Object.freeze({
    errors: Object.freeze(errors),
    exitCode: input.strict === true && errors.length > 0 ? 1 : 0,
    files: Object.freeze(files),
    generatedAt: utcNow(),
    mutation: false,
    operation: 'inventory',
    source: resolve(input.source),
    summary: Object.freeze({
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      durationSeconds: files.reduce((total, file) => total + file.durationSeconds, 0),
      errors: errors.length,
      files: files.length,
    }),
  });
};

const multipartIdentity = (path: string): { base: string; part: number; total: number | null } | undefined => {
  const stem = basename(path, extname(path));
  const patterns = [
    /^(.*?)[\s._\-(\[]+part\s*(\d+)\s*(?:of|\/)\s*(\d+)[\])\s._-]*$/iu,
    /^(.*?)[\s._\-(\[]+(?:disc|disk|cd)\s*(\d+)[\])\s._-]*$/iu,
    /^(.*?)[\s._-]+ep(?:isode)?\s*(\d+)[\s._-]*$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(stem);
    if (match !== null) return {
      base: match[1]!.replaceAll(/[\s._-]+$/gu, '').toLowerCase(),
      part: Number(match[2]),
      total: match[3] === undefined ? null : Number(match[3]),
    };
  }
  return undefined;
};

const auditFile = async (path: string, root: string, dependencies: LibraryDependencies): Promise<LibraryAuditFile> => {
  try {
    const media = await mediaRecord(path, root, dependencies);
    const normalizedTags = Object.fromEntries(Object.entries(media.tags).map(([key, value]) => [key.toLowerCase(), value]));
    return Object.freeze({
      ...media,
      error: null,
      missing: Object.freeze({
        album: !normalizedTags.album,
        artwork: (media.artworkStreams ?? 0) === 0,
        author: !(normalizedTags.artist ?? normalizedTags.album_artist ?? normalizedTags.composer ?? normalizedTags.author),
        chapters: media.durationSeconds >= 600 && media.chapters === 0,
        title: !normalizedTags.title,
      }),
    });
  } catch (error) {
    const metadata = await lstat(path);
    return Object.freeze({
      bytes: metadata.size,
      error: errorMessage(error),
      extension: extname(path).toLowerCase(),
      missing: Object.freeze({ album: false, artwork: false, author: false, chapters: false, title: false }),
      path: resolve(path),
      relativePath: relative(root, path),
    });
  }
};

const parallelMap = async <T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
};

export const auditLibrary = async (
  input: { readonly concurrency?: number; readonly sources: readonly string[]; readonly strict?: boolean },
  dependencies: LibraryDependencies = {},
): Promise<LibraryAuditReceipt> => {
  const concurrency = input.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Library concurrency must be between 1 and 8.');
  const roots = input.sources.map((source) => resolve(source));
  const candidates: Array<{ path: string; root: string }> = [];
  for (const source of roots) {
    const discovered = await discover(source);
    candidates.push(...discovered.files.map((path) => ({ path, root: discovered.root })));
  }
  candidates.sort((left, right) => naturalCompare(left.path, right.path));
  const files = await parallelMap(candidates, concurrency, ({ path, root }) => auditFile(path, root, dependencies));
  const duplicates = new Map<string, string[]>();
  const multipart = new Map<string, Array<{ part: number; path: string; total: number | null }>>();
  for (const file of files) {
    const duplicateKey = `${normalizedIdentity(dirname(file.relativePath))}/${normalizedIdentity(basename(file.relativePath, extname(file.relativePath)))}`;
    duplicates.set(duplicateKey, [...(duplicates.get(duplicateKey) ?? []), file.path]);
    const identity = multipartIdentity(file.path);
    if (identity !== undefined) {
      const key = `${dirname(file.path)}\u0000${identity.base}`;
      multipart.set(key, [...(multipart.get(key) ?? []), { part: identity.part, path: file.path, total: identity.total }]);
    }
  }
  const missingCount = (key: keyof LibraryAuditFile['missing']) => files.filter((file) => file.missing[key]).length;
  const summary = Object.freeze({
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files: files.length,
    missingAlbum: missingCount('album'),
    missingArtwork: missingCount('artwork'),
    missingAuthor: missingCount('author'),
    missingChapters: missingCount('chapters'),
    missingTitle: missingCount('title'),
    probeFailures: files.filter((file) => file.error !== null).length,
  });
  return Object.freeze({
    duplicateCandidates: Object.freeze([...duplicates].filter(([, paths]) => paths.length > 1).sort(([left], [right]) => naturalCompare(left, right)).map(([identityKey, paths]) => Object.freeze({ files: Object.freeze(paths), identityKey }))),
    exitCode: input.strict === true && summary.probeFailures > 0 ? 1 : 0,
    files: Object.freeze(files),
    generatedAt: utcNow(),
    multipartCandidates: Object.freeze([...multipart].filter(([, rows]) => rows.length > 1).sort(([left], [right]) => naturalCompare(left, right)).map(([key, rows]) => {
      const [directory, identityKey] = key.split('\u0000');
      return Object.freeze({ directory: directory!, files: Object.freeze(rows.sort((left, right) => left.part - right.part)), identityKey: identityKey! });
    })),
    mutation: false,
    operation: 'library-audit',
    reviewNote: 'Duplicate and multipart groups are review candidates, never deletion instructions.',
    sources: Object.freeze(roots),
    summary,
  });
};

export const qualityScore = (file: MediaRecord): readonly [number, number, number, number] => {
  const lossless = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'wavpack']).has(file.codec.toLowerCase()) ? 1 : 0;
  return Object.freeze([lossless, lossless === 1 ? file.bitDepth ?? 0 : 0, file.sampleRate, file.bitRate ?? 0]);
};

const compareScore = (left: MediaRecord, right: MediaRecord): number => {
  const leftScore = qualityScore(left);
  const rightScore = qualityScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return rightScore[index]! - leftScore[index]!;
  }
  return naturalCompare(left.path, right.path);
};

const collisionKey = (file: MediaRecord): string => {
  const directory = dirname(file.relativePath);
  const stem = basename(file.relativePath, extname(file.relativePath));
  return [...(directory === '.' ? [] : directory.split(/[\\/]/u)), stem].map(normalizedIdentity).join('/');
};

export const selectInventorySources = (inventory: InventoryReceipt, inventoryPath?: string): SelectionReceipt => {
  const groups = new Map<string, MediaRecord[]>();
  for (const file of inventory.files) groups.set(collisionKey(file), [...(groups.get(collisionKey(file)) ?? []), file]);
  const selections = [...groups].sort(([left], [right]) => naturalCompare(left, right)).map(([identityKey, candidates]) => {
    const ordered = [...candidates].sort(compareScore);
    const durations = ordered.map((file) => file.durationSeconds);
    const durationSpreadSeconds = Math.max(...durations) - Math.min(...durations);
    const reviewRequired = ordered.length > 1 && durationSpreadSeconds > Math.max(1, Math.max(...durations) * 0.01);
    return Object.freeze<SelectionRow>({
      alternates: Object.freeze(ordered.slice(1)),
      durationSpreadSeconds,
      identityKey,
      reason: 'lossless codec, lossless bit depth, sample rate, then bitrate from the probed audio stream',
      reviewReason: reviewRequired ? 'same-name candidates differ materially in duration' : null,
      reviewRequired,
      selected: ordered[0]!,
    });
  });
  return Object.freeze({
    generatedAt: utcNow(),
    ...(inventoryPath === undefined ? {} : { inventory: resolve(inventoryPath) }),
    mutation: false,
    operation: 'quality-selection',
    selections: Object.freeze(selections),
  });
};
