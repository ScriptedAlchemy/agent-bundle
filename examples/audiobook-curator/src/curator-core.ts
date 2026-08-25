import { createHash } from 'node:crypto';
import {
  constants,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rm,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { runMediaProcess, type MediaProcess } from './media-process.js';

const supportedExtensions = new Set(['.aac', '.flac', '.m4a', '.m4b', '.mp3', '.ogg', '.opus', '.wav']);
const safeOutputName = /^[a-z0-9][a-z0-9._ -]{0,199}\.m4b$/iu;
const maximumTraversalEntries = 4096;
const maximumInventoryFiles = 256;
const hashChunkBytes = 1024 * 1024;
const readOnlyFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export interface CuratorDependencies {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly process?: MediaProcess;
  readonly signal?: AbortSignal;
}

export interface AudioProbe {
  readonly channels?: number;
  readonly codec: string;
  readonly durationSeconds: number;
  readonly format: string;
  readonly sampleRate?: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface InspectedAudioFile extends AudioProbe {
  readonly bytes: number;
  readonly path: string;
}

export interface InspectionReceipt {
  readonly files: readonly InspectedAudioFile[];
  readonly operation: 'inspect';
  readonly root: string;
  readonly totalBytes: number;
}

export interface PrepareInput {
  readonly apply?: boolean;
  readonly outputName?: string;
  readonly outputRoot: string;
  readonly source: string;
}

export interface PrepareReceipt {
  readonly applied: boolean;
  readonly operation: 'prepare';
  readonly output: string;
  readonly probe: AudioProbe;
  readonly source: string;
}

export interface AuditInput {
  readonly fullDecode?: boolean;
  readonly source: string;
}

export interface AuditReceipt {
  readonly bytes: number;
  readonly fullDecode: boolean;
  readonly operation: 'audit';
  readonly probe: AudioProbe;
  readonly sha256: string;
  readonly source: string;
}

const dependencies = (options: CuratorDependencies) => ({
  ffmpeg: options.ffmpeg ?? 'ffmpeg',
  ffprobe: options.ffprobe ?? 'ffprobe',
  process: options.process ?? runMediaProcess,
  signal: options.signal,
});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw signal.reason;
};

const regularFileSize = async (path: string): Promise<number> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`Audiobook source must be one regular file: ${path}`);
  return metadata.size;
};

const finiteNumber = (value: unknown, label: string): number => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
    throw new Error(`ffprobe returned an invalid ${label}.`);
  }
  return number;
};

const probeAudio = async (path: string, options: CuratorDependencies): Promise<AudioProbe> => {
  const selected = dependencies(options);
  const result = await selected.process(selected.ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
  ], { signal: selected.signal, timeoutMs: 30_000 });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ffprobe returned an invalid result.');
  }
  const record = value as Record<string, unknown>;
  const format = record.format;
  const streams = record.streams;
  if (format === null || typeof format !== 'object' || Array.isArray(format) || !Array.isArray(streams)) {
    throw new Error('ffprobe result is missing format or streams.');
  }
  const formatRecord = format as Record<string, unknown>;
  const audio = streams.find((stream): stream is Record<string, unknown> => (
    stream !== null && typeof stream === 'object' && !Array.isArray(stream)
      && (stream as Record<string, unknown>).codec_type === 'audio'
  ));
  if (audio === undefined || typeof audio.codec_name !== 'string' || audio.codec_name.trim() === '') {
    throw new Error('ffprobe result does not contain an audio stream.');
  }
  const rawTags = formatRecord.tags;
  const tags: Record<string, string> = {};
  if (rawTags !== undefined) {
    if (rawTags === null || typeof rawTags !== 'object' || Array.isArray(rawTags)) {
      throw new Error('ffprobe returned invalid tags.');
    }
    const entries = Object.entries(rawTags);
    if (entries.length > 64) throw new Error('ffprobe returned too many tags.');
    for (const [key, tag] of entries) {
      if (key.length > 128 || typeof tag !== 'string' || Buffer.byteLength(tag) > 4096) {
        throw new Error('ffprobe returned an invalid tag.');
      }
      tags[key] = tag;
    }
  }
  return Object.freeze({
    ...(audio.channels === undefined ? {} : { channels: finiteNumber(audio.channels, 'channel count') }),
    codec: audio.codec_name,
    durationSeconds: finiteNumber(formatRecord.duration, 'duration'),
    format: typeof formatRecord.format_name === 'string' ? formatRecord.format_name : '',
    ...(audio.sample_rate === undefined ? {} : { sampleRate: finiteNumber(audio.sample_rate, 'sample rate') }),
    tags: Object.freeze(tags),
  });
};

