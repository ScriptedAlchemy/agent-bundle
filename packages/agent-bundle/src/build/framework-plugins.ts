/**
 * The Rsbuild plugins agent-bundle registers itself in the configs it
 * synthesizes, keyed by plugin `name`. Rsbuild's plugin manager appends every
 * plugin it is handed and never dedupes by name, and both engines the layers
 * from `composeToolsLayers` are handed to (`mergeRslibConfig` for artifact
 * scripts, MCP entries, hooks, and the package build; `mergeRsbuildConfig` for
 * MCP App views) concatenate `plugins` arrays, so a consumer who adds one of
 * these through `tools.rsbuild.plugins` registers it twice. `validateTools`
 * reports that as AB4724 instead.
 *
 * The names are literals rather than instances so the validator does not
 * load a bundler plugin to read a string; `framework-plugins.test.ts` pins
 * each literal to the plugin it names.
 */
export const frameworkOwnedRsbuildPlugins: ReadonlyMap<string, string> = new Map([
  // `pluginReact({ fastRefresh: false })` from rslib.ts (every synthesized
  // entry) and mcp-apps.ts (every MCP App view, whatever its entry
  // extension): automatic JSX runtime, fast refresh off.
  ['rsbuild:react', '@rsbuild/plugin-react'],
]);

const hasPluginName = (value: unknown): value is { readonly name: string } =>
  typeof value === 'object' && value !== null && typeof (value as { readonly name?: unknown }).name === 'string';

/**
 * The plugin names a `tools.rsbuild.plugins` value supplies that collide with
 * a framework-owned registration, in authored order and deduplicated. Only
 * statically visible plugin objects are inspected: nested arrays are
 * flattened the way Rsbuild flattens them, while `false`/`null`/`undefined`
 * holes and plugins supplied as Promises (which Rsbuild also accepts) carry
 * no name to compare until the build awaits them.
 */
export const frameworkOwnedPluginCollisions = (plugins: unknown): readonly string[] => {
  const collisions: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (hasPluginName(value) && frameworkOwnedRsbuildPlugins.has(value.name) && !collisions.includes(value.name)) {
      collisions.push(value.name);
    }
  };
  visit(plugins);
  return collisions;
};
