import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import {
  classifyDocsOnlyListing,
  isDocsOnlyPath,
  parseGhFilesListing,
} from '../../../scripts/classify-docs-only.mjs';

const execFile = promisify(executeFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/classify-docs-only.mjs');

const docsOnlyPaths = [
  'docs/local-ci.md',
  'docs/architecture/nested.md',
  'agent-patterns/effect-stream.md',
  'agent-patterns/nested/guide.md',
  '.changeset/trim-pr-matrix.md',
  '.changeset/nested/still-markdown.md',
  'README.md',
  'AGENTS.md',
  'website/docs/en/guide/start/index.mdx',
  'website/docs/zh/reference/_meta.json',
  'website/rspress.config.ts',
  'website/package.json',
] as const;

const codePaths = [
  'packages/agent-bundle/README.md',
  'examples/skills-starter/skills/release-review/SKILL.md',
  '.changeset/config.json',
  'docs',
  'website',
  '.github/workflows/ci.yml',
  '.github/workflows/docs.yml',
  'package.json',
  'scripts/classify-docs-only.mjs',
] as const;

it('treats the documented allowlist as docs-only and everything else as code', () => {
  for (const path of docsOnlyPaths) {
    expect(isDocsOnlyPath(path), path).toBe(true);
  }
  for (const path of codePaths) {
    expect(isDocsOnlyPath(path), path).toBe(false);
  }
});

it('fails open when the listing is missing, invalid, empty, or truncated', () => {
  expect(classifyDocsOnlyListing({
    changedFilesCount: '1',
    entries: [{ filename: 'README.md', previousFilename: '' }],
    listingOk: false,
  })).toMatchObject({ docsOnly: false, reason: 'listing-error' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: 'abc',
    entries: [{ filename: 'README.md', previousFilename: '' }],
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'invalid-count' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '1',
    entries: [],
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'empty-listing' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '3',
    entries: [
      { filename: 'README.md', previousFilename: '' },
      { filename: 'docs/local-ci.md', previousFilename: '' },
    ],
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'truncated-listing' });
});

it('classifies mixed, nested-markdown, and rename pairs from a GitHub files listing', () => {
  expect(classifyDocsOnlyListing({
    changedFilesCount: '3',
    entries: parseGhFilesListing([
      'docs/local-ci.md\t',
      'agent-patterns/effect-stream.md\t',
      'README.md\t',
    ].join('\n')),
    listingOk: true,
  })).toMatchObject({ docsOnly: true, reason: 'docs-only' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '2',
    entries: parseGhFilesListing([
      'docs/local-ci.md\t',
      'packages/agent-bundle/README.md\t',
    ].join('\n')),
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'non-docs-path', path: 'packages/agent-bundle/README.md' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '2',
    entries: parseGhFilesListing([
      'website/docs/en/guide/authoring/hooks.mdx\t',
      'website/docs/zh/guide/authoring/hooks.mdx\t',
    ].join('\n')),
    listingOk: true,
  })).toMatchObject({ docsOnly: true, reason: 'docs-only' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '2',
    entries: parseGhFilesListing([
      'website/docs/en/reference/configuration.mdx\t',
      'packages/agent-bundle/src/core/types.ts\t',
    ].join('\n')),
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'non-docs-path', path: 'packages/agent-bundle/src/core/types.ts' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '1',
    entries: parseGhFilesListing('docs/moved.md\tdocs/old.md\n'),
    listingOk: true,
  })).toMatchObject({ docsOnly: true, reason: 'docs-only' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '1',
    entries: parseGhFilesListing('docs/from-code.md\tsrc/from-code.ts\n'),
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'non-docs-path', path: 'src/from-code.ts' });

  expect(classifyDocsOnlyListing({
    changedFilesCount: '1',
    entries: parseGhFilesListing('src/into-code.ts\tdocs/into-code.md\n'),
    listingOk: true,
  })).toMatchObject({ docsOnly: false, reason: 'non-docs-path', path: 'src/into-code.ts' });
});

it('writes docs_only to GITHUB_OUTPUT and always exits 0', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-docs-only-'));
  const listingPath = join(fixtureRoot, 'files.tsv');
  const outputPath = join(fixtureRoot, 'github-output');
  await writeFile(listingPath, 'README.md\t\n', 'utf8');
  await writeFile(outputPath, '', 'utf8');

  try {
    const docsOnly = await execFile(process.execPath, [
      scriptPath,
      '--changed-files-count',
      '1',
      '--listing',
      listingPath,
    ], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(docsOnly.stdout).toContain('docs-only');
    expect(await readFile(outputPath, 'utf8')).toBe('docs_only=true\n');

    await writeFile(listingPath, 'packages/foo/README.md\t\n', 'utf8');
    await writeFile(outputPath, '', 'utf8');
    const code = await execFile(process.execPath, [
      scriptPath,
      '--changed-files-count',
      '1',
      '--listing',
      listingPath,
    ], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(code.stdout).toContain('non-docs-path');
    expect(await readFile(outputPath, 'utf8')).toBe('docs_only=false\n');

    await writeFile(outputPath, '', 'utf8');
    const failedListing = await execFile(process.execPath, [
      scriptPath,
      '--listing-error',
    ], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(failedListing.stdout).toContain('listing-error');
    expect(await readFile(outputPath, 'utf8')).toBe('docs_only=false\n');
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
