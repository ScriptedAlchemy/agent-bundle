import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { JsonObject, JsonValue } from '@agent-bundle/runtime';

import {
  defaultCuratorHttpClient,
  requestWithAttempts,
  type AudibleRegion,
  type CuratorHttpClient,
} from './audible.ts';
import { CuratorError, asRecord, audibleHosts, contributorNames, errorMessage, readJson, utcNow, writeReceipt } from './foundation.ts';
import { probeMediaRecord, type LibraryDependencies } from './library.ts';
import { runMediaProcess, type MediaProcess } from './media-process.ts';

export interface AcousticMatchOptions {
  readonly chunkSeconds: number;
  readonly signal?: AbortSignal;
  readonly verbose: boolean;
}

export type AcousticMatcher = (
  source: string,
  sample: string,
  options: AcousticMatchOptions,
) => Promise<JsonObject>;

export interface AcousticVerifyInput {
  readonly audiolocatePython?: string;
  readonly asin: string;
  readonly attempts?: number;
  readonly chunkSeconds?: number;
  readonly file: string;
  readonly receipt?: string;
  readonly region?: AudibleRegion;
  readonly sampleUrl?: string;
  readonly verbose?: boolean;
}

export type AcousticReceipt = {
  readonly asin: string;
  readonly audible: JsonObject;
  readonly exitCode: 0 | 2;
  readonly file: string;
  readonly fingerprint: JsonObject;
  readonly generatedAt: string;
  readonly mutation: false;
  readonly operation: 'audiolocate';
  readonly region: AudibleRegion;
  readonly verifiedRecording: boolean;
};

export interface AcousticIdentifyInput {
  readonly all?: boolean;
  readonly attempts?: number;
  readonly candidates: readonly JsonObject[];
  readonly candidatesReport: string;
  readonly chunkSeconds?: number;
  readonly file: string;
  readonly receipt?: string;
  readonly top?: number;
  readonly verbose?: boolean;
}

export type AcousticIdentifyReceipt = {
  readonly attempts: readonly JsonObject[];
  readonly candidatesReport: string;
  readonly exitCode: 0 | 2;
  readonly file: string;
  readonly generatedAt: string;
  readonly identified?: Readonly<{ readonly asin: string; readonly region: string; readonly title?: JsonValue }>;
  readonly mutation: false;
  readonly operation: 'acoustic-identify';
  readonly reviewNote: string;
  readonly stopOnMatch: boolean;
  readonly top: number;
  readonly verifiedRecording: boolean;
};

type AcousticIdentifyAttempt = {
  readonly asin?: string;
  readonly fingerprint?: JsonObject;
  readonly reason?: string;
  readonly region: AudibleRegion;
  readonly sampleUrl?: JsonValue;
  readonly score?: JsonValue;
  readonly status: 'error' | 'matched' | 'no-match' | 'skipped';
  readonly title?: JsonValue;
};

export interface WhisperInput {
  readonly author?: string;
  readonly file: string;
  readonly language?: string;
  readonly maxWindows?: number;
  readonly minimumChars?: number;
  readonly model: string;
  readonly receipt?: string;
  readonly threads?: number;
  readonly title?: string;
  readonly whisperCli?: string;
  readonly windowSeconds?: number;
}

export type WhisperWindow = {
  readonly index: number;
  readonly sampleSeconds: number;
  readonly startSeconds: number;
  readonly text: string;
  readonly usable: boolean;
};

export type WhisperReceipt = {
  readonly exitCode: 0 | 2;
  readonly expectedAuthor?: string;
  readonly expectedTitle?: string;
  readonly file: string;
  readonly generatedAt: string;
  readonly maxWindows: number;
  readonly model: string;
  readonly mutation: false;
  readonly operation: 'whisper-identity';
  readonly requestedLanguage: string;
  readonly review: string;
  readonly status: 'insufficient-spoken-windows' | 'transcript-ready';
  readonly usableWindows: number;
  readonly windows: readonly WhisperWindow[];
};

