/**
 * Where the selected host projections place the files they cannot share
 * inside the one composite root (#555).
 *
 * Every selected host lays its projection into the same artifact root, so a
 * file two hosts would both emit is either byte-identical (merged once) or a
 * fatal `AB4103` collision. Files that are host-specific by nature get a
 * deterministic home instead of colliding:
 *
 * - **Hook and MCP documents** live at fixed per-host paths whatever the
 *   selection, so a single-host root and a composite root share one layout.
 *   Claude Code and the portable Agent Plugins format load theirs from the
 *   conventional plugin-root locations (`hooks/hooks.json`, `.mcp.json`,
 *   `mcp.json`) and cannot be redirected; Codex and Cursor manifests carry
 *   explicit `hooks` / `mcpServers` / `mcp` pointers, so their documents live
 *   beside their manifests (`.codex-plugin/hooks.json`, `.cursor-plugin/mcp.json`,
 *   …). Each adapter owns its constants. Both hosts also fall back to folder
 *   discovery of the conventional paths when the pointer is absent, so a
 *   projection with no document of its own still points at an empty one
 *   whenever a selected host claims the conventional path
 *   (`folderDiscoveryShadowed`).
 * - **Hook wrappers** bake the host they were planned for (its codec, its
 *   `target`, its host contract revision), so a hook that reaches several
 *   selected hosts compiles one wrapper per host, `hooks/<name>.<host>.mjs`;
 *   a hook only one selected host receives keeps `hooks/<name>.mjs`.
 *
 * Those agreements hold between the built-in hosts only. An adapter
 * registered on an advanced `TargetRegistry` has made none of them, so it
 * gets a root of its own: `validateModel` refuses a selection that mixes it
 * with any other target (`AB4106`), and the install surface documents only
 * the built-in hosts it finds in a selection.
 */

/** The hosts Agent Bundle ships adapters for: the only targets that may share one composite root. */
export type BuiltInHost = 'claude' | 'codex' | 'cursor' | 'portable';

/** The built-in hosts, in the fixed order the install surface documents them. */
export const builtInHostNames: readonly BuiltInHost[] = Object.freeze(['claude', 'codex', 'cursor', 'portable']);

export const isBuiltInHost = (target: string): target is BuiltInHost =>
  (builtInHostNames as readonly string[]).includes(target);

/** The composite identity of a selection: its host names, sorted, joined by `+`. */
export const projectionIdentity = (selected: Iterable<string>): string =>
  sortedProjections(selected).join('+');

/** The selected host names, sorted and unique — the order every composite output uses. */
export const sortedProjections = (selected: Iterable<string>): readonly string[] =>
  Object.freeze([...new Set(selected)].sort((left, right) => left.localeCompare(right)));

/**
 * The artifact-relative path of the wrapper compiled for `host` from a hook
 * that reaches `hookTargets`: shared hooks compile one wrapper per selected
 * host, single-host hooks keep the unsuffixed name.
 */
export const hookWrapperPath = (
  host: string,
  hookName: string,
  hookTargets: readonly string[],
  selected: Iterable<string>,
): string => {
  const selection = new Set(selected);
  const reached = hookTargets.filter((target) => selection.has(target));
  return reached.length > 1 ? `hooks/${hookName}.${host}.mjs` : `hooks/${hookName}.mjs`;
};

/**
 * The plugin-root documents Codex and Cursor load by folder discovery when
 * their manifest carries no pointer, and the selected hosts whose projection
 * writes one there. `hooks/hooks.json` and `.mcp.json` are Claude Code's;
 * `mcp.json` is the portable format's. Cursor documents the fallback for both
 * of its defaults and Codex for `hooks/hooks.json`; Codex's behaviour without
 * an `mcpServers` pointer is not pinned, and an explicit empty pointer costs
 * nothing, so it is shielded the same way.
 */
const folderDiscoveryClaimants: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.mcp.json': Object.freeze(['claude']),
  'hooks/hooks.json': Object.freeze(['claude']),
  'mcp.json': Object.freeze(['portable']),
});

/**
 * True when a selected host writes the conventional document at
 * `defaultPath`, so a host that would otherwise fall back to folder
 * discovery there must point its manifest at a document of its own.
 */
export const folderDiscoveryShadowed = (defaultPath: string, selected: Iterable<string>): boolean => {
  const selection = new Set(selected);
  return (folderDiscoveryClaimants[defaultPath] ?? []).some((host) => selection.has(host));
};
