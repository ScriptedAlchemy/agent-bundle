import { expect, it } from '@rstest/core';
import React from 'react';

import type { AudibleCandidate, AudibleSearchReceipt } from '../src/audible.js';
import { EditionCard, FileCard } from '../src/components/audiobook-card.js';
import {
  audibleSearchHeadline,
  convertHeadline,
  integrityAuditHeadline,
  inventoryHeadline,
  selectionHeadline,
} from '../src/components/headlines.js';
import { Callout, FileList } from '../src/components/primitives.js';
import { editionCardModel, fileCardModel } from '../src/components/view-models.js';
import type { ConvertReceipt } from '../src/conversion.js';
import type { InspectionReceipt } from '../src/curator-core.js';
import type { IntegrityAuditReceipt } from '../src/integrity-audit.js';
import type { InventoryReceipt, MediaRecord, SelectionReceipt } from '../src/library.js';

const media: MediaRecord = {
  bytes: 12,
  chapters: 0,
  codec: 'aac',
  durationSeconds: 90,
  extension: '.m4b',
  path: '/library/book.m4b',
  relativePath: 'book.m4b',
  sampleRate: 44_100,
  tags: {
    album_artist: 'Ursula Author',
    composer: 'Nora Narrator',
    title: 'A Book',
  },
};

it('normalizes each file-card source before rendering', () => {
  const inspected: InspectionReceipt['files'][number] = {
    bytes: 10,
    codec: 'mp3',
    durationSeconds: 65,
    format: 'mp3',
    path: '/library/inspection.mp3',
    tags: { album: 'Inspected Book', artist: 'A. Writer' },
  };

  expect(fileCardModel(inspected)).toEqual({
    author: 'A. Writer',
    durationSeconds: 65,
    format: 'mp3',
    path: '/library/inspection.mp3',
    title: 'Inspected Book',
  });
  expect(fileCardModel(media)).toEqual({
    author: 'Ursula Author',
    durationSeconds: 90,
    format: 'aac / .m4b',
    narrator: 'Nora Narrator',
    path: '/library/book.m4b',
    title: 'A Book',
  });
});

it('normalizes catalog contributors and edition metadata before rendering', () => {
  const edition: AudibleCandidate = {
    asin: 123,
    authors: [{ display_name: 'A. Writer' }],
    evidence: {
      authorMatch: true,
      languageMatch: true,
      narratorMatch: true,
      score: 100,
      strictIdentityMatch: true,
      titleMatch: true,
      unabridged: true,
    },
    format_type: 'Unabridged',
    narrators: ['N. Reader'],
    region: 'us',
    runtime_length_min: 2,
    title: 'Catalog Book',
  };

  expect(editionCardModel(edition)).toEqual({
    asin: '123',
    author: 'A. Writer',
    durationSeconds: 120,
    format: 'Unabridged',
    narrator: 'N. Reader',
    region: 'us',
    title: 'Catalog Book',
  });
});

it('exposes capitalized cards and composable primitives', () => {
  const fileModel = fileCardModel(media);
  const editionModel = editionCardModel({
    authors: [],
    narrators: [],
    title: 'Edition',
  });
  const fileCard = <FileCard {...fileModel} />;
  const editionCard = <EditionCard {...editionModel} />;
  const callout = <Callout tone="review">Review this edition.</Callout>;
  const fileList = <FileList files={['one.m4b', 'two.m4b']} />;

  expect(fileCard.type).toBe(FileCard);
  expect(editionCard.type).toBe(EditionCard);
  expect(callout.props.children).toBe('Review this edition.');
  expect(fileList.type).toBe(FileList);
});

it('builds shared receipt headlines without changing route text', () => {
  const inventory: InventoryReceipt = {
    errors: [],
    exitCode: 0,
    files: [],
    generatedAt: '2026-09-02T00:00:00.000Z',
    mutation: false,
    operation: 'inventory',
    source: '/library',
    summary: { bytes: 0, durationSeconds: 0, errors: 2, files: 7 },
  };
  const selection: SelectionReceipt = {
    generatedAt: '2026-09-02T00:00:00.000Z',
    mutation: false,
    operation: 'quality-selection',
    selections: [
      {
        alternates: [],
        durationSpreadSeconds: 0,
        identityKey: 'book',
        reason: 'best source',
        reviewReason: 'check',
        reviewRequired: true,
        selected: media,
      },
    ],
  };
  const search: AudibleSearchReceipt = {
    candidates: [],
    errors: [],
    exitCode: 0,
    generatedAt: '2026-09-02T00:00:00.000Z',
    humanReviewRequired: true,
    mutation: false,
    operation: 'audible-search',
    query: { title: 'Book' },
    reviewNote: 'Review.',
  };
  const audit: IntegrityAuditReceipt = {
    audioSha256: 'b'.repeat(64),
    bytes: 42,
    chapterIssues: [],
    chapters: [],
    exitCode: 0,
    file: media.path,
    fullDecode: 'not-requested',
    generatedAt: '2026-09-02T00:00:00.000Z',
    mutation: false,
    operation: 'audit',
    probe: media,
    sha256: 'a'.repeat(64),
    sourceChapterMapping: { issues: [], status: 'not-requested' },
    status: 'verified',
  };
  const conversion: ConvertReceipt = {
    apply: false,
    audioMode: 'copy',
    embeddedMetadata: {},
    engine: 'ffmpeg',
    expectedChapterCount: 0,
    expectedChapters: [],
    expectedDurationSeconds: 90,
    filenamePolicy: 'fixed',
    generatedAt: '2026-09-02T00:00:00.000Z',
    inputs: [media.path],
    jobs: 1,
    mutation: true,
    operation: 'convert',
    output: '/output/book.m4b',
    sourcesPreserved: true,
    status: 'planned',
  };

  expect(inventoryHeadline(inventory)).toBe('Inventoried 7 media files with 2 retained errors.');
  expect(selectionHeadline(selection)).toBe('Selected 1 source groups; 1 require review.');
  expect(audibleSearchHeadline(search)).toBe(
    'Ranked 0 Audible candidates across reviewed regions; human selection is required.',
  );
  expect(integrityAuditHeadline(audit)).toBe(
    `Audited 42 bytes with SHA-256 ${'a'.repeat(64)}; status is verified.`,
  );
  expect(convertHeadline(conversion)).toBe(
    'Planned copy output at /output/book.m4b; sources remain unchanged.',
  );
});
