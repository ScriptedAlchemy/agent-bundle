import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ArtifactRootContracts, TargetRegistry } from '../adapters/registry.ts';
import { isErrno } from '../core/errors.ts';
import { joinArtifact } from '../core/paths.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';
import { artifactManifestName } from './emit.ts';
import { parseArtifactManifest } from './manifest.ts';

/**
 * The root contracts of a built artifact (#555), derived from the targets its
 * manifest declares; undefined when there is no manifest (a host's namespaced
 * view, or a plain plugin directory) or it names no registered target.
 * Callers validate the artifact before trusting the layout this describes.
 */
export const readArtifactRootContracts = async (
  artifactRoot: string,
  registry: TargetRegistry,
): Promise<ArtifactRootContracts | undefined> => {
  const targets = await readArtifactTargets(artifactRoot);
  const known = targets?.filter((name) => registry.has(name)) ?? [];
  return known.length === 0 ? undefined : registry.root(known);
};

/**
 * The targets a built artifact's manifest declares — the hosts its one root
 * projects — or undefined when there is no manifest at that root.
 */
export const readArtifactTargets = async (artifactRoot: string): Promise<readonly string[] | undefined> => {
  let contents: string;
  try {
    contents = await readFile(join(artifactRoot, artifactManifestName), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return parseArtifactManifest(contents).targets.map((target) => target.name);
};

/**
 * The directory one host reads as its plugin root inside a built artifact:
 * the root itself for every host except a namespaced view (`portable/`
 * beside other hosts), and the root itself when no contracts are known.
 */
export const hostRootDirectory = (
  artifactRoot: string,
  root: ArtifactRootContracts | undefined,
  host: string,
): string => {
  const hostRoot = root?.hostRoot(host) ?? '';
  return hostRoot === '' ? artifactRoot : joinArtifact(artifactRoot, hostRoot);
};

/** The MCP runtime contract one host follows inside a built artifact, with any relocated document path. */
export const hostMcpRuntime = (
  root: ArtifactRootContracts | undefined,
  registry: TargetRegistry,
  host: string,
): TargetMcpRuntimeContract | undefined => root?.mcpRuntimeFor(host) ?? registry.mcpRuntime(host);
