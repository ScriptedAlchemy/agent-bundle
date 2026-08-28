import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  alacChunkCounts,
  convertAudiobook,
  resolveJobs,
  uniformAudioProperties,
  type MediaProcess,
  type MediaRecord,
} from '../src/index.js';

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'curator-convert-'));
  roots.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

const media = (overrides: Partial<MediaRecord> = {}): MediaRecord => ({
  bitDepth: 16,
  bitRate: 128000,
  bytes: 100,
  channelLayout: 'stereo',
  channels: 2,
  chapters: 0,
  codec: 'mp3',
  durationSeconds: 120,
  extension: '.mp3',
  path: '/book/part.mp3',
  relativePath: 'part.mp3',
  sampleFormat: 'fltp',
  sampleRate: 44100,
  tags: {},
  ...overrides,
});

describe('audiobook conversion parity', () => {
  it('ports worker and ALAC chunk planning', () => {
    expect(resolveJobs(0, 2, 8)).toBe(2);
    expect(resolveJobs(0, 2, 8, true)).toBe(8);
    expect(alacChunkCounts([100, 20], 4)).toEqual([3, 1]);
    expect(alacChunkCounts([3], 8)).toEqual([1]);
  });

  it('rejects mismatched audio and unsafe lossless properties before conversion', () => {
    expect(() => uniformAudioProperties([media(), media({ sampleRate: 48000 })])).toThrow('mismatched');
    expect(() => uniformAudioProperties([media(), media({ channels: 6, channelLayout: '5.1' })])).toThrow('mismatched');
  });

  it('plans a naturally ordered multipart conversion without invoking ffmpeg', async () => {
    const directory = await root();
    const first = join(directory, 'Part 1.mp3');
    const second = join(directory, 'Part 2.mp3');
    const selection = join(directory, 'selection.json');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await writeFile(selection, JSON.stringify({
      selections: [
        { selected: { path: first } },
        { selected: { path: second } },
      ],
    }));
    const calls: Array<{ args: readonly string[]; executable: string }> = [];
    const process: MediaProcess = async (executable, args) => {
      calls.push({ args, executable });
      return {
        stderr: '',
        stdout: JSON.stringify({
          chapters: [],
          format: { duration: '120', format_name: 'mp3', tags: {} },
          streams: [{
            bits_per_raw_sample: '16',
            channel_layout: 'stereo',
            channels: 2,
            codec_name: 'mp3',
            codec_type: 'audio',
            sample_fmt: 'fltp',
            sample_rate: '44100',
          }],
        }),
      };
    };

    const receipt = await convertAudiobook({
      author: 'Author',
      output: join(directory, 'out'),
      selection,
      title: "Author’s Book",
    }, { cpuCount: 8, process });

    expect(receipt).toMatchObject({
      apply: false,
      audioMode: 'AAC parallel-segment transcode',
      expectedChapterCount: 2,
      jobs: 2,
      operation: 'convert',
      output: join(directory, 'out', 'Authors Book.m4b'),
      sourcesPreserved: true,
      status: 'planned',
    });
    expect(receipt.expectedChapters.map((chapter) => chapter.title)).toEqual(['Part 1', 'Part 2']);
    expect(calls.every(({ executable }) => executable === 'ffprobe')).toBe(true);
  });
});
