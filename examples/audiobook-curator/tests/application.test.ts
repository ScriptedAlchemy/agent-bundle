import { lowerMcpResult } from '@agent-bundle/runtime';
import { describe, expect, it } from '@rstest/core';

import maybeFactoryConfig from '../agent-bundle.config.ts';
import {
  createAudiobookCuratorApplication,
  type AudiobookCuratorOperations,
} from '../src/application.js';
import { runCli } from '../src/cli.js';

// defineConfig also admits factories; this example's config is a static object.
if (typeof maybeFactoryConfig === 'function') throw new Error('expected a static config object');
const config = maybeFactoryConfig;

const operations = (): AudiobookCuratorOperations => ({
  audit: async (input) => ({
    audioSha256: 'b'.repeat(64),
    bytes: 12,
    chapterIssues: [],
    chapters: [],
    exitCode: 0,
    file: input.file,
    fullDecode: input.fullDecode === true ? 'verified' : 'not-requested',
    generatedAt: '2026-08-26T00:00:00.000Z',
    mutation: false,
    operation: 'audit',
    probe: {
      bytes: 12,
      chapters: 0,
      codec: 'aac',
      durationSeconds: 12,
      extension: '.m4b',
      path: input.file,
      relativePath: 'book.m4b',
      sampleRate: 44_100,
      tags: {},
    },
    sha256: 'a'.repeat(64),
    sourceChapterMapping: { issues: [], status: 'not-requested' },
    status: 'verified',
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
  it('declares structure in config and owns CLI commands and MCP tools in the application', () => {
    expect(config.targets).toEqual(['claude', 'codex']);
    expect(Object.keys(config.scripts ?? {})).toEqual(['audiobook-curator']);
    expect(Object.keys(config.mcp?.servers ?? {})).toEqual(['curator']);
    // No skills entry: skills/curate-audiobooks/SKILL.md ships by convention.
    expect(config.skills).toBeUndefined();

    const application = createAudiobookCuratorApplication({ operations: operations() });
    expect(application.name).toBe('audiobook-curator');
    expect(application.operations.map((operation) => operation.cli?.name)).toEqual([
      'acoustic-verify',
      'acoustic-identify',
      'whisper-verify',
      'apply-metadata',
      'apply-chapters',
      'audible-search',
      'audible-select',
      'audible-cache',
      'inspect',
      'inventory',
      'library-audit',
      'select',
      'convert',
      'prepare',
      'audit',
    ]);
    expect(application.operations.map((operation) => operation.mcp?.name)).toEqual([
      'verify_audible_sample',
      'identify_audible_sample',
      'verify_with_whisper',
      'apply_audiobook_metadata',
      'apply_audiobook_chapters',
      'search_audible',
      'select_audible_edition',
      'cache_audible_edition',
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

  it('renders text and detached structured receipts through the public RSC lowerer', async () => {
    const application = createAudiobookCuratorApplication({ operations: operations() });
    const inspect = application.operations.find((operation) => operation.mcp?.name === 'inspect_sources')!;
    const receipt = await inspect.execute({ root: '/library' }, { signal: new AbortController().signal });

    expect(lowerMcpResult(inspect.render(receipt))).toEqual({
      content: [{ text: 'Inspected 0 audio files (0 bytes).', type: 'text' }],
      structuredContent: { files: [], operation: 'inspect', root: '/library', totalBytes: 0 },
    });
  });

  it('provides root and command help through the installed CLI adapter', async () => {
    const output: string[] = [];
    await expect(runCli(['--help'], { operations: operations(), write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('inspect [--max-files N] <root>');
    expect(output.join('')).toContain('prepare [--apply] [--name FILE] --output DIR <source>');

    output.length = 0;
    await expect(runCli(['audit', '--help'], { operations: operations(), write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('Validate metadata, chapters');
  });
});
