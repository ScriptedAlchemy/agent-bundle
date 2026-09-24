import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactWrite } from '../adapters/types.ts';
import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { assertInside, isInside, isInsideOrEqual, toPosixRelative } from '../core/paths.ts';
import { isPlainDataRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import type { CompositePlan } from './compose.ts';

/** Native marketplace paths come from the registered schema contracts. */
export const repositoryMarketplacePaths = (registry: TargetRegistry, targets: readonly string[]): string[] =>
  [...new Set(targets.filter((target) => registry.has(target)).flatMap((target) =>
    registry.artifactValidation(target).documents
      .filter((document) => document.schema === 'marketplace')
      .map((document) => document.path)))];

export const planRepositoryMarketplaces = (
  composite: CompositePlan,
  registry: TargetRegistry,
  projectRoot: string,
  outputRoot: string,
): readonly TargetArtifactWrite[] => {
  if (!isInside(projectRoot, outputRoot)) {
    throw new Error('Repository marketplaces require an artifact output inside the project root.');
  }
  const source = `./${toPosixRelative(projectRoot, outputRoot)}`;
  const entries: TargetArtifactWrite[] = [];
  for (const projection of composite.projections) {
    const path = projection.plan.documents?.marketplace?.path;
    if (path === undefined) continue;
    const destination = assertInside(projectRoot, resolve(projectRoot, path));
    if (isInsideOrEqual(outputRoot, destination) || isInsideOrEqual(destination, outputRoot)) {
      throw new Error(`Repository marketplace ${path} overlaps the artifact output; choose a different output.distPath.`);
    }
    const host = registry.builtInHost(projection.name);
    if (host !== 'claude' && host !== 'codex' && host !== 'cursor') {
      throw new Error(`Repository marketplace emission is unsupported for ${projection.name}.`);
    }
    const entry = projection.plan.entries.find((candidate) => candidate.relativePath === path);
    if (entry?.kind !== 'write') throw new Error(`Missing generated marketplace ${path}.`);
    const document = parseJsonWithoutDuplicateKeys(entry.content);
    if (!isPlainDataRecord(document) || !Array.isArray(document['plugins'])) {
      throw new Error(`Invalid generated marketplace ${path}.`);
    }
    for (const plugin of document['plugins']) {
      if (!isPlainDataRecord(plugin)) throw new Error(`Invalid marketplace plugin in ${path}.`);
      const original = plugin['source'];
      if (host === 'codex' && isPlainDataRecord(original) && original['source'] === 'local' && original['path'] === './') {
        plugin['source'] = { ...original, path: source };
      } else if (host !== 'codex' && original === './') {
        plugin['source'] = source;
      } else {
        throw new Error(`Repository marketplace ${path} requires the generated local plugin source; remove the authored source override.`);
      }
    }
    const metadata = document['metadata'];
    if (isPlainDataRecord(metadata) && metadata['pluginRoot'] !== undefined) {
      throw new Error(`Repository marketplace ${path} cannot use metadata.pluginRoot; remove that override.`);
    }
    const schema = registry.artifactValidation(projection.name).schemas.find((candidate) => candidate.name === 'marketplace');
    if (schema === undefined || schema.validate(document).length > 0) {
      throw new Error(`Repository marketplace ${path} does not satisfy its host schema.`);
    }
    entries.push({ ...entry, content: `${stableJson(document)}\n` });
  }
  if (entries.length === 0) {
    throw new Error('No selected host emits a marketplace; for Cursor, set marketplace: true.');
  }
  return entries;
};

/** Refuse symlinks at every component before writing outside the artifact tree. */
export const checkRepositoryMarketplacePaths = async (
  root: string,
  entries: readonly TargetArtifactWrite[],
): Promise<void> => {
  for (const entry of entries) {
    const destination = assertInside(root, resolve(root, entry.relativePath));
    let path = destination;
    while (isInside(root, path)) {
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || (path === destination ? !metadata.isFile() : !metadata.isDirectory())) {
          throw new Error(`Repository marketplace output cannot replace or traverse ${path}.`);
        }
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      path = dirname(path);
    }
  }
};

export const emitRepositoryMarketplaces = async (
  root: string,
  entries: readonly TargetArtifactWrite[],
): Promise<void> => {
  await checkRepositoryMarketplacePaths(root, entries);
  for (const entry of entries) {
    const destination = assertInside(root, resolve(root, entry.relativePath));
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.marketplace-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, entry.content, { flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
};
