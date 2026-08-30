import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import {
  CuratorError,
  asRecord,
  escapeFfmetadata,
  mapWithConcurrency,
  naturalCompare,
  readJson,
  safeFilename,
  sha256File,
  syncDirectory,
  syncFile,
  utcNow,
  writeReceipt,
} from './foundation.ts';
import {
  probeMediaDetails,
  probeMediaRecord,
  type LibraryDependencies,
  type MediaDetails,
  type MediaRecord,
} from './library.ts';
import { runMediaProcess, type MediaProcess } from './media-process.ts';

export interface ChapterRow {
  readonly endSeconds: number;
  readonly number: number;
  readonly startSeconds: number;
  readonly title: string;
}

export interface ConvertInput {
  readonly apply?: boolean;
  readonly artwork?: string;
  readonly audioBitrate?: string;
  readonly audioCodec?: 'aac' | 'alac';
  readonly author: string;
  readonly engine?: 'audiobook-forge' | 'ffmpeg';
  readonly forgeAacEncoder?: string;
  readonly forgeCli?: string;
  readonly jobs?: number;
  readonly language?: string;
  readonly narrator?: string;
  readonly output: string;
  readonly overwrite?: boolean;
  readonly receipt?: string;
  readonly selection: string;
  readonly title: string;
  readonly year?: string;
}

export interface ConvertReceipt {
  readonly apply: boolean;
  readonly audioMode: string;
  readonly audioSha256?: string;
  readonly durationDeltaSeconds?: number;
  readonly embeddedMetadata: Readonly<Record<string, string | undefined>>;
  readonly engine: 'audiobook-forge' | 'ffmpeg';
  readonly expectedChapterCount: number;
  readonly expectedChapters: readonly ChapterRow[];
  readonly expectedDurationSeconds: number;
  readonly filenamePolicy: string;
  readonly generatedAt: string;
  readonly inputs: readonly string[];
  readonly jobs: number;
  readonly mutation: boolean;
  readonly operation: 'convert';
  readonly output: string;
  readonly outputBytes?: number;
  readonly outputSha256?: string;
  readonly probe?: MediaRecord;
  readonly sourcesPreserved: true;
  readonly status: 'converted-verified' | 'planned';
}

export interface ConversionDependencies extends LibraryDependencies {
  readonly cpuCount?: number;
  readonly ffmpeg?: string;
  readonly process?: MediaProcess;
}

export const resolveJobs = (
  requested: number,
  inputCount: number,
  cpuCount: number,
  intraFile = false,
): number => {
  if (requested === 0) return intraFile ? Math.max(1, cpuCount) : Math.max(1, Math.min(inputCount, cpuCount));
  return Math.max(1, Math.min(requested, intraFile ? cpuCount : inputCount, cpuCount));
};

export const alacChunkCounts = (
  durations: readonly number[],
  workers: number,
  minimumSeconds = 2,
): readonly number[] => {
  const counts = durations.map(() => 1);
  while (counts.reduce((total, count) => total + count, 0) < workers) {
    const candidates = durations.map((duration, index) => ({ duration, index })).filter(({ duration, index }) => (
      duration / (counts[index]! + 1) >= minimumSeconds
    ));
    if (candidates.length === 0) break;
    candidates.sort((left, right) => right.duration / counts[right.index]! - left.duration / counts[left.index]!);
    counts[candidates[0]!.index] += 1;
  }
  return Object.freeze(counts);
};

type UniformKey = 'bitDepth' | 'channelLayout' | 'channels' | 'codec' | 'sampleFormat' | 'sampleRate';

export const uniformAudioProperties = (
  records: readonly MediaRecord[],
  keys: readonly UniformKey[] = ['sampleRate', 'channels', 'channelLayout'],
  subject = 'multipart inputs',
): Readonly<Record<UniformKey, number | string | undefined>> => {
  const result: Partial<Record<UniformKey, number | string>> = {};
  const mismatched: string[] = [];
  for (const key of keys) {
    const values = [...new Set(records.map((row) => row[key]).filter((value) => value !== undefined && value !== 0 && value !== ''))];
    if (values.length > 1) mismatched.push(`${key}=${JSON.stringify(values)}`);
    if (values[0] !== undefined) result[key] = values[0];
  }
  if (mismatched.length > 0) {
    throw new CuratorError(`${subject} have mismatched audio stream parameters (${mismatched.join(', ')}); refusing to resample, downmix, or mux mismatched audio`);
  }
  return Object.freeze(result as Record<UniformKey, number | string | undefined>);
};

