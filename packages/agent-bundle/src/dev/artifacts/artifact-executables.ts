import type { ArtifactManifest } from '../../build/manifest.ts';

export interface ArtifactManifestScriptExecution {
  readonly id: string;
  readonly mode: 'bundle' | 'copy';
  readonly name: string;
  readonly path: string;
  readonly rendered?: string;
  readonly target: string;
  readonly worker?: string;
}

const compareScriptExecutions = (
  left: ArtifactManifestScriptExecution,
  right: ArtifactManifestScriptExecution,
): number => left.target === right.target
  ? left.id.localeCompare(right.id)
  : left.target.localeCompare(right.target);

/** Expands each authoritative manifest script into its host-scoped execution rows. */
export const artifactManifestScriptExecutions = (
  manifest: ArtifactManifest,
): readonly ArtifactManifestScriptExecution[] => {
  const executions = manifest.executables.scripts.flatMap((script) =>
    script.hosts.map((target): ArtifactManifestScriptExecution => Object.freeze({
      id: script.id,
      mode: script.mode,
      name: script.name,
      path: script.path,
      ...(script.rendered === undefined ? {} : { rendered: script.rendered.routeId }),
      target,
      ...(script.worker === undefined ? {} : { worker: script.worker }),
    })));
  executions.sort(compareScriptExecutions);
  return Object.freeze(executions);
};
