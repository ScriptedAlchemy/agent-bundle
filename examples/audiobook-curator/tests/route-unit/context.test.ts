import type { AgentProviderValues } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

import type { LibraryContext } from '../../src/providers/library.ts';

const manifest = testManifest();

it('renders the catalog from injected library context with its contents envelope', async () => {
  expect(Object.keys(manifest.routes)).toContain('resource:curator/catalog');
  const library = {
    probedAt: '2026-09-02T18:00:00.000Z',
    stages: ['discover', 'identify', 'curate', 'verify'],
    tooling: {
      ffmpeg: { available: true, version: 'ffmpeg version 8.0' },
      ffprobe: { available: false },
    },
  } satisfies LibraryContext;
  const uri = 'audiobook-curator://catalog';
  const rendered = await renderRoute('resource:curator/catalog', {
    context: { providers: { library } },
    input: { uri },
  });
  const value = {
    contents: [{
      mimeType: 'application/json',
      text: JSON.stringify(library),
      uri,
    }],
  };

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Audiobook curator catalog ready.')
    .toContainMarkdown('**ffmpeg available:** true')
    .toContainMarkdown('**ffprobe available:** false')
    .toContainContext('request-time probe')
    .toHaveValue(value);
});

it('renders an honest degraded catalog when library context is absent', async () => {
  // The harness mounts `src/providers/library.ts` automatically, so the
  // degraded path needs an explicit empty provider map to keep it absent.
  // The generated `.agent-bundle/routes.d.ts` (in this project's tsconfig
  // program) makes the declared `library` key required, so this deliberate
  // contract violation is spelled out as a cast rather than left implicit.
  const absentProviders = {} as unknown as AgentProviderValues;
  const rendered = await renderRoute('resource:curator/catalog', {
    context: { providers: absentProviders },
    input: { uri: 'audiobook-curator://catalog' },
  });
  const value = rendered.document.value as {
    readonly contents: readonly [{ readonly text: string }];
  };
  const catalog = JSON.parse(value.contents[0].text) as {
    readonly context: { readonly available: boolean };
    readonly tooling: {
      readonly ffmpeg: { readonly available: boolean };
      readonly ffprobe: { readonly available: boolean };
    };
  };

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Audiobook curator catalog unavailable.')
    .toContainMarkdown('**ffmpeg available:** false')
    .toContainMarkdown('**ffprobe available:** false')
    .toContainContext('Library request context is missing or malformed');
  expect(catalog).toMatchObject({
    context: { available: false },
    tooling: {
      ffmpeg: { available: false },
      ffprobe: { available: false },
    },
  });
});

it('renders the composed curation prompt with its messages envelope', async () => {
  const rendered = await renderRoute('prompt:curator/curate', {
    input: { root: '/library' },
  });

  expectDocument(rendered)
    .toHaveStatus('success')
    .toContainText('Curation review prepared.')
    .toContainMarkdown('**Root:** /library')
    .toContainContext('Evidence first')
    .toHaveValue({
      messages: [{
        content: {
          text: 'Inspect /library through discover, identify, curate, and verify. Retain evidence and require review before any mutation.',
          type: 'text',
        },
        role: 'user',
      }],
    });
});
