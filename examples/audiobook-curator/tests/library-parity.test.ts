import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  auditLibrary,
  createInventory,
  normalizedIdentity,
  safeFilename,
  selectInventorySources,
  writeReceipt,
  type MediaProcess,
} from '../src/index.js';

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'curator-parity-'));
  roots.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

const probe = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  chapters: [],
  format: {
    bit_rate: '128000',
    duration: '1200',
    format_name: 'mp3',
    tags: { album: 'Book', artist: 'Author', title: 'Part' },
  },
  streams: [{
    bit_rate: '128000',
    channel_layout: 'stereo',
    channels: 2,
    codec_name: 'mp3',
    codec_type: 'audio',
    sample_fmt: 'fltp',
    sample_rate: '44100',
  }],
  ...overrides,
});

describe('audiobook curator library parity', () => {
  it('ports canonical text and filename normalization', () => {
    expect(safeFilename("The Author’s: Book?")).toBe('The Authors - Book');
    expect(normalizedIdentity("The Author’s Book & Other Stories")).toBe('authors book and other stories');
  });

  it('retains per-file probe errors, natural order, and ignores symlinks', async () => {
    const directory = await root();
    await writeFile(join(directory, 'Part 10.mp3'), 'ten');
    await writeFile(join(directory, 'Part 2.mp3'), 'two');
    await writeFile(join(directory, 'broken.m4b'), 'broken');
    await symlink(join(directory, 'Part 2.mp3'), join(directory, 'linked.mp3'));
    const process: MediaProcess = async (_executable, args) => {
      if (args.includes(join(directory, 'broken.m4b'))) throw new Error('bad media');
      return { stderr: '', stdout: probe() };
    };

    const receipt = await createInventory({ source: directory, strict: true }, { process });

    expect(receipt.files.map((row) => row.relativePath)).toEqual(['Part 2.mp3', 'Part 10.mp3']);
    expect(receipt.errors).toEqual([{ error: 'bad media', path: join(directory, 'broken.m4b') }]);
    expect(receipt.summary).toMatchObject({ errors: 1, files: 2 });
    expect(receipt.exitCode).toBe(1);
  });

  it('audits missing facts, duplicate candidates, and multipart groups without deletion advice', async () => {
    const directory = await root();
    await writeFile(join(directory, 'Book Part 1 of 2.mp3'), 'one');
    await writeFile(join(directory, 'Book Part 2 of 2.mp3'), 'two');
    await writeFile(join(directory, 'Book Part 1 of 2.flac'), 'alternate');
    const process: MediaProcess = async () => ({
      stderr: '',
      stdout: probe({ format: { duration: '1200', format_name: 'mp3', tags: {} } }),
    });

    const receipt = await auditLibrary({ concurrency: 2, sources: [directory] }, { process });

    expect(receipt.summary).toMatchObject({ files: 3, missingArtwork: 3, missingChapters: 3, missingTitle: 3 });
    expect(receipt.duplicateCandidates).toHaveLength(1);
    expect(receipt.multipartCandidates).toHaveLength(1);
    expect(receipt.reviewNote).toContain('never deletion instructions');
  });

  it('selects quality without collapsing part numbers and flags material duration differences', () => {
    const receipt = selectInventorySources({
      errors: [],
      exitCode: 0,
      files: [
        { bitDepth: 0, bitRate: 128000, bytes: 1, chapters: 0, codec: 'mp3', durationSeconds: 100, extension: '.mp3', path: '/book/Part 1.mp3', relativePath: 'Part 1.mp3', sampleRate: 44100, tags: {} },
        { bitDepth: 24, bitRate: 900000, bytes: 1, chapters: 0, codec: 'flac', durationSeconds: 104, extension: '.flac', path: '/book/Part 1.flac', relativePath: 'Part 1.flac', sampleRate: 96000, tags: {} },
        { bitDepth: 0, bitRate: 128000, bytes: 1, chapters: 0, codec: 'mp3', durationSeconds: 100, extension: '.mp3', path: '/book/Part 2.mp3', relativePath: 'Part 2.mp3', sampleRate: 44100, tags: {} },
      ],
      generatedAt: '2026-08-26T00:00:00.000Z',
      mutation: false,
      operation: 'inventory',
      source: '/book',
      summary: { bytes: 3, durationSeconds: 304, errors: 0, files: 3 },
    });

    expect(receipt.selections).toHaveLength(2);
    expect(receipt.selections[0]?.selected.codec).toBe('flac');
    expect(receipt.selections[0]?.reviewRequired).toBe(true);
    expect(receipt.selections[1]?.identityKey).toContain('part 2');
  });

  it('refuses receipt paths with media extensions', async () => {
    const directory = await root();
    await expect(writeReceipt(join(directory, 'report.m4b'), { ok: true })).rejects.toThrow('audio path');
  });
});
