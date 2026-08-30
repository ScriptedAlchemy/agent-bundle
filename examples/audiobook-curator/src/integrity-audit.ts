import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chapterMappingIssues, type ChapterRow } from './conversion.ts';
import { CuratorError, asRecord, readJson, sha256File, utcNow, writeReceipt } from './foundation.ts';
import { probeMediaDetails, probeMediaRecord, type LibraryDependencies, type MediaDetails, type MediaRecord } from './library.ts';
import { runMediaProcess, type MediaProcess } from './media-process.ts';

export interface IntegrityAuditInput {
  readonly conversionReceipt?: string;
  readonly file: string;
  readonly fullDecode?: boolean;
  readonly receipt?: string;
}

export interface IntegrityAuditReceipt {
  readonly audioSha256: string;
  readonly bytes: number;
  readonly chapterIssues: readonly string[];
  readonly chapters: readonly ChapterRow[];
  readonly exitCode: 0 | 2;
  readonly file: string;
  readonly fullDecode: 'failed' | 'not-requested' | 'verified';
  readonly generatedAt: string;
  readonly mutation: false;
  readonly operation: 'audit';
  readonly probe: MediaRecord;
  readonly sha256: string;
  readonly sourceChapterMapping: Readonly<{
    readonly conversionReceipt?: string;
    readonly issues: readonly string[];
    readonly status: 'not-requested' | 'review-required' | 'verified';
  }>;
  readonly status: 'review-required' | 'verified';
}

export interface IntegrityAuditDependencies extends LibraryDependencies {
  readonly ffmpeg?: string;
  readonly process?: MediaProcess;
}

const chapterEvidence = (details: MediaDetails): { readonly issues: string[]; readonly rows: ChapterRow[] } => {
  const source = details.chapters;
  if (!Array.isArray(source) || source.length > 16_384) throw new CuratorError('ffprobe returned invalid chapters.');
  const mediaDuration = Number(asRecord(details.format).duration ?? 0);
  const rows = source.map((chapter, index) => {
    const row = asRecord(chapter);
    return {
      endSeconds: Number(row.end_time ?? 0),
      number: index + 1,
      startSeconds: Number(row.start_time ?? 0),
      title: String(asRecord(row.tags).title ?? '').trim(),
    };
  });
  const issues: string[] = [];
  for (const row of rows) {
    if (row.endSeconds <= row.startSeconds) issues.push(`chapter ${row.number} has non-positive duration`);
    if (row.title === '' || /^(?:unknown|untitled|track\s*\d*)$/iu.test(row.title)) issues.push(`chapter ${row.number} has a missing or placeholder title`);
    if (row.number > 1 && Math.abs(row.startSeconds - rows[row.number - 2]!.endSeconds) > 0.05) {
      issues.push(`chapter boundary ${row.number - 1}/${row.number} is discontinuous`);
    }
  }
  if (rows.length === 0) issues.push('no chapters');
  else {
    if (Math.abs(rows[0]!.startSeconds) > 0.1) issues.push('first chapter does not start at zero');
    if (Math.abs(rows.at(-1)!.endSeconds - mediaDuration) > 1) issues.push('last chapter does not reach media end');
  }
  return { issues, rows };
};

const expectedChapters = (value: unknown): ChapterRow[] => {
  const rows = asRecord(value).expectedChapters;
  if (!Array.isArray(rows) || rows.length > 16_384) throw new CuratorError('Conversion receipt has invalid expected chapters.');
  return rows.map((entry, index) => {
    const row = asRecord(entry);
    const result = {
      endSeconds: Number(row.endSeconds),
      number: Number(row.number ?? index + 1),
      startSeconds: Number(row.startSeconds),
      title: String(row.title ?? ''),
    };
    if (![result.endSeconds, result.number, result.startSeconds].every(Number.isFinite)) throw new CuratorError('Conversion receipt has invalid expected chapters.');
    return result;
  });
};

export const auditAudiobookIntegrity = async (
  input: IntegrityAuditInput,
  dependencies: IntegrityAuditDependencies = {},
): Promise<IntegrityAuditReceipt> => {
  const file = resolve(input.file);
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1) throw new CuratorError('Audit source must be one regular file.');
  const process = dependencies.process ?? runMediaProcess;
  const details = await probeMediaDetails(file, dependencies);
  const probe = await probeMediaRecord(file, dirname(file), dependencies);
  const chapter = chapterEvidence(details);
  const issues = [...chapter.issues];
  let mapping: IntegrityAuditReceipt['sourceChapterMapping'] = Object.freeze({ issues: Object.freeze([]), status: 'not-requested' });
  if (input.conversionReceipt !== undefined) {
    const conversion = resolve(input.conversionReceipt);
    const mappingIssues = [...chapterMappingIssues(expectedChapters(await readJson(conversion)), chapter.rows)];
    issues.push(...mappingIssues.map((issue) => `source mapping: ${issue}`));
    mapping = Object.freeze({
      conversionReceipt: conversion,
      issues: Object.freeze(mappingIssues),
      status: mappingIssues.length === 0 ? 'verified' : 'review-required',
    });
  }
  const audio = await process(dependencies.ffmpeg ?? 'ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-',
  ], { signal: dependencies.signal });
  let fullDecode: IntegrityAuditReceipt['fullDecode'] = 'not-requested';
  if (input.fullDecode === true) {
    try {
      await process(dependencies.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:a', '-f', 'null', '-'], { signal: dependencies.signal });
      fullDecode = 'verified';
    } catch (error) {
      fullDecode = 'failed';
      issues.push(`full decode failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    }
  }
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new CuratorError('Audiobook changed while it was audited.');
  }
  const status = issues.length === 0 && (input.fullDecode !== true || fullDecode === 'verified') ? 'verified' : 'review-required';
  const receipt = Object.freeze<IntegrityAuditReceipt>({
    audioSha256: audio.stdout.trim().replace(/^SHA256=/u, ''),
    bytes: after.size,
    chapterIssues: Object.freeze(issues),
    chapters: Object.freeze(chapter.rows.map((row) => Object.freeze({ ...row }))),
    exitCode: status === 'verified' ? 0 : 2,
    file,
    fullDecode,
    generatedAt: utcNow(),
    mutation: false,
    operation: 'audit',
    probe,
    sha256: await sha256File(file),
    sourceChapterMapping: mapping,
    status,
  });
  if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [file, input.conversionReceipt]);
  return receipt;
};