const selectedPaths = async (path: string): Promise<string[]> => {
  const payload = await readJson(path);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new CuratorError('Selection must be an object.');
  const selections = (payload as Record<string, unknown>).selections;
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > 4096) {
    throw new CuratorError('Selection contains no audio files.');
  }
  return selections.map((selection) => {
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) throw new CuratorError('Selection row is invalid.');
    const selected = (selection as Record<string, unknown>).selected;
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) throw new CuratorError('Selection row has no selected media.');
    const value = (selected as Record<string, unknown>).path;
    if (typeof value !== 'string' || value.trim() === '') throw new CuratorError('Selection row has an invalid media path.');
    return resolve(value);
  });
};

const commonDirectory = (paths: readonly string[]): string => {
  let candidate = dirname(paths[0]!);
  while (paths.some((path) => relative(candidate, path).startsWith('..'))) candidate = dirname(candidate);
  return candidate;
};

const chapterTitle = (path: string, root: string): string => {
  const selected = relative(root, path);
  const parts = selected.split(/[\\/]/u);
  parts[parts.length - 1] = basename(parts.at(-1)!, extname(parts.at(-1)!));
  return parts.join(' - ');
};

export const chapterRows = (details: MediaDetails): readonly ChapterRow[] => {
  const chapters = Array.isArray(details.chapters) ? details.chapters : [];
  return Object.freeze(chapters.map((chapter, index) => {
    const row = asRecord(chapter);
    return Object.freeze({
      endSeconds: Number(row.end_time ?? 0),
      number: index + 1,
      startSeconds: Number(row.start_time ?? 0),
      title: String(asRecord(row.tags).title ?? '').trim(),
    });
  }));
};

export const chapterMappingIssues = (
  expected: readonly ChapterRow[],
  actual: readonly ChapterRow[],
  options: { readonly checkTitles?: boolean; readonly tolerance?: number } = {},
): readonly string[] => {
  const issues: string[] = [];
  if (expected.length !== actual.length) issues.push(`expected ${expected.length} source-mapped chapters, found ${actual.length}`);
  const tolerance = options.tolerance ?? 0.15;
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    const wanted = expected[index]!;
    const found = actual[index]!;
    if (options.checkTitles !== false && wanted.title !== found.title) issues.push(`chapter ${index + 1} title does not match expected value`);
    if (Math.abs(wanted.startSeconds - found.startSeconds) > tolerance) issues.push(`chapter ${index + 1} start does not match expected boundary`);
    if (Math.abs(wanted.endSeconds - found.endSeconds) > tolerance) issues.push(`chapter ${index + 1} end does not match expected boundary`);
  }
  return Object.freeze(issues);
};

const metadataDocument = (
  inputs: readonly string[],
  root: string,
  metadata: Readonly<Record<string, string | undefined>>,
  durations: readonly number[],
): string => {
  const lines = [';FFMETADATA1'];
  for (const [key, value] of Object.entries(metadata)) if (value !== undefined && value !== '') lines.push(`${key}=${escapeFfmetadata(value)}`);
  let start = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    const end = start + Math.max(Math.round(durations[index]! * 1000), 1);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${escapeFfmetadata(chapterTitle(inputs[index]!, root))}`);
    start = end;
  }
  return `${lines.join('\n')}\n`;
};

const chapterMetadataDocument = (
  metadata: Readonly<Record<string, string | undefined>>,
  chapters: readonly ChapterRow[],
): string => {
  const lines = [';FFMETADATA1'];
  for (const [key, value] of Object.entries(metadata)) if (value !== undefined && value !== '') lines.push(`${key}=${escapeFfmetadata(value)}`);
  for (const chapter of chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.max(0, Math.round(chapter.startSeconds * 1000))}`,
      `END=${Math.max(1, Math.round(chapter.endSeconds * 1000))}`,
      `title=${escapeFfmetadata(chapter.title)}`,
    );
  }
  return `${lines.join('\n')}\n`;
};

