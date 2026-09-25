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
    version: packageIdentity.packageVersion ?? developmentFallbackVersion,
  });
};

/** {@link pluginDescriptiveMetadata}, with the provenance a projection records. */
export interface PluginDescriptiveMetadata extends DescriptiveMetadataResult {
  /**
   * The resolved `package.json`, present only when a resolved field came from
   * it rather than the config, so a projection records it as a source input
   * exactly when the artifact depends on its bytes.
   */
  readonly packageSource?: string;
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
  // would otherwise have been shared. `author.email` belongs to `author`, and
  // an explicitly `undefined` key declares nothing, so the package value (and
  // its provenance) still stands.
  const overridden = new Set(isRecord(authored)
    ? Object.keys(authored).filter((field) => authored[field] !== undefined)
    : []);
  const packageDerived = descriptiveMetadataFields
    .some((field) => !overridden.has(field) && resolved.value[field] !== undefined);
  return Object.freeze({
    issues: Object.freeze([
      ...fromPackage.issues.filter((issue) => !overridden.has(issue.field.replace(/\..*$/u, ''))),
      ...resolved.issues,
    ]),
    ...(packageDerived && fromPackage.packagePath !== undefined
      ? { packageSource: fromPackage.packagePath }
      : {}),
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
  return pluginIdentity(projectRoot, { plugin: { name: plugin.name } });
};
