import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isErrno } from '../core/errors.ts';

// Host-neutral spine shared by the native Claude and Codex contracts: normal-home
// snapshot/compare mechanics, file-tree digesting, child-environment filtering,
// and smoke opt-in gating. Per-host semantics (which sites to digest, which
// environment names to strip, diagnostic codes and wording) stay in each
// host's contract so on-disk and wire behavior remains byte-identical.

export interface DigestFileTreeOptions {
  /** Directory entries whose name matches are left out of the preimage. */
  readonly exclude?: (name: string) => boolean;
  /** When false, hash mtime instead of file bytes. Default true. */
  readonly hashContents?: boolean;
  /** When true, include mode and size in the file preimage. Default false. */
  readonly includeIdentity?: boolean;
}

/**
 * Sorted-children, NUL-delimited sha256 tree hash. Missing paths hash as `absent`.
 * Callers that compare before/after snapshots must keep a stable preimage per site.
 */
export const digestFileTree = async (
  path: string,
  options: DigestFileTreeOptions = {},
): Promise<string> => {
  const hashContents = options.hashContents ?? true;
  const includeIdentity = options.includeIdentity ?? false;
  try {
    const entry = await lstat(path);
    const digest = createHash('sha256');
    if (entry.isFile()) {
      if (includeIdentity) digest.update(`file\0${entry.mode}\0${entry.size}\0`);
      else digest.update('file\0');
      if (hashContents) digest.update(await readFile(path));
      else digest.update(`${entry.mtimeMs}\0`);
      return digest.digest('hex');
    }
    if (entry.isDirectory()) {
      digest.update('directory\0');
      const children = await readdir(path, { withFileTypes: true });
      for (const child of [...children].sort((left, right) => left.name.localeCompare(right.name))) {
        if (options.exclude?.(child.name) === true) continue;
        digest.update(`${child.name}\0${await digestFileTree(join(path, child.name), options)}\0`);
      }
      return digest.digest('hex');
    }
    digest.update(`other\0${entry.mode}\0`);
    return digest.digest('hex');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'absent';
    throw error;
  }
};

/** A frozen record of per-site digests taken before and after a native smoke. */
export type DigestSnapshot<Site extends string> = Readonly<Record<Site, string>>;

/** How each host digests its own normal-home sites; the site list is the per-host delta. */
export type DigestSnapshotSites<Site extends string> = Readonly<Record<Site, () => Promise<string>>>;

export const snapshotDigestSites = async <Site extends string>(
  sites: DigestSnapshotSites<Site>,
): Promise<DigestSnapshot<Site>> => {
  const snapshot: Partial<Record<Site, string>> = {};
  for (const site of Object.keys(sites) as Site[]) {
    snapshot[site] = await sites[site]();
  }
  return Object.freeze(snapshot) as DigestSnapshot<Site>;
};

export const sameDigestSnapshot = <Site extends string>(
  left: DigestSnapshot<Site>,
  right: DigestSnapshot<Site>,
): boolean => (Object.keys(left) as Site[]).every((site) => left[site] === right[site]);

/** Returns a copy of the environment without entries whose name the predicate matches. */
export const withoutEnvironmentKeysMatching = (
  environment: Readonly<NodeJS.ProcessEnv>,
  matches: (name: string) => boolean,
): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(environment).filter(([name]) => !matches(name)));

/** Native smokes are opt-in; they run only when the host-specific flag is exactly '1'. */
export const nativeSmokeOptIn = (
  environment: Readonly<NodeJS.ProcessEnv>,
  flag: string,
): boolean => environment[flag] === '1';

export const isMissingExecutableError = (error: unknown): boolean => isErrno(error, 'ENOENT');
