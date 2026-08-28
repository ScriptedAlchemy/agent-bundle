import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { auditAudiobookIntegrity, type MediaProcess } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

describe('complete audiobook integrity audit', () => {
  it('verifies chapter mapping, file/audio hashes, probe facts, and optional full decode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-audit-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    const conversion = join(root, 'conversion.json');
    await writeFile(file, 'book');
    await writeFile(conversion, JSON.stringify({ expectedChapters: [{ endSeconds: 10, number: 1, startSeconds: 0, title: 'Book' }] }));
    const calls: string[][] = [];
    const process: MediaProcess = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable === 'ffprobe') return { stderr: '', stdout: JSON.stringify({
        chapters: [{ end_time: '10', start_time: '0', tags: { title: 'Book' } }],
        format: { duration: '10', format_name: 'mov', tags: { title: 'Book' } },
        streams: [{ codec_name: 'aac', codec_type: 'audio', disposition: {}, sample_rate: '44100' }],
      }) };
      if (args.includes('hash')) return { stderr: '', stdout: `SHA256=${'b'.repeat(64)}\n` };
      return { stderr: '', stdout: '' };
    };

    const receipt = await auditAudiobookIntegrity({ conversionReceipt: conversion, file, fullDecode: true }, { process });
    expect(receipt).toMatchObject({
      audioSha256: 'b'.repeat(64),
      exitCode: 0,
      fullDecode: 'verified',
      operation: 'audit',
      sourceChapterMapping: { status: 'verified' },
      status: 'verified',
    });
    expect(receipt.sha256).toHaveLength(64);
    expect(calls.some((call) => call.includes('null'))).toBe(true);
  });

  it('returns review exit 2 for chapter defects without making a mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-audit-review-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    await writeFile(file, 'book');
    const process: MediaProcess = async (executable, args) => executable === 'ffprobe'
      ? { stderr: '', stdout: JSON.stringify({ chapters: [], format: { duration: '10', tags: {} }, streams: [{ codec_name: 'aac', codec_type: 'audio', disposition: {}, sample_rate: '44100' }] }) }
      : { stderr: '', stdout: args.includes('hash') ? `SHA256=${'c'.repeat(64)}` : '' };

    const receipt = await auditAudiobookIntegrity({ file }, { process });
    expect(receipt).toMatchObject({ exitCode: 2, mutation: false, status: 'review-required' });
    expect(receipt.chapterIssues).toContain('no chapters');
  });
});
