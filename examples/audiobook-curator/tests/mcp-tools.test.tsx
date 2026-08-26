import { describe, expect, it } from '@rstest/core';

import {
  createCuratorTools,
  curatorToolNames,
  type CuratorToolOperations,
} from '../src/mcp-tools.js';

const operations = (): CuratorToolOperations => ({
  audit: async (input) => ({
    bytes: 12,
    fullDecode: input.fullDecode ?? false,
    operation: 'audit',
    probe: { codec: 'aac', durationSeconds: 12, format: 'mov', tags: {} },
    sha256: 'a'.repeat(64),
    source: input.source,
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

describe('audiobook curator MCP tools', () => {
  it('derives the current tool catalog from the shared application', () => {
    expect(curatorToolNames).toEqual([
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
    expect(createCuratorTools({ operations: operations() }).map(({ name }) => name)).toEqual(curatorToolNames);
  });

  it('renders text and detached structured receipts through the public RSC lowerer', async () => {
    const tools = createCuratorTools({ operations: operations() });
    const inspect = tools.find(({ name }) => name === 'inspect_sources')!;
    const result = await inspect.execute({ root: '/library' }, new AbortController().signal);

    expect(result).toEqual({
      content: [{ text: 'Inspected 0 audio files (0 bytes).', type: 'text' }],
      structuredContent: { files: [], operation: 'inspect', root: '/library', totalBytes: 0 },
    });
  });

  it('forwards typed apply and caller cancellation to the shared core', async () => {
    let apply = false;
    let signal: AbortSignal | undefined;
    const fixture = operations();
    const tools = createCuratorTools({
      operations: {
        ...fixture,
        prepare: async (input, options) => {
          apply = input.apply === true;
          signal = options.signal;
          return fixture.prepare(input, options);
        },
      },
    });
    const controller = new AbortController();
    const prepare = tools.find(({ name }) => name === 'prepare_audiobook')!;
    await prepare.execute({ apply: true, outputRoot: '/curated', source: '/library/book.mp3' }, controller.signal);

    expect(apply).toBe(true);
    expect(signal).toBe(controller.signal);
  });
});
