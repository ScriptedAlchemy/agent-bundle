import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { expectDocument, renderRoute } from 'agent-bundle/test';

it('renders the inventory CLI document with its canonical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-cli-rendered-inventory-'));
  try {
    const source = join(directory, 'library');
    const report = join(directory, 'inventory.json');
    await mkdir(source);

    const rendered = await renderRoute('cli:inventory', {
      input: { report, source },
    });
    const canonicalReceipt = JSON.parse(await readFile(report, 'utf8')) as unknown;

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainText('Inventoried 0 media files with 0 retained errors.')
      .toContainMarkdown('**Files:** 0')
      .toHaveValue(canonicalReceipt);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it('renders the audit CLI integrity report and chapter outline with its canonical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-cli-rendered-audit-'));
  const previousPath = process.env['PATH'];
  try {
    const bin = join(directory, 'bin');
    const file = join(directory, 'book.m4b');
    const receipt = join(directory, 'audit.json');
    await mkdir(bin);
    await writeFile(file, 'book');
    await writeFile(join(bin, 'ffprobe'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  chapters: [{ end_time: '10', start_time: '0', tags: { title: 'Book' } }],
  format: { duration: '10', format_name: 'mov', tags: { title: 'Book' } },
  streams: [{ codec_name: 'aac', codec_type: 'audio', disposition: {}, sample_rate: '44100' }],
}));
`);
    await writeFile(join(bin, 'ffmpeg'), `#!/usr/bin/env node
process.stdout.write('SHA256=${'b'.repeat(64)}\\n');
`);
    await Promise.all([
      chmod(join(bin, 'ffprobe'), 0o755),
      chmod(join(bin, 'ffmpeg'), 0o755),
    ]);
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`;

    const rendered = await renderRoute('cli:audit', {
      input: { file, receipt },
    });
    const canonicalReceipt = JSON.parse(await readFile(receipt, 'utf8')) as unknown;

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainText(`Audited 4 bytes with SHA-256`)
      .toContainMarkdown('**Audit status:** verified')
      .toContainMarkdown('Chapter outline (1)')
      .toContainContext('Verified: hashes, probe facts, chapter structure')
      .toHaveValue(canonicalReceipt);
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    await rm(directory, { force: true, recursive: true });
  }
});
