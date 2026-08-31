import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  chapterRowsFromPayload,
  cleanCatalogText,
  type MediaProcess,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-mutation-'));
  roots.push(root);
  const media = join(root, 'book.m4b');
  const product = join(root, 'product.json');
  const chapters = join(root, 'chapters.json');
  await writeFile(media, 'media');
  await writeFile(product, JSON.stringify({
    asin: 'BOOK', authors: [{ name: 'A. Author' }], narrators: [{ name: 'N. Narrator' }],
    publisher_name: '<b>Publisher</b>', publisher_summary: '<p>One &amp; two.</p>', release_date: '2026', title: 'Book',
  }));
  await writeFile(chapters, JSON.stringify({ content_metadata: { chapter_info: { chapters: [
    { length_ms: 4_000, start_offset_ms: 0, title: 'Opening' },
    { length_ms: 7_000, start_offset_ms: 4_000, title: 'Ending' },
  ] } } }));
  const process: MediaProcess = async () => ({
    stderr: '',
    stdout: JSON.stringify({
      chapters: [],
      format: { duration: '10', format_name: 'mov', tags: {} },
      streams: [{ codec_name: 'aac', codec_type: 'audio', disposition: {}, sample_rate: '44100' }],
    }),
  });
  return { chapters, media, process, product, root };
};

describe('metadata and chapter parity', () => {
  it('normalizes generic and Audible chapter documents with reviewed bounds', () => {
    expect(chapterRowsFromPayload({ content_metadata: { chapter_info: { chapters: [
      { length_ms: 4_000, start_offset_ms: 0, title: 'Opening' },
      { length_ms: 7_000, start_offset_ms: 4_000, title: 'Ending' },
    ] } } }, 10)).toEqual([
      { endSeconds: 4, startSeconds: 0, title: 'Opening' },
      { endSeconds: 10, startSeconds: 4, title: 'Ending' },
    ]);
    expect(() => chapterRowsFromPayload({ chapters: [{ endSeconds: 2, startSeconds: 1, title: 'Late' }] }, 2))
      .toThrow('does not start at zero');
  });

  it('normalizes Audible catalog HTML without retaining markup', () => {
    expect(cleanCatalogText('<p>One &amp; two.</p><br>Next')).toBe('One & two.\nNext');
  });

  it('plans metadata and chapter mutations without invoking ffmpeg', async () => {
    const { chapters, media, process, product } = await fixture();
    const metadata = await applyAudiobookMetadata({ file: media, product }, { process });
    const chapterPlan = await applyAudiobookChapters({ chapters, file: media }, { process });

    expect(metadata).toMatchObject({
      apply: false,
      metadata: { album: 'Book', artist: 'A. Author', composer: 'N. Narrator', description: 'One & two.' },
      operation: 'apply-metadata',
      status: 'planned',
    });
    expect(chapterPlan).toMatchObject({ apply: false, operation: 'apply-chapters', status: 'planned' });
    expect(chapterPlan.chapters).toHaveLength(2);
  });
});
