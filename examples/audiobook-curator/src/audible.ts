import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

import type { JsonObject } from '@agent-bundle/runtime';

import {
  CuratorError,
  audibleHosts,
  contributorNames,
  errorMessage,
  normalizedIdentity,
  syncDirectory,
  syncFile,
  utcNow,
  writeReceipt,
} from './foundation.ts';

export type AudibleRegion = keyof typeof audibleHosts;

export interface CuratorHttpOptions {
  readonly binary?: boolean;
  readonly signal?: AbortSignal;
}

export type CuratorHttpClient = (url: string, options?: CuratorHttpOptions) => Promise<unknown>;

export type AudibleQuery = {
  readonly author?: string;
  readonly durationSeconds?: number;
  readonly narrator?: string;
  readonly title: string;
};

export type AudibleCandidateEvidence = {
  readonly authorMatch: boolean;
  readonly durationDifferencePercent?: number;
  readonly language?: string;
  readonly languageMatch: boolean;
  readonly narratorMatch: boolean;
  readonly score: number;
  readonly strictIdentityMatch: boolean;
  readonly titleMatch: boolean;
  readonly unabridged: boolean;
};

export type AudibleCandidate = JsonObject & {
  readonly evidence: AudibleCandidateEvidence;
  readonly region: AudibleRegion;
};

export interface AudibleSearchInput extends AudibleQuery {
  readonly attempts?: number;
  readonly limit?: number;
  readonly regions?: readonly AudibleRegion[];
  readonly report?: string;
}

export type AudibleSearchReceipt = {
  readonly candidates: readonly AudibleCandidate[];
  readonly errors: readonly { readonly error: string; readonly region: AudibleRegion }[];
  readonly exitCode: 0 | 1;
  readonly generatedAt: string;
  readonly humanReviewRequired: true;
  readonly mutation: false;
  readonly operation: 'audible-search';
  readonly query: AudibleQuery;
  readonly reviewNote: string;
};

export type AudibleSelectionReceipt = {
  readonly candidateNumber: number;
  readonly candidateReport?: string;
  readonly generatedAt: string;
  readonly humanReviewed: true;
  readonly mutation: false;
  readonly operation: 'audible-select';
  readonly reviewNote?: string;
  readonly selected: AudibleCandidate;
};

export interface AudibleCacheInput {
  readonly asin: string;
  readonly attempts?: number;
  readonly cacheDirectory: string;
  readonly receipt?: string;
  readonly region?: AudibleRegion;
}

export type AudibleCacheReceipt = {
  readonly artwork?: string;
  readonly asin: string;
  readonly chapterError?: string;
  readonly chapters?: string;
  readonly generatedAt: string;
  readonly mediaMutation: false;
  readonly mutation: true;
  readonly operation: 'audible-cache';
  readonly product: string;
  readonly region: AudibleRegion;
  readonly sourceUrls: {
    readonly artwork?: string;
    readonly chapters: string;
    readonly product: string;
  };
};

export interface AudibleDependencies {
  readonly http?: CuratorHttpClient;
  readonly signal?: AbortSignal;
}

const objects = (value: unknown): JsonObject[] => Array.isArray(value)
  ? value.filter((row): row is JsonObject => row !== null && typeof row === 'object' && !Array.isArray(row))
  : [];

export const audibleCandidateEvidence = (
  query: AudibleQuery,
  product: Readonly<Record<string, unknown>>,
): AudibleCandidateEvidence => {
  const actualTitle = `${String(product.title ?? '')} ${String(product.subtitle ?? '')}`;
  const authors = contributorNames(product.authors);
  const narrators = contributorNames(product.narrators);
  const candidateSeconds = Number(product.runtime_length_min ?? 0) * 60;
  const difference = query.durationSeconds !== undefined && query.durationSeconds > 0 && candidateSeconds > 0
    ? Math.abs(candidateSeconds - query.durationSeconds) / query.durationSeconds * 100
    : undefined;
  const expectedTitle = normalizedIdentity(query.title);
  const foundTitle = normalizedIdentity(actualTitle);
  const titleMatch = expectedTitle.includes(foundTitle) || foundTitle.includes(expectedTitle);
  const authorMatch = query.author === undefined || authors.some((name) => normalizedIdentity(name).includes(normalizedIdentity(query.author!)));
  const narratorMatch = query.narrator === undefined || narrators.some((name) => normalizedIdentity(name).includes(normalizedIdentity(query.narrator!)));
  const language = String(product.language ?? product.language_name ?? '').toLowerCase();
  const languageMatch = ['en', 'eng', 'english'].includes(language);
  const unabridged = String(product.format_type ?? '').toLowerCase() !== 'abridged';
  let score = (titleMatch ? 40 : 0) + (authorMatch ? 25 : 0) + (narratorMatch ? 15 : -15)
    + (languageMatch ? 10 : -10) + (unabridged ? 10 : -25);
  if (difference !== undefined) score += Math.max(-20, 20 - difference * 4);
  return Object.freeze({
    authorMatch,
    ...(difference === undefined ? {} : { durationDifferencePercent: difference }),
    ...(language === '' ? {} : { language }),
    languageMatch,
    narratorMatch,
    score,
    strictIdentityMatch: titleMatch && authorMatch && narratorMatch && languageMatch && unabridged
      && (difference === undefined || difference <= 2),
    titleMatch,
    unabridged,
  });
};

