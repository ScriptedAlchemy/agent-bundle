import { describe, expect, it } from '@rstest/core';

import {
  createAudiobookCuratorApplication,
  type AudiobookCuratorOperations,
} from '../src/application.js';
import { runCli } from '../src/cli.js';

const operations = (): AudiobookCuratorOperations => ({
  audit: async (input) => ({
    bytes: 12,
    fullDecode: input.fullDecode ?? false,
    operation: 'audit',
    probe: { codec: 'aac', durationSeconds: 12, format: 'mov', tags: {} },
    sha256: 'a'.repeat(64),
    source: input.source,
  }),
  convert: async (input) => ({
    apply: input.apply ?? false,
    audioMode: 'AAC transcode',
    embeddedMetadata: { album: input.title },
    engine: 'ffmpeg',
    expectedChapterCount: 1,
    expectedChapters: [],
    expectedDurationSeconds: 1,
    filenamePolicy: 'safe',
    generatedAt: '2026-08-26T00:00:00.000Z',
    inputs: ['/book.mp3'],
    jobs: 1,
    mutation: input.apply ?? false,
    operation: 'convert',
    output: input.output,
    sourcesPreserved: true,
    status: input.apply === true ? 'converted-verified' : 'planned',
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

describe('audiobook curator RSC application', () => {
  it('owns config, CLI commands, and MCP tools in one definition', () => {
    const application = createAudiobookCuratorApplication({ operations: operations() });

    expect(application.config.targets).toEqual(['claude', 'codex']);
    expect(application.config.skills).toEqual(['./skills/curate-audiobooks']);
    expect(Object.keys(application.config.scripts ?? {})).toEqual(['audiobook-curator']);
    expect(Object.keys(application.config.mcp?.servers ?? {})).toEqual(['curator']);
    expect(application.operations.map((operation) => operation.cli?.name)).toEqual([
      'inspect',
      'inventory',
      'library-audit',
      'select',
      'convert',
      'prepare',
      'audit',
    ]);
    expect(application.operations.map((operation) => operation.mcp?.name)).toEqual([
      'inspect_sources',
      'inventory_sources',
      'audit_library',
      'select_sources',
      'convert_audiobook',
      'prepare_audiobook',
      'audit_audiobook',
    ]);
  });

  it('shares typed execution and cancellation between adapters', async () => {
    let signal: AbortSignal | undefined;
    const fixture = operations();
    const controller = new AbortController();
    const application = createAudiobookCuratorApplication({
      operations: {
        ...fixture,
        prepare: async (input, options) => {
          signal = options.signal;
          return fixture.prepare(input, options);
        },
      },
    });
    const prepare = application.operations.find((operation) => operation.id === 'prepare')!;
    const result = await prepare.execute({ apply: true, outputRoot: '/curated', source: '/library/book.mp3' }, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({ applied: true, operation: 'prepare' });
    expect(signal).toBe(controller.signal);
  });

  it('provides root and command help through the installed CLI adapter', async () => {
    const output: string[] = [];
    await expect(runCli(['--help'], { operations: operations(), write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('inspect [--max-files N] <root>');
    expect(output.join('')).toContain('prepare [--apply] [--name FILE] --output DIR <source>');

    output.length = 0;
    await expect(runCli(['audit', '--help'], { operations: operations(), write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('Probe and hash one audiobook');
  });
});
