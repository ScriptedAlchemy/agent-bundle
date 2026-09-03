import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';

import type { CompletedBuildAttempt, ProjectStatus, RunningBuildAttempt } from '../src/dev/types.ts';
import { replaceWatchedSourceAndAwaitRebuild } from './support/watched-files.ts';

const running = (id: string): RunningBuildAttempt => Object.freeze({
  diagnostics: Object.freeze([]),
  id,
  outcome: 'running',
  sourceRevision: 'rev',
  startedAt: '2026-09-02T00:00:00.000Z',
});

/** A completed attempt; failed so the fake needs no artifact epoch. The wait is outcome-agnostic. */
const completed = (id: string): CompletedBuildAttempt => Object.freeze({
  completedAt: '2026-09-02T00:00:01.000Z',
  diagnostics: Object.freeze([
    Object.freeze({ code: 'AB7201', message: `attempt ${id} failed`, severity: 'error' as const }),
  ] as const),
  id,
  outcome: 'failed',
  sourceRevision: 'rev',
  startedAt: '2026-09-02T00:00:00.000Z',
});

const idle = (lastAttempt?: CompletedBuildAttempt): ProjectStatus => Object.freeze({
  artifact: Object.freeze({ state: 'missing' }),
  build: Object.freeze(lastAttempt === undefined ? { state: 'idle' } : { lastAttempt, state: 'idle' }),
  source: Object.freeze({ diagnostics: Object.freeze([]), state: 'ready' }),
});

const building = (active: RunningBuildAttempt, lastAttempt?: CompletedBuildAttempt): ProjectStatus => Object.freeze({
  artifact: Object.freeze({ state: 'missing' }),
  build: Object.freeze({ activeAttempt: active, ...(lastAttempt === undefined ? {} : { lastAttempt }), state: 'building' }),
  source: Object.freeze({ diagnostics: Object.freeze([]), state: 'ready' }),
});

/**
 * The readiness wait behind the `examples-real.e2e` source edits: the first
 * completed attempt the session did not already know is the write's build.
 * A session that reports the pre-write attempt, or a still-running one, is
 * not ready yet.
 */
describe('replaceWatchedSourceAndAwaitRebuild', () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-bundle-watched-files-'));
    project = join(root, 'project');
    await mkdir(project);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('returns the first completed attempt that was unknown before the write, after the write landed', async () => {
    const before = completed('attempt-0');
    const sequence: ProjectStatus[] = [
      idle(before),
      idle(before),
      building(running('attempt-1'), before),
      idle(completed('attempt-1')),
    ];
    let reads = 0;
    const session = { status: () => sequence[Math.min(reads++, sequence.length - 1)]! };
    const path = join(project, 'source.ts');

    const attempt = await replaceWatchedSourceAndAwaitRebuild(session, project, path, 'export const value = 2;\n', { timeoutMs: 5_000 });

    expect(attempt.id).toBe('attempt-1');
    expect(attempt.outcome).toBe('failed');
    expect(await readFile(path, 'utf8')).toBe('export const value = 2;\n');
    // The pre-write status read seeds the known set; the wait began only after the write.
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it('does not accept the pre-write attempt as the write\'s build', async () => {
    const before = completed('attempt-0');
    const session = { status: () => idle(before) };

    await expect(replaceWatchedSourceAndAwaitRebuild(session, project, join(project, 'source.ts'), 'x', { timeoutMs: 120 }))
      .rejects.toThrow(/Timed out after 120ms waiting for the watcher rebuild .*known attempts \["attempt-0"\]/u);
  });

  it('treats an attempt that was already running before the write as known', async () => {
    const active = running('attempt-1');
    const sequence: ProjectStatus[] = [building(active), idle(completed('attempt-1'))];
    let reads = 0;
    const session = { status: () => sequence[Math.min(reads++, sequence.length - 1)]! };

    await expect(replaceWatchedSourceAndAwaitRebuild(session, project, join(project, 'source.ts'), 'x', { timeoutMs: 120 }))
      .rejects.toThrow(/known attempts \["attempt-1"\]/u);
  });
});
