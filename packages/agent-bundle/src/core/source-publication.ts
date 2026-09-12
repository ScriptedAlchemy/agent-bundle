import { DiagnosticError, type Diagnostic } from './diagnostics.ts';
import type { ProjectSourceInput, ProjectSourceSnapshotInput } from './project-context.ts';

/** True when a re-snapshot still matches the inputs preparation hashed. */
export const sameProjectSourceInputs = (
  left: readonly ProjectSourceInput[],
  right: readonly ProjectSourceSnapshotInput[],
): boolean =>
  left.length === right.length && left.every((input, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      input.path === candidate.path &&
      candidate.error === undefined &&
      input.executable === candidate.executable &&
      input.sha256 === candidate.sha256;
  });

export const projectSourceChangedDiagnostic = (configPath: string): Diagnostic => Object.freeze({
  code: 'AB7101',
  message: 'Project source changed while the artifact was compiling; publication was rejected.',
  severity: 'error',
  sourcePath: configPath,
});

/**
 * Refuses publication when the complete source-input snapshot no longer
 * equals the snapshot taken at preparation. Call this after compilation
 * and validation, while the artifact is still staged, and before
 * `publishArtifact` replaces live output.
 */
export const requireUnchangedSourceSnapshot = async (
  snapshotSource: () => Promise<{ readonly inputs: readonly ProjectSourceSnapshotInput[] }>,
  sourceInputs: readonly ProjectSourceInput[],
  configPath: string,
): Promise<void> => {
  const currentSource = await snapshotSource();
  if (!sameProjectSourceInputs(sourceInputs, currentSource.inputs)) {
    throw new DiagnosticError([projectSourceChangedDiagnostic(configPath)]);
  }
};
