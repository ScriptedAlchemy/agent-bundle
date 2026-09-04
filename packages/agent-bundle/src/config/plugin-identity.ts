import type { ProjectMetaSource } from '../build/meta.ts';
import { developmentFallbackVersion, snapshotPackageIdentity } from '../core/project-context.ts';
import type { AgentBundleConfig } from '../core/types.ts';

/**
 * The one plugin version every surface agrees on (issue #94 stage 3): an
 * authored `plugin.version` still wins so a legacy declaration never changes
 * meaning mid-migration (a disagreement with package.json is the AB4008
 * warning), an omitted one derives the release version from package.json,
 * and a project with neither carries the development fallback that
 * `agent-bundle build` refuses to package (AB4013).
 */
export const resolvePluginVersion = (
  authored: unknown,
  packageVersion: string | undefined,
): string =>
  (typeof authored === 'string' && authored.trim().length > 0 ? authored : undefined)
  ?? packageVersion
  ?? developmentFallbackVersion;

/**
 * The plugin identity axes a project carries before normalization: the
 * host-native slug from `plugin.name`, the npm axes derived from
 * `<root>/package.json` (never authored in config), and the resolved plugin
 * version. `normalizeProject` stamps exactly these into `model.metadata`, and
 * the rendered-skill loader serves them as `agent-bundle/meta` while
 * discovery evaluates `SKILL.tsx` — one derivation, so a skill that prints
 * the plugin version prints the one the artifact manifest reports.
 */
export const pluginIdentity = (
  projectRoot: string,
  config: Pick<AgentBundleConfig, 'plugin'>,
): ProjectMetaSource => {
  const packageIdentity = snapshotPackageIdentity(projectRoot);
  return Object.freeze({
    name: config.plugin.name,
    packageName: packageIdentity.packageName,
    packageVersion: packageIdentity.packageVersion,
    version: resolvePluginVersion(config.plugin.version, packageIdentity.packageVersion),
  });
};
