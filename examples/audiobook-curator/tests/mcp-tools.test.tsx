import { describe, expect, it } from '@rstest/core';

import {
  createCuratorTools,
  type CuratorToolOperations,
} from '../src/mcp-tools.js';

const operations = (): CuratorToolOperations => ({
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
    probe: { codec: 'aac', durationSeconds: 12, format: 'mov', tags: {} },
    sha256: 'a'.repeat(64),
    sourceChapterMapping: { issues: [], status: 'not-requested' },
    status: 'verified',
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
