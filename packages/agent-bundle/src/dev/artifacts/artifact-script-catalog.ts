import { extname } from 'node:path';

import type { TargetRegistry } from '../../adapters/registry.ts';
import type { ArtifactManifest } from '../../build/manifest.ts';

/** A validated, target-scoped emitted script chosen by a browser-safe id. */
export interface ArtifactScriptCatalogEntry {
  readonly file: string;
  readonly id: string;
  readonly name: string;
  readonly target: string;
}

const compareCatalogEntries = (left: ArtifactScriptCatalogEntry, right: ArtifactScriptCatalogEntry): number =>
  left.target === right.target
    ? left.id === right.id ? left.file.localeCompare(right.file) : left.id.localeCompare(right.id)
    : left.target.localeCompare(right.target);

const scriptName = (file: string, allowedSuffixes: readonly string[]): string | undefined => {
  const suffix = extname(file);
  if (!allowedSuffixes.includes(suffix)) return undefined;
  const name = file.slice(0, -suffix.length);
  return name.length > 0 ? name : undefined;
};

/** Derives the sole browser-selectable script catalog from a strictly validated manifest snapshot. */
export const artifactScriptCatalog = (
  manifest: ArtifactManifest,
  registry: TargetRegistry,
): readonly ArtifactScriptCatalogEntry[] => {
  const entries: ArtifactScriptCatalogEntry[] = [];
  const identities = new Set<string>();
  for (const { host: target } of manifest.projections) {
    const layout = registry.artifactLayout(target).scripts;
    if (layout === undefined) continue;
    // Scripts live once at the composite root; every selected host that lays
    // out that directory reads the same emitted file.
    const prefix = `${layout.directory}/`;
    for (const manifestFile of manifest.files) {
      if (!manifestFile.path.startsWith(prefix)) continue;
      const file = manifestFile.path.slice(prefix.length);
      if (file.includes('/')) continue;
      const name = scriptName(file, layout.allowedSuffixes);
      if (name === undefined) continue;
      const id = `script:${name}`;
      const identity = `${target}\0${id}`;
      if (identities.has(identity)) {
        throw new Error(`Validated artifact has ambiguous emitted script ${JSON.stringify(id)} for target ${JSON.stringify(target)}.`);
      }
      identities.add(identity);
      entries.push(Object.freeze({ file: manifestFile.path, id, name, target }));
    }
  }
  entries.sort(compareCatalogEntries);
  return Object.freeze(entries);
};