const audibleUrl = (region: AudibleRegion, route: string, query: Readonly<Record<string, string | number>>): string => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) parameters.set(key, String(value));
  return `https://${audibleHosts[region]}${route}?${parameters.toString()}`;
};

const responseBytes = async (response: Response, maximumBytes: number): Promise<Buffer> => {
  if (!response.ok) throw new CuratorError(`HTTP ${response.status} ${response.statusText}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maximumBytes) throw new CuratorError(`Response exceeds ${maximumBytes} bytes.`);
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new CuratorError(`Response exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, total);
};

export const defaultCuratorHttpClient: CuratorHttpClient = async (url, options = {}) => {
  const bytes = await responseBytes(await fetch(url, {
    headers: { 'user-agent': 'agent-bundle-audiobook-curator/1.0' },
    signal: options.signal,
  }), options.binary === true ? 64 * 1024 * 1024 : 16 * 1024 * 1024);
  if (options.binary === true) return bytes;
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
};

export const requestWithAttempts = async (
  http: CuratorHttpClient,
  url: string,
  attempts: number,
  options: CuratorHttpOptions,
): Promise<unknown> => {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await http(url, options);
    } catch (error) {
      failure = error;
    }
  }
  throw new CuratorError(errorMessage(failure, `Request failed: ${url}`));
};

export const searchAudible = async (
  input: AudibleSearchInput,
  dependencies: AudibleDependencies = {},
): Promise<AudibleSearchReceipt> => {
  const regions = input.regions ?? ['us'];
  if (regions.length === 0 || regions.length > Object.keys(audibleHosts).length || new Set(regions).size !== regions.length) {
    throw new CuratorError('Audible regions must be a unique, nonempty supported list.');
  }
  const http = dependencies.http ?? defaultCuratorHttpClient;
  const attempts = Math.max(1, Math.min(input.attempts ?? 4, 10));
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const candidates: AudibleCandidate[] = [];
  const errors: { error: string; region: AudibleRegion }[] = [];
  for (const region of regions) {
    const url = audibleUrl(region, '/1.0/catalog/products', {
      ...(input.author === undefined ? {} : { author: input.author }),
      num_results: limit,
      products_sort_by: 'Relevance',
      response_groups: 'contributors,media,product_desc,product_extended_attrs,sample',
      title: input.title,
    });
    try {
      const payload = await requestWithAttempts(http, url, attempts, { signal: dependencies.signal });
      const rows = objects((payload as Record<string, unknown> | null)?.products).slice(0, limit);
      candidates.push(...rows.map((product) => Object.freeze({
        ...product,
        evidence: audibleCandidateEvidence(input, product),
        region,
      })));
    } catch (error) {
      errors.push({ error: errorMessage(error, 'Audible search failed.'), region });
    }
  }
  candidates.sort((left, right) => right.evidence.score - left.evidence.score);
  const receipt = Object.freeze<AudibleSearchReceipt>({
    candidates: Object.freeze(candidates),
    errors: Object.freeze(errors),
    exitCode: candidates.length === 0 ? 1 : 0,
    generatedAt: utcNow(),
    humanReviewRequired: true,
    mutation: false,
    operation: 'audible-search',
    query: Object.freeze({
      ...(input.author === undefined ? {} : { author: input.author }),
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      ...(input.narrator === undefined ? {} : { narrator: input.narrator }),
      title: input.title,
    }),
    reviewNote: 'Ranking is evidence only; a human must select the matching recording and edition.',
  });
  if (input.report !== undefined) await writeReceipt(input.report, receipt);
  return receipt;
};

