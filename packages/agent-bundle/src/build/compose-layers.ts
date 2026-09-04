import type { AgentBundleToolsConfig } from '../core/types.ts';

/** The `tools.rspack` hatch shape: an Rspack config fragment, a mutator, or an array of either. */
export type ToolsRspackHatch = NonNullable<AgentBundleToolsConfig['rspack']>;

/** The `tools.rsbuild` hatch shape: an Rsbuild environment-config fragment. */
export type ToolsRsbuildFragment = NonNullable<AgentBundleToolsConfig['rsbuild']>;

/**
 * The composition order every bundler config agent-bundle synthesizes
 * follows, whichever engine lowers it: the framework profile first, the
 * consumer `tools.rsbuild` fragment over it, the consumer `tools.rspack`
 * hatch over that, and the framework invariant layer last, where no hatch
 * value can reach it. Rslib's "raw user config highest" priority and
 * Rspress's `builderConfig` position place the consumer exactly here.
 *
 * The layers are returned rather than merged because Rslib (`lib: [{ id }]`
 * entries merged by `mergeRslibConfig`) and Rsbuild (`mergeRsbuildConfig`)
 * take different containers; each caller lifts every layer into its own
 * container and hands them to its engine's merge in this order. `lift` maps
 * the two hatch fragments into the caller's layer type — the only place the
 * workspace `@rsbuild/core` hatch types cross into the executing engine's.
 */
export const composeToolsLayers = <Layer>(options: {
  readonly invariants: Layer;
  readonly lift: {
    readonly rsbuild: (fragment: ToolsRsbuildFragment) => Layer;
    readonly rspack: (hatch: ToolsRspackHatch) => Layer;
  };
  readonly profile: Layer;
  readonly tools?: AgentBundleToolsConfig;
}): readonly Layer[] => Object.freeze([
  options.profile,
  ...(options.tools?.rsbuild === undefined ? [] : [options.lift.rsbuild(options.tools.rsbuild)]),
  ...(options.tools?.rspack === undefined ? [] : [options.lift.rspack(options.tools.rspack)]),
  options.invariants,
]);

/**
 * The invariant layer shared by every synthesized config. Dist cleaning
 * stays off no matter what the consumer asks for: every surface of one
 * target builds into one shared staged root, so an environment cleaning its
 * dist path would delete sibling outputs already emitted there (the artifact
 * is published atomically from the staged root instead). `enforce` is the
 * engine-specific Rspack mutator appended after the consumer's, so a hatch
 * mutator can neither strip the generated modules nor undo the invariants.
 */
export const frameworkInvariantLayer = <Mutator>(enforce: Mutator): {
  readonly output: { readonly cleanDistPath: false };
  readonly tools: { readonly rspack: Mutator };
} => ({ output: { cleanDistPath: false }, tools: { rspack: enforce } });
