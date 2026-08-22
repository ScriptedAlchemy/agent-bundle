import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isErrno } from '../core/errors.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import type { DirectorySyncReason } from './playground-durability.ts';
import { playgroundServiceError as serviceError } from './playground-protocol.ts';

/**
 * The playground store's on-disk layout: the directory names under the
 * storage root and the validated, durably created bootstrap that resolves
 * them to real paths.
 */

export const objectDirectoryName = 'session-objects';
export const indexDirectoryName = 'session-index';
export const pendingIndexDirectoryName = '.pending';

/** Resolved real-path roots of a validated playground storage layout. */
export interface PlaygroundStorageLayout {
  readonly indexRoot: string;
  readonly objectRoot: string;
  readonly pendingIndexRoot: string;
}

type SyncDirectory = (path: string, reason: DirectorySyncReason) => void;

const createLayoutDirectory = async (
  path: string,
  parent: string,
  reason: DirectorySyncReason,
  syncDirectory: SyncDirectory,
): Promise<void> => {
  let created = false;
  try {
    await mkdir(path);
    created = true;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage layout must contain real directories.');
  }
  if (created) syncDirectory(parent, reason);
};

const createStorageRoot = async (
  projectRoot: string,
  storageRoot: string,
  syncDirectory: SyncDirectory,
): Promise<void> => {
  const storageRelativePath = relative(projectRoot, storageRoot);
  if (storageRelativePath === '') return;
  const segments = storageRelativePath.split(sep);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be a contained directory path.');
  }
  let parent = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const path = join(parent, segments[index]!);
    await createLayoutDirectory(
      path,
      parent,
      index === segments.length - 1 ? 'layout-storage-entry' : 'layout-project-entry',
      syncDirectory,
    );
    parent = path;
  }
};

/** Validates containment, durably creates the layout, and resolves its real-path roots. */
export const initializePlaygroundStorageLayout = async (
  projectRoot: string,
  storageRoot: string,
  syncDirectory: SyncDirectory,
): Promise<PlaygroundStorageLayout> => {
  if (!isAbsolute(projectRoot) || !isAbsolute(storageRoot)) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be an absolute project-owned path.');
  }
  const requestedProjectRoot = resolve(projectRoot);
  const requestedStorageRoot = resolve(storageRoot);
  if (!isInsideOrEqual(requestedProjectRoot, requestedStorageRoot)) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be contained by the configured project root.');
  }
  const resolvedProjectRoot = await realpath(requestedProjectRoot);
  await createStorageRoot(requestedProjectRoot, requestedStorageRoot, syncDirectory);
  const storageStat = await lstat(requestedStorageRoot);
  if (storageStat.isSymbolicLink()) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must not be a symbolic link.');
  }
  const resolvedStorageRoot = await realpath(requestedStorageRoot);
  if (!isInsideOrEqual(resolvedProjectRoot, resolvedStorageRoot)) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root resolves outside the configured project root.');
  }
  const objectRoot = join(requestedStorageRoot, objectDirectoryName);
  await createLayoutDirectory(objectRoot, requestedStorageRoot, 'layout-object-entry', syncDirectory);
  const resolvedObjectRoot = await realpath(objectRoot);
  if (!isInsideOrEqual(resolvedStorageRoot, resolvedObjectRoot)) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object root resolves outside configured storage.');
  }
  const indexRoot = join(requestedStorageRoot, indexDirectoryName);
  const pendingIndexRoot = join(indexRoot, pendingIndexDirectoryName);
  await createLayoutDirectory(indexRoot, requestedStorageRoot, 'layout-index-entry', syncDirectory);
  await createLayoutDirectory(pendingIndexRoot, indexRoot, 'layout-pending-index-entry', syncDirectory);
  const resolvedIndexRoot = await realpath(indexRoot);
  const resolvedPendingIndexRoot = await realpath(pendingIndexRoot);
  if (!isInsideOrEqual(resolvedStorageRoot, resolvedIndexRoot) || !isInsideOrEqual(resolvedIndexRoot, resolvedPendingIndexRoot)) {
    throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session index root resolves outside configured storage.');
  }
  return Object.freeze({
    indexRoot: resolvedIndexRoot,
    objectRoot: resolvedObjectRoot,
    pendingIndexRoot: resolvedPendingIndexRoot,
  });
};