const concatDocument = (paths: readonly string[]): string => paths.map((path) => (
  `file '${resolve(path).replaceAll("'", "'\\''")}'\n`
)).join('');

const audioHash = async (path: string, process: MediaProcess, ffmpeg: string, signal?: AbortSignal): Promise<string> => {
  const result = await process(ffmpeg, [
    '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-',
  ], { signal });
  return result.stdout.trim().replace(/^SHA256=/u, '');
};

const findM4b = async (root: string): Promise<string[]> => {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.m4b') results.push(path);
    }
  }
  return results.sort(naturalCompare);
};

const assertConversionProperties = (records: readonly MediaRecord[], codec: 'aac' | 'alac'): void => {
  const uniform = uniformAudioProperties(records);
  const layout = String(uniform.channelLayout ?? '').toLowerCase();
  if (codec === 'alac') {
    const safeLayouts = new Set(['mono', 'stereo', '3.0', '4.0', '5.0', '5.1']);
    if (Number(uniform.channels ?? 0) > 6 || (layout !== '' && !safeLayouts.has(layout))) {
      throw new CuratorError(`ALAC would drop or rematrix ${uniform.channels}-channel ${String(uniform.channelLayout ?? 'unknown-layout')} audio.`);
    }
    const bitDepth = Math.max(...records.map((record) => record.bitDepth ?? 0));
    if (bitDepth > 24) throw new CuratorError(`ALAC encoding truncates ${bitDepth}-bit source audio to 24-bit.`);
  } else if (Number(uniform.sampleRate ?? 0) > 96_000) {
    throw new CuratorError(`Native AAC would downsample ${uniform.sampleRate} Hz audio to 96 kHz.`);
  }
};

