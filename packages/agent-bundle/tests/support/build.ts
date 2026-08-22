import { build as buildArtifact, type BuildOptions, type BuildResult } from '../../src/build/build.ts';
import { createProjectContext } from '../../src/core/project-context.ts';
import { snapshotProjectSource } from '../../src/dev/project-service.ts';

export const build = async (
  options: Omit<BuildOptions, 'projectContext'>,
): Promise<BuildResult> => {
  const snapshot = await snapshotProjectSource(
    options.projectRoot,
    options.model.metadata.provenance.sourcePath,
    [options.outputRoot],
  );
  return buildArtifact({
    ...options,
    projectContext: createProjectContext({
      configPath: options.model.metadata.provenance.sourcePath,
      model: options.model,
      root: options.projectRoot,
      sourceInputs: snapshot.inputs,
    }),
  });
};
