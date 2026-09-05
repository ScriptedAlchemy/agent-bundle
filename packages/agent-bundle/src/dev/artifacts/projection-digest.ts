import { listArtifactFiles, type ArtifactFile } from '../../build/emit.ts';
import { digest } from '../../core/digest.ts';

/**
 * Every selected host reads the same composite artifact root, so a host's
 * digest covers the whole root; the host name keeps each projection's identity
 * distinct. The epoch store records these and the playgrounds verify against
 * them, so both sides must derive the digest here.
 */
const projectionDigest = (files: readonly ArtifactFile[], target: string): string =>
  digest({ files, target });

/** One digest per selected host, read from the artifact root once. */
export const projectionDigests = async (
  artifactRoot: string,
  targets: readonly string[],
): Promise<Readonly<Record<string, string>>> => {
  const files = await listArtifactFiles(artifactRoot);
  return Object.freeze(Object.fromEntries(targets.map((target) => [target, projectionDigest(files, target)])));
};
