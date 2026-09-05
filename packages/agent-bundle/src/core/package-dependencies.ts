import npa from 'npm-package-arg';

import { isRecord } from './strict-json.ts';

/**
 * The `package.json` dependency grammar as a consumer's npm reads it, shared by
 * the prepack gate (`build/pack-dependencies.ts`, `AB7014`/`AB7015`) and
 * config validation (`AB4751`). A leaf so `agent-bundle/config` never loads the
 * packed-file scanners.
 */

/**
 * The `package.json` fields npm installs alongside the published package.
 * `peerDependencies` counts because npm 7+ installs peers automatically;
 * `devDependencies` never reach a consumer and are not inspected.
 */
const installedDependencyFields = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const);

export type InstalledDependencyField = (typeof installedDependencyFields)[number];

export interface DeclaredDependency {
  readonly field: InstalledDependencyField;
  readonly name: string;
  readonly specifier: string;
  /** Embedded in the tarball by npm (`bundleDependencies`), so a consumer never fetches its specifier. */
  readonly bundled: boolean;
  /**
   * Fetched for a consumer. `false` for a peer `peerDependenciesMeta` marks
   * optional: npm parses its specifier — an unsupported protocol still fails
   * the install — but never installs it, so no packed file has to use it.
   */
  readonly installed: boolean;
}

/** Peers `peerDependenciesMeta` marks optional: npm parses but never installs them. */
const optionalPeers = (packageDocument: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const meta = packageDocument.peerDependenciesMeta;
  return new Set(isRecord(meta)
    ? Object.entries(meta).filter(([, entry]) => isRecord(entry) && entry.optional === true).map(([name]) => name)
    : []);
};

/**
 * Which dependencies npm embeds under `node_modules` in the published tarball:
 * `bundleDependencies` (or the `bundledDependencies` spelling) as a name list,
 * or `true` for every entry of `dependencies`. Peers are never bundled, whatever
 * the list says: npm packs no `node_modules` entry for a peer-only name, so a
 * consumer still resolves the peer's own specifier.
 */
const bundledDependencies = (
  packageDocument: Readonly<Record<string, unknown>>,
): ((field: InstalledDependencyField, name: string) => boolean) => {
  const value = packageDocument.bundleDependencies ?? packageDocument.bundledDependencies;
  const names = new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return (field, name) => field !== 'peerDependencies' && (value === true ? field === 'dependencies' : names.has(name));
};

/**
 * The entries a consumer's npm reads, one per name and field. A name in both
 * `dependencies` and `optionalDependencies` is the optional entry (npm lets
 * the optional declaration override), and a peer that `dependencies` or
 * `optionalDependencies` also names is that concrete entry — npm resolves
 * the concrete declaration and never reads the duplicate peer's selector; an
 * optional peer is kept, not `installed`.
 */
export const declaredDependencies = (packageDocument: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] => {
  const skippedPeers = optionalPeers(packageDocument);
  const bundled = bundledDependencies(packageDocument);
  const entries = (field: InstalledDependencyField): readonly (readonly [string, string])[] => {
    const value = packageDocument[field];
    return isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : [];
  };
  const optional = new Set(entries('optionalDependencies').map(([name]) => name));
  const concrete = new Set([...entries('dependencies').map(([name]) => name), ...optional]);
  const shadowed = (field: InstalledDependencyField, name: string): boolean => {
    switch (field) {
      case 'dependencies': return optional.has(name);
      case 'peerDependencies': return concrete.has(name);
      case 'optionalDependencies': return false;
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  };
  return installedDependencyFields.flatMap((field) => entries(field)
    .filter(([name]) => !shadowed(field, name))
    .map(([name, specifier]) => ({
      field,
      name,
      specifier,
      bundled: bundled(field, name),
      installed: !(field === 'peerDependencies' && skippedPeers.has(name)),
    })));
};

/**
 * True when npm reads the text as exactly one package name with no selector:
 * `sharp`, `@scope/name`, and legacy-cased names such as `JSONStream`; not a
 * subpath (`sharp/lib`), a selector (`sharp@1`), a path, or a URL scheme.
 */
export const isBarePackageName = (text: string): boolean => {
  let parsed;
  try {
    parsed = npa(text);
  } catch {
    return false;
  }
  return parsed.type === 'range' && parsed.rawSpec === '*' && parsed.name === text;
};