export interface EvidenceDependencies extends LibraryDependencies {
  readonly audiolocatePython?: string;
  readonly ffmpeg?: string;
  readonly http?: CuratorHttpClient;
  readonly matcher?: AcousticMatcher;
  readonly process?: MediaProcess;
}

const pythonMatcher = (python: string, process: MediaProcess): AcousticMatcher => async (source, sample, options) => {
  const resultMarker = '__AGENT_BUNDLE_AUDIOLOCATE_RESULT__';
  const script = [
    'import json,sys',
    'from audiolocate import StreamMatcher',
    'result=StreamMatcher().find_match_from_sources(sys.argv[1],sys.argv[2],chunk_seconds=int(sys.argv[3]),early_exit=True,verbose=sys.argv[4]=="1")',
    `print(${JSON.stringify(resultMarker)}+json.dumps(result))`,
  ].join(';');
  try {
    const result = await process(python, ['-c', script, source, sample, String(options.chunkSeconds), options.verbose ? '1' : '0'], { signal: options.signal });
    const line = result.stdout.split(/\r?\n/u).findLast((candidate) => candidate.startsWith(resultMarker));
    if (line === undefined) throw new CuratorError('Audiolocate emitted no structured result.');
    const parsed = JSON.parse(line.slice(resultMarker.length)) as JsonObject;
    asRecord(parsed);
    return Object.freeze(parsed);
  } catch (error) {
    throw new CuratorError(`Audiolocate is optional; install it for ${python}, or inject an acoustic matcher. ${errorMessage(error, '')}`.trim());
  }
};

const productUrl = (region: AudibleRegion, asin: string): string => {
  const groups = new URLSearchParams({ response_groups: 'contributors,media,product_desc,product_extended_attrs,sample' });
  return `https://${audibleHosts[region]}/1.0/catalog/products/${encodeURIComponent(asin)}?${groups.toString()}`;
};

const sampleMatch = async (
  input: AcousticVerifyInput,
  dependencies: EvidenceDependencies,
): Promise<{ audible: JsonObject; fingerprint: JsonObject }> => {
  const region = input.region ?? 'us';
  const attempts = Math.max(1, Math.min(input.attempts ?? 4, 10));
  const http = dependencies.http ?? defaultCuratorHttpClient;
  let sampleUrl = input.sampleUrl;
  let audible: Record<string, unknown> = { sampleUrl };
  if (sampleUrl === undefined) {
    const payload = asRecord(await requestWithAttempts(http, productUrl(region, input.asin), attempts, { signal: dependencies.signal }));
    const product = asRecord(payload.product);
    sampleUrl = typeof product.sample_url === 'string' ? product.sample_url : undefined;
    audible = {
      authors: contributorNames(product.authors),
      narrators: contributorNames(product.narrators),
      sampleUrl,
      title: product.title,
    };
  }
  if (sampleUrl === undefined || sampleUrl === '') throw new CuratorError('Audible candidate has no sample URL');
  const bytes = await requestWithAttempts(http, sampleUrl, attempts, { binary: true, signal: dependencies.signal });
  if (!Buffer.isBuffer(bytes)) throw new CuratorError('Audible sample response is not binary.');
  const work = await mkdtemp(join(tmpdir(), 'audiobook-curator-acoustic-'));
  const sample = join(work, 'sample.mp3');
  try {
    await writeFile(sample, bytes, { mode: 0o600 });
    const matcher = dependencies.matcher ?? pythonMatcher(dependencies.audiolocatePython ?? 'python3', dependencies.process ?? runMediaProcess);
    const fingerprint = await matcher(resolve(input.file), sample, {
      chunkSeconds: input.chunkSeconds ?? 900,
      signal: dependencies.signal,
      verbose: input.verbose === true,
    });
    return { audible: Object.freeze(audible) as JsonObject, fingerprint };
  } finally { await rm(work, { force: true, recursive: true }); }
};

