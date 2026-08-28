import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  audibleCandidateEvidence,
  cacheAudibleEdition,
  searchAudible,
  selectAudibleEdition,
  type CuratorHttpClient,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

const product = {
  asin: 'B012345678',
  authors: [{ name: 'Ursula K. Le Guin' }],
  format_type: 'Unabridged',
  language: 'English',
  narrators: [{ name: 'Rob Inglis' }],
  product_images: { 500: 'https://images.example/cover.jpg' },
  runtime_length_min: 600,
  sample_url: 'https://audio.example/sample.mp3',
  subtitle: 'The Complete Edition',
  title: 'A Wizard of Earthsea',
};

describe('Audible parity', () => {
  it('preserves the reviewed score and strict identity policy', () => {
    expect(audibleCandidateEvidence({
      author: 'Ursula K Le Guin',
      durationSeconds: 36_000,
      narrator: 'Rob Inglis',
      title: 'A Wizard of Earthsea',
    }, product)).toMatchObject({
      authorMatch: true,
      durationDifferencePercent: 0,
      languageMatch: true,
      narratorMatch: true,
      score: 120,
      strictIdentityMatch: true,
      titleMatch: true,
      unabridged: true,
    });
    expect(audibleCandidateEvidence({ title: 'A Wizard of Earthsea' }, { ...product, format_type: 'Abridged' }))
      .toMatchObject({ score: 65, strictIdentityMatch: false, unabridged: false });
  });

  it('omits unavailable facets instead of emitting non-JSON undefined values', () => {
    const evidence = audibleCandidateEvidence({ title: 'Unknown' }, { title: 'Unknown' });
    expect(evidence).not.toHaveProperty('durationDifferencePercent');
    expect(evidence).not.toHaveProperty('language');
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });

  it('retains regional errors and requires a human choice', async () => {
    const http: CuratorHttpClient = async (url) => {
      if (url.includes('audible.co.uk')) throw new Error('regional outage');
      return { products: [product] };
    };
    const report = await searchAudible({
      author: 'Ursula K Le Guin', durationSeconds: 36_000, regions: ['us', 'uk'], title: 'A Wizard of Earthsea',
    }, { http });
    expect(report).toMatchObject({ exitCode: 0, humanReviewRequired: true, operation: 'audible-search' });
    expect(report.candidates).toHaveLength(1);
    expect(report.errors).toEqual([{ error: 'regional outage', region: 'uk' }]);

    const selected = selectAudibleEdition(report, { candidate: 1, note: 'Matched narrator and running time.' });
    expect(selected).toMatchObject({ candidateNumber: 1, humanReviewed: true, operation: 'audible-select' });
    expect(() => selectAudibleEdition(report, { candidate: 2 })).toThrow('between 1 and 1');
  });

  it('caches product, chapters, artwork, and source URLs while retaining chapter failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-audible-'));
    roots.push(root);
    const http: CuratorHttpClient = async (url, options) => {
      if (url.includes('/metadata')) throw new Error('chapters unavailable');
      if (options?.binary) return Buffer.from('cover');
      return { product };
    };
    const receipt = await cacheAudibleEdition({ asin: product.asin, cacheDirectory: root, region: 'us' }, { http });

    expect(receipt).toMatchObject({
      artwork: join(root, `us-${product.asin}`, 'cover.jpg'),
      chapterError: 'chapters unavailable',
      mediaMutation: false,
      operation: 'audible-cache',
      product: join(root, `us-${product.asin}`, 'product.json'),
    });
    expect('chapters' in receipt).toBe(false);
  });
});
