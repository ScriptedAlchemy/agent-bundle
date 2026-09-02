import { posix } from 'node:path';

import { isContainedRelativePath, safeArtifactPath } from '../core/paths.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { artifactDiagnostic as diagnostic } from './artifact-diagnostics.ts';
import { targetArtifactPath } from './artifact-layout.ts';

const isRemoteLogoReference = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const manifestLogoPathDiagnostics = (options: {
  readonly files: ReadonlySet<string>;
  readonly generatedPath: string;
  readonly logo: string;
  readonly target: string;
}): readonly Diagnostic[] => {
  if (isRemoteLogoReference(options.logo)) return Object.freeze([]);
  const relativePath = posix.normalize(options.logo.replace(/^\.\//u, ''));
  if (!isContainedRelativePath(relativePath) || !safeArtifactPath(relativePath)) {
    return Object.freeze([diagnostic(
      'AB6025',
      `Plugin logo ${JSON.stringify(options.logo)} escapes the artifact for target ${JSON.stringify(options.target)}.`,
      options.generatedPath,
      options.target,
    )]);
  }
  const artifactPath = targetArtifactPath(options.target, relativePath);
  if (options.files.has(artifactPath)) return Object.freeze([]);
  return Object.freeze([diagnostic(
    'AB6025',
    `Plugin logo ${JSON.stringify(options.logo)} references missing artifact file ${JSON.stringify(artifactPath)}.`,
    options.generatedPath,
    options.target,
  )]);
};
