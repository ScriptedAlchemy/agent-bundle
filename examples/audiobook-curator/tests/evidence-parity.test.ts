import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  identifyAudibleSample,
  verifyAudibleSample,
  verifyWithWhisper,
  whisperSamplingFractions,
  whisperText,
  type AcousticMatcher,
  type CuratorHttpClient,
  type MediaProcess,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe('optional identity evidence parity', () => {
  it('keeps the reviewed distributed Whisper sampling sequence', () => {
    expect(whisperSamplingFractions(5)).toEqual([0.05, 0.275, 0.5, 0.725, 0.95]);
    expect(whisperSamplingFractions(9)).toEqual([0.05, 0.275, 0.5, 0.725, 0.95, 0.15, 0.85, 0.375, 0.625]);
    expect(whisperText({ transcription: [{ text: ' one ' }, { text: 'two' }] })).toBe('one  two');
  });

  it('matches a downloaded Audible sample through an injected Audiolocate capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-evidence-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    await writeFile(file, 'book');
    const http: CuratorHttpClient = async (url, options) => options?.binary === true
      ? Buffer.from('sample')
      : { product: { authors: [{ name: 'Author' }], narrators: [{ name: 'Narrator' }], sample_url: 'https://sample.example/book.mp3', title: 'Book' } };
    const matcher: AcousticMatcher = async (source, sample, options) => ({
      chunkSeconds: options.chunkSeconds,
      found: source === file && sample.endsWith('sample.mp3'),
    });

    const receipt = await verifyAudibleSample({ asin: 'ASIN', file, region: 'us' }, { http, matcher });
    expect(receipt).toMatchObject({ exitCode: 0, operation: 'audiolocate', verifiedRecording: true });
  });

  it('extracts the structured Audiolocate result after foreign progress logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-audiolocate-output-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    await writeFile(file, 'book');
    const process: MediaProcess = async () => ({
      stderr: '',
      stdout: '[load] Loading streams\n[compare] 50%\n__AGENT_BUNDLE_AUDIOLOCATE_RESULT__{"found":true}\n',
    });
    const receipt = await verifyAudibleSample({ asin: 'ASIN', file, sampleUrl: 'https://sample.example/book.mp3' }, {
      audiolocatePython: 'python-test',
      http: async () => Buffer.from('sample'),
      process,
    });
    expect(receipt).toMatchObject({ exitCode: 0, verifiedRecording: true });
  });

  it('deduplicates ranked ASINs and isolates candidate failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-identify-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    await writeFile(file, 'book');
    const matcher: AcousticMatcher = async (_source, sample) => {
      const contents = await readFile(sample, 'utf8');
      if (contents.includes('broken')) throw new Error('fingerprint failed');
      return { found: contents.includes('match') };
    };
    const http: CuratorHttpClient = async (url, options) => {
      if (options?.binary === true) return Buffer.from(url);
      throw new Error('unexpected product request');
    };
    const receipt = await identifyAudibleSample({
      candidates: [
        { asin: 'BROKEN', evidence: { score: 100 }, region: 'us', sample_url: 'https://samples/broken.mp3' },
        { asin: 'BROKEN', evidence: { score: 99 }, region: 'us', sample_url: 'https://samples/duplicate.mp3' },
        { asin: 'MATCH', evidence: { score: 90 }, region: 'us', sample_url: 'https://samples/match.mp3' },
      ],
      candidatesReport: join(root, 'candidates.json'), file, top: 3,
    }, { http, matcher });
    expect(receipt.attempts.map((attempt) => attempt.status)).toEqual(['error', 'matched']);
    expect(receipt).toMatchObject({ exitCode: 0, identified: { asin: 'MATCH' }, verifiedRecording: true });
  });

  it('stages evidence work directories on regular disk, never under os.tmpdir()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-evidence-disk-'));
    roots.push(root);
    const file = join(root, 'library', 'book.m4b');
    const receiptPath = join(root, 'receipts', 'acoustic.json');
    await mkdir(dirname(file), { recursive: true });
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(file, 'book');
    const sampleDirs: string[] = [];
    const matcher: AcousticMatcher = async (_source, sample) => {
      sampleDirs.push(dirname(sample));
      return { found: true };
    };
    const http: CuratorHttpClient = async () => Buffer.from('sample');

    await verifyAudibleSample(
      { asin: 'ASIN', file, receipt: receiptPath, sampleUrl: 'https://sample.example/book.mp3' },
      { http, matcher },
    );
    await verifyAudibleSample(
      { asin: 'ASIN', file, sampleUrl: 'https://sample.example/book.mp3' },
      { http, matcher },
    );

    const [besideReceipt, besideFile] = sampleDirs;
    expect(besideReceipt!.startsWith(join(dirname(receiptPath), '.audiobook-curator-acoustic-'))).toBe(true);
    expect(besideFile!.startsWith(join(dirname(file), '.audiobook-curator-acoustic-'))).toBe(true);
    for (const workDir of sampleDirs) expect(workDir.startsWith(join(tmpdir(), 'audiobook-curator-'))).toBe(false);
    // Staging is cleaned up even though it lives beside durable outputs.
    expect((await readdir(dirname(receiptPath))).filter((entry) => entry.startsWith('.audiobook-curator-'))).toEqual([]);
    expect((await readdir(dirname(file))).filter((entry) => entry.startsWith('.audiobook-curator-'))).toEqual([]);
  });

  it('extracts distributed PCM windows and returns review evidence without internal deadlines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-whisper-'));
    roots.push(root);
    const file = join(root, 'book.m4b');
    const model = join(root, 'model.bin');
    await writeFile(file, 'book');
    await writeFile(model, 'model');
    let whisperCalls = 0;
    const process: MediaProcess = async (executable, args) => {
      if (executable === 'ffprobe') return { stderr: '', stdout: JSON.stringify({ chapters: [], format: { duration: '1000', tags: {} }, streams: [{ codec_name: 'aac', codec_type: 'audio', disposition: {}, sample_rate: '44100' }] }) };
      if (executable === 'ffmpeg') {
        await writeFile(args.at(-1)!, 'wav');
        return { stderr: '', stdout: '' };
      }
      whisperCalls += 1;
      const output = args[args.indexOf('-of') + 1]!;
      await writeFile(`${output}.json`, JSON.stringify({ transcription: 'spoken evidence '.repeat(8) }));
      return { stderr: '', stdout: '' };
    };

    const receipt = await verifyWithWhisper({ file, model }, { process });
    expect(receipt).toMatchObject({ exitCode: 0, operation: 'whisper-identity', status: 'transcript-ready', usableWindows: 5 });
    expect(whisperCalls).toBe(5);
  });
});