export const verifyAudibleSample = async (
  input: AcousticVerifyInput,
  dependencies: EvidenceDependencies = {},
): Promise<AcousticReceipt> => {
  const file = resolve(input.file);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new CuratorError('Acoustic source must be one regular file.');
  const region = input.region ?? 'us';
  const outcome = await sampleMatch(input, {
    ...dependencies,
    audiolocatePython: input.audiolocatePython ?? dependencies.audiolocatePython,
  });
  const verifiedRecording = outcome.fingerprint.found === true;
  const receipt = Object.freeze<AcousticReceipt>({
    asin: input.asin,
    audible: outcome.audible,
    exitCode: verifiedRecording ? 0 : 2,
    file,
    fingerprint: outcome.fingerprint,
    generatedAt: utcNow(),
    mutation: false,
    operation: 'audiolocate',
    region,
    verifiedRecording,
  });
  if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [file]);
  return receipt;
};

export const identifyAudibleSample = async (
  input: AcousticIdentifyInput,
  dependencies: EvidenceDependencies = {},
): Promise<AcousticIdentifyReceipt> => {
  const ranked = [...input.candidates].filter((candidate) => candidate !== null && typeof candidate === 'object')
    .sort((left, right) => Number(asRecord(right.evidence).score ?? 0) - Number(asRecord(left.evidence).score ?? 0));
  const seen = new Set<string>();
  const unique = ranked.filter((candidate) => {
    const asin = String(candidate.asin ?? '');
    if (asin === '' || !seen.has(asin)) {
      if (asin !== '') seen.add(asin);
      return true;
    }
    return false;
  });
  const top = Math.max(1, Math.min(input.top ?? 3, 10));
  const selected = input.all === true ? unique : unique.slice(0, top);
  const attempts: AcousticIdentifyAttempt[] = [];
  let identified: { asin: string; region: string; title?: JsonValue } | undefined;
  for (const candidate of selected) {
    const asin = String(candidate.asin ?? '');
    const region = String(candidate.region ?? 'us') as AudibleRegion;
    const base = {
      asin: asin || undefined,
      region,
      score: asRecord(candidate.evidence).score as JsonValue | undefined,
      title: candidate.title,
    };
    if (asin === '') {
      attempts.push({ ...base, reason: 'candidate has no ASIN', status: 'skipped' });
      continue;
    }
    try {
      const outcome = await sampleMatch({
        asin,
        attempts: input.attempts,
        chunkSeconds: input.chunkSeconds,
        file: input.file,
        region,
        ...(typeof candidate.sample_url === 'string' ? { sampleUrl: candidate.sample_url } : {}),
        verbose: input.verbose,
      }, dependencies);
      const found = outcome.fingerprint.found === true;
      attempts.push({
        ...base,
        fingerprint: outcome.fingerprint,
        sampleUrl: outcome.audible.sampleUrl,
        status: found ? 'matched' : 'no-match',
        title: candidate.title ?? outcome.audible.title,
      });
      if (found) {
        identified ??= { asin, region, title: candidate.title ?? outcome.audible.title };
        if (input.all !== true) break;
      }
    } catch (error) {
      const reason = errorMessage(error, 'Acoustic comparison failed.');
      attempts.push({ ...base, reason, status: reason.includes('no sample URL') ? 'skipped' : 'error' });
    }
  }
  const receipt = Object.freeze<AcousticIdentifyReceipt>({
    attempts: Object.freeze(attempts.map(Object.freeze)),
    candidatesReport: resolve(input.candidatesReport),
    exitCode: identified === undefined ? 2 : 0,
    file: resolve(input.file),
    generatedAt: utcNow(),
    ...(identified === undefined ? {} : { identified: Object.freeze(identified) }),
    mutation: false,
    operation: 'acoustic-identify',
    reviewNote: 'Acoustic match is strong same-recording evidence; a human must still accept the edition with audible-select.',
    stopOnMatch: input.all !== true,
    top,
    verifiedRecording: identified !== undefined,
  });
  if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.file, input.candidatesReport]);
  return receipt;
};

