import { describe, expect, it } from '@rstest/core';

import { runCli, type CuratorOperations } from '../src/cli.js';

const operations = (): CuratorOperations => ({
  audit: async (input) => ({
    audioSha256: 'b'.repeat(64), bytes: 12, chapterIssues: [], chapters: [], exitCode: 0, file: input.file,
    fullDecode: input.fullDecode === true ? 'verified' : 'not-requested', generatedAt: '2026-08-26T00:00:00.000Z',
    mutation: false, operation: 'audit', probe: { bytes: 12, chapters: 0, codec: 'aac', durationSeconds: 12, extension: '.m4b', path: input.file, relativePath: 'book.m4b', sampleRate: 44_100, tags: {} },
    sha256: 'a'.repeat(64), sourceChapterMapping: { issues: [], status: 'not-requested' }, status: 'verified',
  }),
  inspect: async (input) => ({ files: [], operation: 'inspect', root: input.root, totalBytes: 0 }),
  prepare: async (input) => ({
    applied: input.apply ?? false,
    operation: 'prepare',
    output: `${input.outputRoot}/book.m4b`,
    probe: { codec: 'mp3', durationSeconds: 12, format: 'mp3', tags: {} },
    source: input.source,
  }),
});

describe('audiobook-curator CLI', () => {
  it('enables application only through the typed flag', async () => {
    let applied = false;
    const fixture = operations();
    await runCli(['prepare', '/source/book.mp3', '--output', '/curated', '--apply'], {
      operations: { ...fixture, prepare: async (input, options) => {
        applied = input.apply === true;
        return fixture.prepare(input, options);
      } },
      write: () => undefined,
    });
    expect(applied).toBe(true);
  });

  it('rejects unknown commands and flags', async () => {
    await expect(runCli(['unknown', '/library'], { operations: operations(), write: () => undefined }))
      .rejects.toThrow('Unknown command');
    await expect(runCli(['audit', '/library', '--overwrite'], { operations: operations(), write: () => undefined }))
      .rejects.toThrow('Unknown option');
  });

  it('does not invoke a command when cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const output: string[] = [];

    await expect(runCli(['inspect', '/library'], {
      operations: {
        ...operations(),
        inspect: async (input) => {
          invoked = true;
          return { files: [], operation: 'inspect', root: input.root, totalBytes: 0 };
        },
      },
      signal: controller.signal,
      write: (value) => output.push(value),
    })).rejects.toThrow('aborted');

    expect(invoked).toBe(false);
    expect(output).toEqual([]);
  });

  it('does not emit a result when cancellation is requested during a command', async () => {
    const controller = new AbortController();
    const output: string[] = [];

    await expect(runCli(['inspect', '/library'], {
      operations: {
        ...operations(),
        inspect: async (input) => {
          controller.abort();
          return { files: [], operation: 'inspect', root: input.root, totalBytes: 0 };
        },
      },
      signal: controller.signal,
      write: (value) => output.push(value),
    })).rejects.toThrow('aborted');

    expect(output).toEqual([]);
  });
});
