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
 *   projection with no document of its own still points at an empty one when
 *   another selected host actually emits the conventional document.
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
 * The artifact-relative path of the one standalone react-server Flight worker
 * every event-route wrapper of the composite root shares (`planHooksSurface`).
 * Emitted exactly when some event route runs or falls back standalone; it is
 * a `files[]` row of the manifest, not an `executables` row of its own.
 */
export const hooksFlightWorkerPath = 'hooks/hooks-flight.mjs';
