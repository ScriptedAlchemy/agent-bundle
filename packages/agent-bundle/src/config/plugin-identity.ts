import type { ProjectMetaSource } from '../build/meta.ts';
import type { DescriptiveMetadataResult } from '../core/descriptive-metadata.ts';
import { descriptiveMetadataFields, resolveDescriptiveMetadata } from '../core/descriptive-metadata.ts';
import {
  developmentFallbackVersion,
  snapshotPackageDescriptiveMetadata,
  snapshotPackageIdentity,
} from '../core/project-context.ts';
import { isRecord } from '../core/strict-json.ts';
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

/** {@link pluginDescriptiveMetadata}, with the provenance a projection records. */
export interface PluginDescriptiveMetadata extends DescriptiveMetadataResult {
  /** True when any resolved field came from `package.json` rather than the config. */
  readonly packageDerived: boolean;
}

/**
 * The one shared descriptive layer a project carries: `plugin.metadata` over
 * the fields its `package.json` already declares. `normalizeProject` stamps
 * the resolved value into `model.metadata.shared`, and every host projection
 * reads it from there — so `author`, `homepage`, `keywords`, `license`, and
 * `repository` are declared once instead of once per host block. Withheld
 * fields come back as issues for `validateSource` to report against the file
 * that declared them.
 */
export const pluginDescriptiveMetadata = (
  projectRoot: string,
  config: Pick<AgentBundleConfig, 'plugin'>,
): PluginDescriptiveMetadata => {
  // Discovery and `validateSource` both run before the `plugin` block is
  // known to be an object: a malformed one stays AB4000's to report.
  const authored = isRecord(config.plugin) ? config.plugin.metadata : undefined;
  const fromPackage = snapshotPackageDescriptiveMetadata(projectRoot);
  const resolved = resolveDescriptiveMetadata(authored, fromPackage.value);
  // A package field the project already replaced (or opted out of) under
  // `plugin.metadata` is nobody's problem to fix: only report the ones that
  // would otherwise have been shared. `author.email` belongs to `author`.
  const overridden = isRecord(authored) ? new Set(Object.keys(authored)) : new Set<string>();
  return Object.freeze({
    issues: Object.freeze([
      ...fromPackage.issues.filter((issue) => !overridden.has(issue.field.replace(/\..*$/u, ''))),
      ...resolved.issues,
    ]),
    packageDerived: descriptiveMetadataFields.some((field) =>
      !overridden.has(field) && resolved.value[field] !== undefined),
    value: resolved.value,
  });
};

/**
 * {@link pluginIdentity} for a configuration that has not been validated yet
 * (discovery runs before `validateSource`): undefined when `plugin.name` is
 * not a nonempty string, so a malformed `plugin` block stays the validator's
 * `AB4000` to report rather than a crash here, and no fabricated identity is
 * ever served in its place.
 */
export const declaredPluginIdentity = (
  projectRoot: string,
  config: Readonly<Record<string, unknown>>,
): ProjectMetaSource | undefined => {
  const plugin = config.plugin;
  if (!isRecord(plugin) || typeof plugin.name !== 'string' || plugin.name.trim().length === 0) return undefined;
  // `resolvePluginVersion` already treats a non-string `version` as absent.
  return pluginIdentity(projectRoot, {
    plugin: { name: plugin.name, ...(typeof plugin.version === 'string' ? { version: plugin.version } : {}) },
  });
};