export const whisperText = (payload: unknown): string => {
  const row = asRecord(payload);
  if (typeof row.transcription === 'string') return row.transcription.trim();
  if (Array.isArray(row.transcription)) return row.transcription.map((item) => String(asRecord(item).text ?? '')).join(' ').trim();
  return String(asRecord(row.result).transcription ?? '').trim();
};

export const whisperSamplingFractions = (maximumWindows: number): readonly number[] => Object.freeze(
  [0.05, 0.275, 0.5, 0.725, 0.95, 0.15, 0.85, 0.375, 0.625, 0.25, 0.75]
    .slice(0, Math.max(5, Math.min(maximumWindows, 11))),
);

export const verifyWithWhisper = async (
  input: WhisperInput,
  dependencies: EvidenceDependencies = {},
): Promise<WhisperReceipt> => {
  const file = resolve(input.file);
  const model = resolve(input.model);
  const source = await probeMediaRecord(file, dirname(file), dependencies);
  const maximumWindows = Math.max(5, Math.min(input.maxWindows ?? 9, 11));
  const windowSeconds = Math.max(1, input.windowSeconds ?? 35);
  const minimumChars = Math.max(1, input.minimumChars ?? 80);
  const process = dependencies.process ?? runMediaProcess;
  const work = await mkdtemp(join(tmpdir(), 'audiobook-curator-whisper-'));
  const windows: WhisperWindow[] = [];
  try {
    for (const [offset, fraction] of whisperSamplingFractions(maximumWindows).entries()) {
      if (offset >= 5 && windows.filter((row) => row.usable).length >= 3) break;
      const index = offset + 1;
      const start = Math.max(0, Math.min(source.durationSeconds - windowSeconds, source.durationSeconds * fraction - windowSeconds / 2));
      const wav = join(work, `window-${index}.wav`);
      const output = join(work, `window-${index}`);
      await process(dependencies.ffmpeg ?? 'ffmpeg', [
        '-v', 'error', '-xerror', '-ss', start.toFixed(3), '-i', file, '-t', String(windowSeconds),
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      ], { signal: dependencies.signal });
      await process(input.whisperCli ?? 'whisper-cli', [
        '-m', model, '-l', input.language ?? 'en', '-t', String(input.threads ?? 4), '-oj', '-of', output, '-np', wav,
      ], { signal: dependencies.signal });
      const text = whisperText(await readJson(`${output}.json`));
      windows.push(Object.freeze({
        index,
        sampleSeconds: windowSeconds,
        startSeconds: start,
        text,
        usable: text.replaceAll(/\s+/gu, ' ').length >= minimumChars,
      }));
    }
  } finally { await rm(work, { force: true, recursive: true }); }
  const usableWindows = windows.filter((row) => row.usable).length;
  const receipt = Object.freeze<WhisperReceipt>({
    exitCode: usableWindows >= 3 ? 0 : 2,
    ...(input.author === undefined ? {} : { expectedAuthor: input.author }),
    ...(input.title === undefined ? {} : { expectedTitle: input.title }),
    file,
    generatedAt: utcNow(),
    maxWindows: maximumWindows,
    model,
    mutation: false,
    operation: 'whisper-identity',
    requestedLanguage: input.language ?? 'en',
    review: 'Confirm language, title/story identity, and narrator evidence from distributed excerpts; transcript text is evidence, not automatic proof.',
    status: usableWindows >= 3 ? 'transcript-ready' : 'insufficient-spoken-windows',
    usableWindows,
    windows: Object.freeze(windows),
  });
  if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [file, model]);
  return receipt;
};
