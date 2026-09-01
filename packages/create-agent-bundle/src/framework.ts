import { UsageError } from './options.ts';

const previewPattern = /-preview-([0-9a-f]{7,40})$/u;

export type PreviewPackageName = 'agent-bundle' | '@agent-bundle/runtime' | 'create-agent-bundle';

export const previewPackageSpec = (packageName: PreviewPackageName, sha: string): string =>
  `https://pkg.pr.new/ScriptedAlchemy/agent-bundle/${packageName}@${sha}`;

export const previewFrameworkSpec = (sha: string): string => previewPackageSpec('agent-bundle', sha);

/**
 * Resolve the dependency spec the scaffolded project pins `agent-bundle` to.
 *
 * `--framework-version` wins verbatim (a version, a `file:` tarball, or any
 * URL npm accepts). Otherwise the sha is derived from this scaffolder's own
 * preview version: pkg.pr.new publishes every workspace package of one
 * commit under the same `<version>-preview-<sha>` string, so the paired
 * `agent-bundle` preview of the very build that shipped this scaffolder is
 * always the right default. There is no derivable default outside a preview
 * build — the `agent-bundle` name on npm belongs to an unrelated project, so
 * falling back to a semver range would install the wrong package.
 */
export const resolveFrameworkSpec = (ownVersion: string, flag: string | undefined): string => {
  if (flag !== undefined && flag.trim() !== '') return flag.trim();
  const preview = previewPattern.exec(ownVersion);
  if (preview !== null) return previewFrameworkSpec(preview[1]!);
  throw new UsageError(
    `This build of create-agent-bundle (${ownVersion}) is not a pkg.pr.new preview, so it cannot derive `
    + 'a default agent-bundle version. Pass --framework-version <spec> — for example '
    + '--framework-version https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@<sha>.',
  );
};
