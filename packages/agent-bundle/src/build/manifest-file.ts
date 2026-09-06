import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage, isErrno } from '../core/errors.ts';

import { artifactManifestName, parseArtifactManifest, type ArtifactManifest } from './manifest.ts';

/**
 * The one way a consumer opens a built artifact: `agent-bundle.manifest.json`
 * at the root it was handed. `install`, `doctor`, `uninstall`, `eval`,
 * `serve-app`, and the test harness all read the root through this result
 * and map it to their own diagnostic; none probes a host document to learn
 * what the root contains (#592 step 3, #555 W2/S3).
 */
export type ArtifactManifestReadResult =
  | Readonly<{ readonly manifest: ArtifactManifest; readonly path: string; readonly root: string; readonly status: 'ok' }>
  | Readonly<{ readonly path: string; readonly root: string; readonly status: 'missing' }>
  | Readonly<{ readonly detail: string; readonly path: string; readonly root: string; readonly status: 'invalid' }>;

export const readArtifactManifest = async (from: string): Promise<ArtifactManifestReadResult> => {
  const root = resolve(from);
  const path = join(root, artifactManifestName);
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    // Only an absent file is "missing"; a directory, a permission refusal, or
    // an I/O failure is a manifest that exists and cannot be read.
    if (isErrno(error, 'ENOENT')) return Object.freeze({ path, root, status: 'missing' });
    return Object.freeze({ detail: errorMessage(error), path, root, status: 'invalid' });
  }
  try {
    const canonicalRoot = await realpath(root);
    return Object.freeze({
      manifest: parseArtifactManifest(bytes),
      path: join(canonicalRoot, artifactManifestName),
      root: canonicalRoot,
      status: 'ok',
    });
  } catch (error) {
    return Object.freeze({ detail: errorMessage(error), path, root, status: 'invalid' });
  }
};
