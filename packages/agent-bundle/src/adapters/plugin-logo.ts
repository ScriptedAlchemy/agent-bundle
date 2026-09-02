import type { NormalizedPlugin } from '../core/types.ts';
import { sourceInputs, type TargetArtifactCopy, type TargetArtifactEntry } from './types.ts';

export const pluginLogoManifestRef = (artifactPath: string): string =>
  artifactPath.startsWith('./') ? artifactPath : `./${artifactPath}`;

export const pluginLogoCopyEntry = (model: NormalizedPlugin): TargetArtifactCopy | undefined => {
  const logo = model.metadata.logo;
  if (logo === undefined) return undefined;
  return {
    bytes: logo.bytes,
    kind: 'copy',
    relativePath: logo.path,
    source: logo.source,
    sourceInputs: sourceInputs(logo.source, model.metadata.provenance.sourcePath),
  };
};

export const withPluginLogoEntry = (
  entries: readonly TargetArtifactEntry[],
  model: NormalizedPlugin,
): TargetArtifactEntry[] => {
  const logoEntry = pluginLogoCopyEntry(model);
  if (logoEntry === undefined || entries.some((entry) => entry.relativePath === logoEntry.relativePath)) {
    return [...entries];
  }
  return [...entries, logoEntry];
};
