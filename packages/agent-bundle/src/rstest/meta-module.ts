import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { generatedMetaModuleSource, metaModuleSpecifier, projectMeta } from '../build/meta.ts';
import type { TestManifestPluginIdentity } from '../test/manifest.ts';

/**
 * The `resolve.alias` key both Rstest presets set for `agent-bundle/meta`.
 * The trailing `$` is Rspack's exact-match marker — the same key the browser
 * MCP App compiler uses — so `agent-bundle/meta/anything` never matches.
 */
export const metaModuleAliasKey = `${metaModuleSpecifier}$`;

/**
 * Writes the identity module a test pool serves for `agent-bundle/meta`
 * (issue #386). The source is the very module the build injects
 * (`generatedMetaModuleSource` over `projectMeta`), fed from the manifest's
 * plugin identity — the identity the same compiler pass reports in
 * `initialize` — so a source module importing `{ name, version }` observes
 * under a test exactly what a compiled surface would. It lands beside the
 * generated route registry under the project's `.agent-bundle/test`
 * directory, which Rstest bundles like project source.
 */
export const writeTestMetaModule = async (
  projectRoot: string,
  plugin: TestManifestPluginIdentity,
): Promise<string> => {
  const target = resolve(projectRoot, '.agent-bundle', 'test', 'meta.mjs');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, generatedMetaModuleSource(projectMeta(plugin)), 'utf8');
  return target;
};

/** The `resolve.alias` record routing the reserved specifier to a written identity module. */
export const metaModuleAlias = (metaModulePath: string): { [specifier: string]: string } =>
  ({ [metaModuleAliasKey]: metaModulePath });
