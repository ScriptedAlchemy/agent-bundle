import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import fastGlob from 'fast-glob';

import { digest, sha256File } from '../core/digest.ts';
import type { EvalFixturePlan } from './fixtures.ts';

export interface WorkspaceChange {
  readonly digest: string;
  readonly id: string;
  readonly kind: 'added' | 'modified' | 'removed';
}

export interface WorkspaceDiff {
  readonly changes: readonly WorkspaceChange[];
  readonly truncated?: true;
}

export interface WorkspaceDiffOptions {
  readonly limit?: number;
  readonly plan: EvalFixturePlan;
  readonly workspace: string;
}

const defaultLimit = 128;

/**
 * Compares a trial-owned workspace to its planned fixture without retaining a
 * file name, absolute path, or file content in evidence. The opaque ids remain
 * stable for the same relative workspace change and exact bytes.
 */
export const workspaceDiff = async (options: WorkspaceDiffOptions): Promise<WorkspaceDiff> => {
  const limit = options.limit ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_096) {
    throw new TypeError('Workspace diff limit must be a safe integer between 1 and 4096.');
  }
  const baseline = new Map(options.plan.entries.map((entry) => [entry.path, entry.sha256]));
  const seen = new Set<string>();
  const changes: WorkspaceChange[] = [];
  let truncated = false;
  const add = (kind: WorkspaceChange['kind'], path: string, changeDigest: string): void => {
    if (changes.length >= limit) {
      truncated = true;
      return;
    }
    changes.push(Object.freeze({
      digest: changeDigest,
      id: digest({ digest: changeDigest, kind, path }),
      kind,
    }));
  };

  const entries = await fastGlob('**/*', {
    cwd: options.workspace,
    dot: true,
    followSymbolicLinks: false,
    ignore: ['.git', '.git/**'],
    onlyFiles: true,
  });
  for (const path of entries.sort((left, right) => left.localeCompare(right))) {
    if (truncated) break;
    const absolute = join(options.workspace, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const current = await sha256File(absolute);
    seen.add(path);
    const expected = baseline.get(path);
    if (expected === undefined) add('added', path, current);
    else if (expected !== current) add('modified', path, current);
  }
  for (const [path, expected] of [...baseline.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (truncated) break;
    if (!seen.has(path)) add('removed', path, expected);
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    ...(truncated ? { truncated: true as const } : {}),
  });
};