export const selectAudibleEdition = (
  report: Pick<AudibleSearchReceipt, 'candidates'>,
  input: { readonly candidate: number; readonly candidateReport?: string; readonly note?: string },
): AudibleSelectionReceipt => {
  const selected = report.candidates[input.candidate - 1];
  if (selected === undefined) throw new CuratorError(`candidate must be between 1 and ${report.candidates.length}`);
  return Object.freeze({
    candidateNumber: input.candidate,
    ...(input.candidateReport === undefined ? {} : { candidateReport: resolve(input.candidateReport) }),
    generatedAt: utcNow(),
    humanReviewed: true,
    mutation: false,
    operation: 'audible-select',
    ...(input.note === undefined ? {} : { reviewNote: input.note }),
    selected,
  });
};

const writeBinary = async (path: string, bytes: Buffer): Promise<void> => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.audiobook-curator-download-'));
  const staged = join(staging, 'payload');
  try {
    await writeFile(staged, bytes, { mode: 0o600 });
    await syncFile(staged);
    await rename(staged, path);
    await syncDirectory(parent);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
};

export const cacheAudibleEdition = async (
  input: AudibleCacheInput,
  dependencies: AudibleDependencies = {},
): Promise<AudibleCacheReceipt> => {
  const region = input.region ?? 'us';
  if (!(region in audibleHosts)) throw new CuratorError(`Unsupported Audible region: ${region}`);
  const attempts = Math.max(1, Math.min(input.attempts ?? 4, 10));
  const http = dependencies.http ?? defaultCuratorHttpClient;
  const productUrl = audibleUrl(region, `/1.0/catalog/products/${encodeURIComponent(input.asin)}`, {
    response_groups: 'contributors,category_ladders,media,product_desc,product_extended_attrs,sample',
  });
  const productPayload = await requestWithAttempts(http, productUrl, attempts, { signal: dependencies.signal });
  const product = (productPayload as Record<string, unknown> | null)?.product;
  if (product === null || typeof product !== 'object' || Array.isArray(product)) throw new CuratorError('Audible product response is invalid.');
  const productRecord = product as Record<string, unknown>;
  const cache = join(resolve(input.cacheDirectory), `${region}-${input.asin}`);
  await mkdir(cache, { recursive: true });
  const productPath = join(cache, 'product.json');
  await writeReceipt(productPath, productRecord);
  const chapterUrl = audibleUrl(region, `/1.0/content/${encodeURIComponent(input.asin)}/metadata`, { response_groups: 'chapter_info' });
  let chapterPath: string | undefined;
  let chapterError: string | undefined;
  try {
    const chapters = await requestWithAttempts(http, chapterUrl, attempts, { signal: dependencies.signal });
    chapterPath = join(cache, 'chapters.json');
    await writeReceipt(chapterPath, chapters);
  } catch (error) {
    chapterError = errorMessage(error, 'Audible chapter request failed.');
  }
  const images = productRecord.product_images;
  const imageUrl = images !== null && typeof images === 'object' && !Array.isArray(images)
    ? ([('1000'), ('500')] as const).map((key) => (images as Record<string, unknown>)[key]).find((value): value is string => typeof value === 'string')
    : undefined;
  let artworkPath: string | undefined;
  if (imageUrl !== undefined) {
    const bytes = await requestWithAttempts(http, imageUrl, attempts, { binary: true, signal: dependencies.signal });
    if (!Buffer.isBuffer(bytes)) throw new CuratorError('Audible artwork response is not binary.');
    artworkPath = join(cache, extname(new URL(imageUrl).pathname).toLowerCase() === '.png' ? 'cover.png' : 'cover.jpg');
    await writeBinary(artworkPath, bytes);
  }
  const receipt = Object.freeze<AudibleCacheReceipt>({
    ...(artworkPath === undefined ? {} : { artwork: artworkPath }),
    asin: input.asin,
    ...(chapterError === undefined ? {} : { chapterError }),
    ...(chapterPath === undefined ? {} : { chapters: chapterPath }),
    generatedAt: utcNow(),
    mediaMutation: false,
    mutation: true,
    operation: 'audible-cache',
    product: productPath,
    region,
    sourceUrls: Object.freeze({
      ...(imageUrl === undefined ? {} : { artwork: imageUrl }),
      chapters: chapterUrl,
      product: productUrl,
    }),
  });
  if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [productPath, chapterPath, artworkPath]);
  return receipt;
};
