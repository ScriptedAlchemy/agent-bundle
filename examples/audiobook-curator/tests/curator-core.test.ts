import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  inspectSources,
  prepareAudiobook,
  type MediaProcess,
} from '../src/index.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'audiobook-curator-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const probe = (duration = 12.5): string => JSON.stringify({
  format: {
    duration: String(duration),
    format_name: 'mp3',
    tags: { album: 'Example', artist: 'Narrator', title: 'Chapter One' },
  },
  streams: [{ channels: 2, codec_name: 'mp3', codec_type: 'audio', sample_rate: '44100' }],
});

const processFixture = (calls: Array<{ args: readonly string[]; executable: string }>): MediaProcess =>
  async (executable, args) => {
    calls.push({ args, executable });
    if (basename(executable).includes('ffmpeg') && args.at(-1) !== '-') {
      await writeFile(args.at(-1)!, 'converted audio');
      return { stderr: '', stdout: '' };
    }
    return { stderr: '', stdout: probe() };
  };

describe('audiobook curator core', () => {
  it('inventories supported regular files without following symlinks', async () => {
    const root = await makeRoot();
    const calls: Array<{ args: readonly string[]; executable: string }> = [];
    await writeFile(join(root, 'chapter.mp3'), 'source audio');
    await writeFile(join(root, 'notes.txt'), 'not audio');
    await symlink(join(root, 'chapter.mp3'), join(root, 'linked.mp3'));

    const receipt = await inspectSources({ root }, { process: processFixture(calls) });

    expect(receipt).toMatchObject({ operation: 'inspect', root, totalBytes: 12 });
    expect(receipt.files).toHaveLength(1);
    expect(receipt.files[0]).toMatchObject({ durationSeconds: 12.5, path: join(root, 'chapter.mp3') });
    expect(calls).toHaveLength(1);
  });

  it('plans by default and applies only to a distinct non-existing output', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.mp3');
    const outputRoot = join(root, 'curated');
    const calls: Array<{ args: readonly string[]; executable: string }> = [];
    await writeFile(source, 'original audio');

    const plan = await prepareAudiobook({ outputRoot, source }, { process: processFixture(calls) });
    expect(plan).toMatchObject({ applied: false, operation: 'prepare', source });
    expect(calls.every(({ executable }) => !basename(executable).includes('ffmpeg'))).toBe(true);

    const applied = await prepareAudiobook(
      { apply: true, outputName: 'book.m4b', outputRoot, source },
      { process: processFixture(calls) },
    );
    expect(applied).toMatchObject({ applied: true, output: join(outputRoot, 'book.m4b') });
    await expect(readFile(source, 'utf8')).resolves.toBe('original audio');
    await expect(readFile(join(outputRoot, 'book.m4b'), 'utf8')).resolves.toBe('converted audio');
    await expect(prepareAudiobook(
      { apply: true, outputName: 'book.m4b', outputRoot, source },
      { process: processFixture(calls) },
    )).rejects.toThrow('already exists');
  });

  it('rejects output names that can escape the selected output root', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.mp3');
    await writeFile(source, 'source audio');
    await expect(prepareAudiobook(
      { outputName: '../escape.m4b', outputRoot: join(root, 'out'), source },
      { process: processFixture([]) },
    )).rejects.toThrow('safe file name');
  });
});