export const convertAudiobook = async (
  input: ConvertInput,
  dependencies: ConversionDependencies = {},
): Promise<ConvertReceipt> => {
  const paths = await selectedPaths(input.selection);
  const outputCandidate = resolve(input.output);
  const output = extname(outputCandidate).toLowerCase() === '.m4b'
    ? outputCandidate
    : join(outputCandidate, `${safeFilename(input.title)}.m4b`);
  if (paths.some((path) => path === output)) throw new CuratorError('Convert output must differ from the source.');
  const records = await Promise.all(paths.map((path) => probeMediaRecord(path, dirname(path), dependencies)));
  const expectedDuration = records.reduce((total, record) => total + record.durationSeconds, 0);
  const commonRoot = commonDirectory(paths);
  const preserveSingle = paths.length === 1 && extname(paths[0]!).toLowerCase() === '.m4b';
  const codec = input.audioCodec ?? 'aac';
  const engine = preserveSingle ? 'ffmpeg' : input.engine ?? 'ffmpeg';
  const cpuCount = dependencies.cpuCount ?? 1;
  const intraFile = engine === 'ffmpeg' && codec === 'alac' && !preserveSingle;
  const requestedJobs = resolveJobs(input.jobs ?? 0, paths.length, cpuCount, intraFile);
  const chunks = intraFile ? alacChunkCounts(records.map((record) => record.durationSeconds), requestedJobs) : records.map(() => 1);
  const jobs = Math.min(requestedJobs, chunks.reduce((total, count) => total + count, 0));
  if (!preserveSingle && engine === 'ffmpeg') assertConversionProperties(records, codec);
  const sourceDetails = preserveSingle ? await probeMediaDetails(paths[0]!, dependencies) : undefined;
  const existingChapters = sourceDetails === undefined ? [] : chapterRows(sourceDetails);
  const expectedChapters: ChapterRow[] = existingChapters.length > 0 ? [...existingChapters] : [];
  if (expectedChapters.length === 0) {
    let start = 0;
    for (let index = 0; index < paths.length; index += 1) {
      const end = start + records[index]!.durationSeconds;
      expectedChapters.push(Object.freeze({ endSeconds: end, number: index + 1, startSeconds: start, title: chapterTitle(paths[index]!, commonRoot) }));
      start = end;
    }
  }
  const metadata = Object.freeze(Object.fromEntries(Object.entries({
    album: input.title,
    album_artist: input.author,
    artist: input.author,
    composer: input.narrator,
    date: input.year,
    language: input.language,
    title: input.title,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const segmentTranscode = engine === 'ffmpeg' && !preserveSingle && (jobs > 1 || (codec === 'alac' && paths.length > 1));
  const base = {
    apply: input.apply === true,
    audioMode: preserveSingle ? 'stream-copy' : engine === 'audiobook-forge'
      ? 'Audiobook Forge source quality'
      : `${codec.toUpperCase()}${segmentTranscode ? ' parallel-segment' : ''} transcode`,
    embeddedMetadata: metadata,
    engine,
    expectedChapterCount: expectedChapters.length,
    expectedChapters: Object.freeze(expectedChapters),
    expectedDurationSeconds: expectedDuration,
    filenamePolicy: 'apostrophes removed from filesystem name; embedded punctuation retained',
    generatedAt: utcNow(),
    inputs: Object.freeze(paths),
    jobs,
    mutation: input.apply === true,
    operation: 'convert' as const,
    output,
    sourcesPreserved: true as const,
  };
  if (input.apply !== true) {
    const receipt = Object.freeze<ConvertReceipt>({ ...base, status: 'planned' });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.selection, output, ...paths]);
    return receipt;
  }

  try {
    await access(output);
    if (input.overwrite !== true) throw new CuratorError(`Output exists; refusing to overwrite: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const work = await mkdtemp(join(dirname(output), '.audiobook-curator-convert-'));
  const temporary = join(work, 'output.m4b');
  const process = dependencies.process ?? runMediaProcess;
  const ffmpeg = dependencies.ffmpeg ?? 'ffmpeg';
  try {
    const metadataPath = join(work, 'metadata.txt');
    await writeFile(metadataPath, preserveSingle && existingChapters.length > 0
      ? chapterMetadataDocument(metadata, existingChapters)
      : metadataDocument(paths, commonRoot, metadata, records.map((record) => record.durationSeconds)));
    if (engine === 'audiobook-forge' && !preserveSingle) {
      const forgeRoot = join(work, 'forge-root');
      const forgeBook = join(forgeRoot, safeFilename(input.title));
      const forgeOutput = join(work, 'forge-output');
      await mkdir(forgeBook, { recursive: true });
      await mkdir(forgeOutput);
      for (let index = 0; index < paths.length; index += 1) {
        const staged = join(forgeBook, `${String(index + 1).padStart(6, '0')} - ${chapterTitle(paths[index]!, commonRoot)}${extname(paths[index]!).toLowerCase()}`);
        try {
          await link(paths[index]!, staged);
        } catch {
          await symlink(paths[index]!, staged);
        }
      }
      if (input.artwork !== undefined) await copyFile(resolve(input.artwork), join(forgeBook, `cover${extname(input.artwork).toLowerCase()}`));
      const forgeArguments = ['build', '--root', forgeRoot, '--out', forgeOutput, '--parallel', String(jobs), '--skip-existing', 'false', '--quality', 'source', '--aac-encoder', input.forgeAacEncoder ?? 'auto', '--chapter-source', 'files'];
      if (input.language !== undefined) forgeArguments.push('--language', input.language);
      await process(input.forgeCli ?? 'audiobook-forge', forgeArguments, { signal: dependencies.signal });
      const results = await findM4b(forgeOutput);
      if (results.length !== 1) throw new CuratorError(`Audiobook Forge produced ${results.length} M4B files; expected exactly one.`);
      await process(ffmpeg, ['-v', 'error', '-xerror', '-i', results[0]!, '-f', 'ffmetadata', '-i', metadataPath, '-map', '0:a:0', '-map', '0:v?', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-movflags', '+faststart', temporary], { signal: dependencies.signal });
    } else if (segmentTranscode) {
      const segmentRoot = join(work, 'segments');
      await mkdir(segmentRoot);
      const workSources: Array<{ owner: number; path: string }> = [];
      for (let index = 0; index < paths.length; index += 1) {
        if (codec !== 'alac' || chunks[index] === 1) {
          workSources.push({ owner: index, path: paths[index]! });
          continue;
        }
        const pattern = join(segmentRoot, `chunk-${String(index).padStart(6, '0')}-%05d.wav`);
        await process(ffmpeg, ['-v', 'error', '-xerror', '-i', paths[index]!, '-map', '0:a:0', '-f', 'segment', '-segment_time', String(records[index]!.durationSeconds / chunks[index]!), '-c:a', (records[index]!.bitDepth ?? 0) <= 16 ? 'pcm_s16le' : 'pcm_s24le', pattern], { signal: dependencies.signal });
        const handle = await opendir(segmentRoot);
        const found: string[] = [];
        for await (const entry of handle) if (entry.isFile() && entry.name.startsWith(`chunk-${String(index).padStart(6, '0')}-`)) found.push(join(segmentRoot, entry.name));
        found.sort(naturalCompare);
        workSources.push(...found.map((path) => ({ owner: index, path })));
      }
      const segments = workSources.map((_, index) => join(segmentRoot, `${String(index + 1).padStart(6, '0')}.m4a`));
      await mapWithConcurrency(workSources.map((source, index) => ({ segment: segments[index]!, source })), jobs, async ({ segment, source }) => {
        const args = ['-v', 'error', '-xerror', '-i', source.path, '-map', '0:a:0'];
        if (codec === 'alac') args.push('-c:a', 'alac');
        else args.push('-c:a', 'aac', '-b:a', input.audioBitrate ?? '128k', '-use_editlist', '0');
        args.push(segment);
        await process(ffmpeg, args, { signal: dependencies.signal });
      });
      const segmentRecords = await Promise.all(segments.map((segment) => probeMediaRecord(segment, segmentRoot, dependencies)));
      uniformAudioProperties(segmentRecords, ['codec', 'sampleRate', 'channels', 'channelLayout', 'bitDepth', 'sampleFormat'], 'conversion segments');
      const concat = join(work, 'concat.txt');
      await writeFile(concat, concatDocument(segments));
      await process(ffmpeg, ['-v', 'error', '-xerror', '-f', 'concat', '-safe', '0', '-i', concat, '-f', 'ffmetadata', '-i', metadataPath, '-map', '0:a:0', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'copy', '-movflags', '+faststart', temporary], { signal: dependencies.signal });
    } else {
      const concat = join(work, 'concat.txt');
      await writeFile(concat, concatDocument(paths));
      const args = ['-v', 'error', '-xerror', '-f', 'concat', '-safe', '0', '-i', concat, '-f', 'ffmetadata', '-i', metadataPath];
      if (input.artwork !== undefined) args.push('-i', resolve(input.artwork));
      args.push('-map', '0:a:0', '-map_metadata', '1', '-map_chapters', '1');
      if (preserveSingle) args.push('-c:a', 'copy');
      else if (codec === 'alac') args.push('-c:a', 'alac');
      else args.push('-c:a', 'aac', '-b:a', input.audioBitrate ?? '128k');
      if (input.artwork !== undefined) args.push('-map', '2:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
      if (input.language !== undefined) args.push('-metadata:s:a:0', `language=${input.language}`);
      args.push('-movflags', '+faststart', temporary);
      await process(ffmpeg, args, { signal: dependencies.signal });
    }

    const staged = await probeMediaRecord(temporary, work, dependencies);
    const details = await probeMediaDetails(temporary, dependencies);
    const actualChapters = chapterRows(details);
    const durationDelta = Math.abs(staged.durationSeconds - expectedDuration);
    if (durationDelta > 2 || chapterMappingIssues(expectedChapters, actualChapters).length > 0) {
      throw new CuratorError('Converted output failed chapter-count or duration verification; destination left untouched.');
    }
    const stagedAudioHash = await audioHash(temporary, process, ffmpeg, dependencies.signal);
    if (preserveSingle && stagedAudioHash !== await audioHash(paths[0]!, process, ffmpeg, dependencies.signal)) {
      throw new CuratorError('Single-M4B stream copy changed audio; destination left untouched.');
    }
    await rename(temporary, output);
    await syncFile(output);
    await syncDirectory(dirname(output));
    const outputMetadata = await lstat(output);
    const receipt = Object.freeze<ConvertReceipt>({
      ...base,
      audioSha256: stagedAudioHash,
      durationDeltaSeconds: durationDelta,
      outputBytes: outputMetadata.size,
      outputSha256: await sha256File(output),
      probe: staged,
      status: 'converted-verified',
    });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.selection, output, ...paths]);
    return receipt;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};