export const inspectSources = async (
  input: { readonly maxFiles?: number; readonly root: string },
  options: CuratorDependencies = {},
): Promise<InspectionReceipt> => {
  const root = resolve(input.root);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) throw new Error('Inspection root must be a directory.');
  const maxFiles = input.maxFiles ?? maximumInventoryFiles;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > maximumInventoryFiles) {
    throw new Error(`Inspection maxFiles must be between 1 and ${maximumInventoryFiles}.`);
  }

  const files: string[] = [];
  const directories: Array<{ depth: number; path: string }> = [{ depth: 0, path: root }];
  let visited = 0;
  while (directories.length > 0) {
    throwIfAborted(options.signal);
    const directory = directories.shift()!;
    const handle = await opendir(directory.path);
    for await (const entry of handle) {
      visited += 1;
      if (visited > maximumTraversalEntries) throw new Error('Inspection exceeded 4096 directory entries.');
      const path = join(directory.path, entry.name);
      if (entry.isDirectory()) {
        if (directory.depth < 12) directories.push({ depth: directory.depth + 1, path });
      } else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(path);
        if (files.length > maxFiles) throw new Error(`Inspection exceeded ${maxFiles} audio files.`);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  const inspected: InspectedAudioFile[] = [];
  let totalBytes = 0;
  for (const path of files) {
    throwIfAborted(options.signal);
    const bytes = await regularFileSize(path);
    const probe = await probeAudio(path, options);
    totalBytes += bytes;
    inspected.push(Object.freeze({ ...probe, bytes, path }));
  }
  return Object.freeze({ files: Object.freeze(inspected), operation: 'inspect', root, totalBytes });
};

const defaultOutputName = (source: string): string => {
  const stem = basename(source, extname(source)).replaceAll(/[^a-z0-9._ -]+/giu, '-').slice(0, 190);
  return `${stem === '' ? 'audiobook' : stem}.m4b`;
};

export const prepareAudiobook = async (
  input: PrepareInput,
  options: CuratorDependencies = {},
): Promise<PrepareReceipt> => {
  const source = resolve(input.source);
  await regularFileSize(source);
  const outputRoot = resolve(input.outputRoot);
  if (outputRoot === dirname(source)) throw new Error('Output root must be separate from the source directory.');
  const outputName = input.outputName ?? defaultOutputName(source);
  if (!safeOutputName.test(outputName) || basename(outputName) !== outputName) {
    throw new Error('Audiobook outputName must be a safe file name ending in .m4b.');
  }
  const output = join(outputRoot, outputName);
  const sourceProbe = await probeAudio(source, options);
  if (input.apply !== true) {
    return Object.freeze({ applied: false, operation: 'prepare', output, probe: sourceProbe, source });
  }

  await mkdir(outputRoot, { recursive: true });
  const outputRootMetadata = await lstat(outputRoot);
  if (!outputRootMetadata.isDirectory()) throw new Error('Output root must be a directory.');
  const temporaryRoot = await mkdtemp(join(outputRoot, '.audiobook-curator-'));
  const temporaryOutput = join(temporaryRoot, 'output.m4b');
  const selected = dependencies(options);
  try {
    await selected.process(selected.ffmpeg, [
      '-nostdin', '-v', 'error', '-i', source, '-map_metadata', '0', '-vn', '-c:a', 'aac', '-b:a', '64k', temporaryOutput,
    ], { signal: selected.signal, timeoutMs: 3_600_000 });
    await regularFileSize(temporaryOutput);
    const outputProbe = await probeAudio(temporaryOutput, options);
    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Audiobook output already exists: ${output}`);
      throw error;
    }
    const outputHandle = await open(output, 'r');
    try {
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    return Object.freeze({ applied: true, operation: 'prepare', output, probe: outputProbe, source });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const hashFile = async (path: string): Promise<{ bytes: number; sha256: string }> => {
  const handle = await open(path, readOnlyFlags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Audit source must be one regular file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(hashChunkBytes);
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, bytes);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytes) {
      throw new Error('Audit source changed while it was being hashed.');
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
};

export const auditAudiobook = async (
  input: AuditInput,
  options: CuratorDependencies = {},
): Promise<AuditReceipt> => {
  const source = resolve(input.source);
  await regularFileSize(source);
  const probe = await probeAudio(source, options);
  const hashed = await hashFile(source);
  if (input.fullDecode === true) {
    const selected = dependencies(options);
    await selected.process(selected.ffmpeg, [
      '-nostdin', '-v', 'error', '-i', source, '-map', '0:a:0', '-f', 'null', '-',
    ], { signal: selected.signal, timeoutMs: 3_600_000 });
  }
  return Object.freeze({ ...hashed, fullDecode: input.fullDecode === true, operation: 'audit', probe, source });
};
