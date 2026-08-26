import { describe, expect, it } from '@rstest/core';

import { runCli, type CuratorOperations } from '../src/cli.js';

const operations = (): CuratorOperations => ({
  audit: async (input) => ({ fullDecode: input.fullDecode ?? false, operation: 'audit', source: input.source }),
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
  it('emits one JSON receipt for each exact subcommand', async () => {
    const output: string[] = [];
    await expect(runCli(['inspect', '/library'], { operations: operations(), write: (value) => output.push(value) }))
      .resolves.toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ files: [], operation: 'inspect', root: '/library', totalBytes: 0 });
  });

  it('enables application only through the typed flag', async () => {
    let applied = false;
    const fixture = operations();
    await runCli(['prepare', '/source/book.mp3', '--output', '/curated', '--apply'], {
      operations: { ...fixture, prepare: async (input) => {
        applied = input.apply === true;
        return fixture.prepare(input);
      } },
      write: () => undefined,
    });
    expect(applied).toBe(true);
  });

  it('rejects unknown commands and flags', async () => {
    await expect(runCli(['convert', '/library'], { operations: operations(), write: () => undefined }))
      .rejects.toThrow('Unknown command');
    await expect(runCli(['audit', '/library', '--overwrite'], { operations: operations(), write: () => undefined }))
      .rejects.toThrow('Unknown option');
  });
});
