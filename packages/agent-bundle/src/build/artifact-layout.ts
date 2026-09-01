import type { TargetArtifactOutputLayout } from '../adapters/types.ts';
import type { ArtifactFile, ManifestFile } from './emit.ts';

export const matchesManifestFile = (file: ArtifactFile, manifestFile: ManifestFile): boolean =>
  file.bytes === manifestFile.bytes &&
  (manifestFile.mode === undefined ? (file.mode & 0o111) === 0 : file.mode === manifestFile.mode) &&
  file.path === manifestFile.path &&
  file.sha256 === manifestFile.sha256;

export const isDirectOutputLayoutPath = (
  relativePath: string,
  layout: TargetArtifactOutputLayout | undefined,
): boolean => {
  if (layout === undefined) return false;
  const [directory, file, ...nested] = relativePath.split('/');
  return directory === layout.directory &&
    file !== undefined &&
    nested.length === 0 &&
    layout.allowedSuffixes.some((suffix) => file.length > suffix.length && file.endsWith(suffix));
};

export const targetArtifactPath = (target: string, path: string): string => `${target}/${path}`;

export const pathInTargetOutputLayout = (
  targetPath: string,
  target: string,
  layout: TargetArtifactOutputLayout | undefined,
): boolean => targetPath.startsWith(`${target}/`) &&
  isDirectOutputLayoutPath(targetPath.slice(target.length + 1), layout);
