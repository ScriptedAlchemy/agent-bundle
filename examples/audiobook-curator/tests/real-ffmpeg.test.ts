import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  auditAudiobookIntegrity,
  convertAudiobook,
  createInventory,
  runMediaProcess,
  selectInventorySources,
  writeReceipt,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

describe('real FFmpeg curation pipeline', () => {
  it('converts derived media, applies metadata and chapters, and leaves the source immutable', async () => {
    try {
      await runMediaProcess('ffmpeg', ['-version']);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const root = await mkdtemp(join(tmpdir(), 'curator-real-'));
    roots.push(root);
    const source = join(root, 'source.m4b');
    const output = join(root, 'derived.m4b');
    const inventoryPath = join(root, 'inventory.json');
    const selectionPath = join(root, 'selection.json');
    const productPath = join(root, 'product.json');
    const chapterPath = join(root, 'chapters.json');
    await runMediaProcess('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', source,
    ]);
    const sourceBefore = await sha256(source);
    const inventory = await createInventory({ source });
    await writeReceipt(inventoryPath, inventory, [source]);
    const selection = selectInventorySources(inventory, inventoryPath);
    await writeReceipt(selectionPath, selection, [source, inventoryPath]);

    const converted = await convertAudiobook({
      apply: true, author: 'Example Author', output, receipt: join(root, 'conversion.json'), selection: selectionPath, title: 'Example Book',
    });
    expect(converted).toMatchObject({ audioMode: 'stream-copy', status: 'converted-verified' });
    expect(await sha256(source)).toBe(sourceBefore);

    await writeFile(productPath, JSON.stringify({
      asin: 'EXAMPLE', authors: [{ name: 'Example Author' }], narrators: [{ name: 'Example Narrator' }],
      publisher_name: 'Publisher', publisher_summary: '<p>A useful summary.</p>', title: 'Example Book',
    }));
    const metadata = await applyAudiobookMetadata({ apply: true, file: output, product: productPath });
    expect(metadata).toMatchObject({ status: 'applied-verified', chapterCountAfter: 1 });

    await writeFile(chapterPath, JSON.stringify({ chapters: [{ endSeconds: 2, startSeconds: 0, title: 'Opening' }] }));
    const chapters = await applyAudiobookChapters({ apply: true, chapters: chapterPath, file: output });
    expect(chapters).toMatchObject({ chapterCountAfter: 1, status: 'applied-verified', verifiedBoundaries: true });

    const audit = await auditAudiobookIntegrity({ file: output, fullDecode: true });
    expect(audit).toMatchObject({ exitCode: 0, fullDecode: 'verified', status: 'verified' });
    expect(audit.chapters.map((chapter) => chapter.title)).toEqual(['Opening']);
    expect(await sha256(source)).toBe(sourceBefore);
  });
});
