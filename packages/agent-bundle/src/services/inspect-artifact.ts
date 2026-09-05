import { inspectManifestSummary, type InspectManifestSummary } from '../build/manifest-projection.ts';
import { readArtifactManifest } from '../build/manifest-file.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { applicationExplorerFor, type ApplicationExplorer } from '../dev/artifacts/application-explorer.ts';

export type InspectArtifactResult = Readonly<{
  readonly application: ApplicationExplorer;
  readonly manifest: InspectManifestSummary;
}>;

const artifactManifestFailure = (message: string): DiagnosticError =>
  new DiagnosticError([{
    code: 'AB7001',
    message,
    recovery: 'Point --artifact at a built composite root that contains a canonical agent-bundle.manifest.json.',
    severity: 'error',
  }]);

/**
 * Inspects a copied built composite root through `agent-bundle.manifest.json`
 * alone — the same application projection the Workbench renders. The only
 * filesystem touch under `root` is that one file.
 */
export const inspectArtifactRoot = async (root: string): Promise<InspectArtifactResult> => {
  const read = await readArtifactManifest(root);
  switch (read.status) {
    case 'missing':
      throw artifactManifestFailure(
        `No agent-bundle.manifest.json in ${read.root}: point --artifact at a built composite root.`,
      );
    case 'invalid':
      throw artifactManifestFailure(
        `agent-bundle.manifest.json in ${read.root} is not a valid canonical artifact manifest: ${read.detail}`,
      );
    case 'ok':
      return Object.freeze({
        application: applicationExplorerFor(read.manifest),
        manifest: inspectManifestSummary(read.manifest, read.path),
      });
    default: {
      const exhaustive: never = read;
      throw new TypeError(`Unhandled artifact manifest status ${String(exhaustive)}.`);
    }
  }
};
