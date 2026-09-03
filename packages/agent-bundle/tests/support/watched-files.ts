import { rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { CompletedBuildAttempt, ProjectStatus } from '../../src/dev/types.ts';

/**
 * Replaces a file the dev server may read concurrently (watcher events or an
 * in-flight prepare) with one atomic rename, so no reader ever observes a
 * truncated or partially written source. A plain writeFile truncates first:
 * a watcher can read the empty window, or coalesce the truncate and append
 * events within one mtime tick and drop the content. The temp file lives in
 * the project's parent (same filesystem, never watched) so the rename into
 * place is the only event a watcher observes.
 */
export const replaceWatchedSource = async (projectRoot: string, path: string, content: string): Promise<void> => {
  const temporary = join(projectRoot, '..', `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
};

/** The dev-server session surface the watcher-rebuild wait reads; `DevServerSession` satisfies it. */
export interface WatchedBuildSession {
  status(): ProjectStatus;
}

export interface AwaitWatcherRebuildOptions {
  /** Upper bound for the watcher's debounce plus one full development rebuild. */
  readonly timeoutMs: number;
}

const attemptIds = (status: ProjectStatus): ReadonlySet<string> => {
  const ids = new Set<string>();
  if (status.build.state === 'building') ids.add(status.build.activeAttempt.id);
  if ('lastAttempt' in status.build && status.build.lastAttempt !== undefined) ids.add(status.build.lastAttempt.id);
  return ids;
};

const pollIntervalMs = 25;

/**
 * Replaces one watched source and waits for the dev server's own
 * watcher-driven rebuild of that write to finish, returning the completed
 * attempt. This is the readiness signal a source edit needs: the coordinator
 * publishes every attempt through `status()`, and the watcher mints exactly
 * one invalidation per write (path-signature dedupe, #329), so the first
 * completed attempt the session did not know before the write is the
 * write's build. Issuing a manual rebuild in the same window instead races
 * the watcher for a second, redundant epoch whose arrival time depends on
 * load — the race behind the retired `{ retry: 2 }` guards in
 * `examples-real.e2e.test.ts`.
 */
export const replaceWatchedSourceAndAwaitRebuild = async (
  session: WatchedBuildSession,
  projectRoot: string,
  path: string,
  content: string,
  options: AwaitWatcherRebuildOptions,
): Promise<CompletedBuildAttempt> => {
  const known = attemptIds(session.status());
  await replaceWatchedSource(projectRoot, path, content);
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const status = session.status();
    if (
      status.build.state !== 'building'
      && status.build.lastAttempt !== undefined
      && !known.has(status.build.lastAttempt.id)
    ) {
      return status.build.lastAttempt;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(options.timeoutMs)}ms waiting for the watcher rebuild of ${path}; `
        + `known attempts ${JSON.stringify([...known])}; last status ${JSON.stringify(status.build)}.`,
      );
    }
    await sleep(pollIntervalMs);
  }
};
