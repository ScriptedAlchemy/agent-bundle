import type { CompiledCliBin } from './cli-bins.ts';
import type { CompiledEntry, CompiledHookEntry, CompiledMcpEntry } from './entries.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';

/** The planned outputs of one target, before anything compiles. */
export interface PlannedTargetOutputs {
  readonly compiledCliBins: readonly Pick<CompiledCliBin, 'output' | 'workerOutput'>[];
  readonly compiledEntries: readonly Pick<CompiledEntry, 'output' | 'outputKind' | 'workerOutput'>[];
  readonly compiledHooks: readonly Pick<CompiledHookEntry, 'output' | 'workerOutput'>[];
  readonly compiledMcpApps: readonly Pick<CompiledMcpApp, 'output'>[];
  readonly compiledMcpEntries: readonly Pick<CompiledMcpEntry, 'output' | 'workerOutput'>[];
}

/**
 * One compile stage of a target, in dependency order.
 *
 * - `mcp-apps`: the browser environment — MCP App views through the
 *   workspace `@rsbuild/core`. Present only for a target that declares
 *   apps, and always first: the MCP entries embed its emitted HTML, and its
 *   pass asserts the target root holds nothing but that HTML.
 * - `node-surfaces`: every agent-host surface — the routed CLI bin, bundled
 *   scripts, hook wrappers, MCP entries, and each surface's react-server
 *   Flight worker — lowered together through one Rslib instance (one
 *   Rsbuild environment per output, one Rspack multi-compiler). A Flight
 *   worker and the host surface that spawns it share this stage: the host
 *   reaches the worker by file name at run time, never through a build-time
 *   manifest, so nothing orders them within it.
 */
export type TargetCompileStage =
  | { readonly kind: 'mcp-apps'; readonly outputs: readonly string[] }
  | { readonly kind: 'node-surfaces'; readonly outputs: readonly string[] };

const withWorkers = (
  entries: readonly { readonly output: string; readonly workerOutput?: string }[],
): readonly string[] => entries.flatMap((entry) => [
  entry.output,
  ...(entry.workerOutput === undefined ? [] : [entry.workerOutput]),
]);

/**
 * The compile stages of one target. The build runs them in this order; the
 * browser stage is skipped entirely — no Rsbuild instance — for a target
 * without MCP Apps, and the node stage creates no Rslib instance when it
 * has no outputs.
 */
export const planTargetStages = (target: PlannedTargetOutputs): readonly TargetCompileStage[] => Object.freeze([
  ...(target.compiledMcpApps.length === 0
    ? []
    : [Object.freeze({
      kind: 'mcp-apps' as const,
      outputs: Object.freeze(target.compiledMcpApps.map((app) => app.output)),
    })]),
  Object.freeze({
    kind: 'node-surfaces' as const,
    outputs: Object.freeze([
      ...withWorkers(target.compiledCliBins),
      ...withWorkers(target.compiledEntries.filter((entry) => entry.outputKind === 'bundle')),
      ...withWorkers(target.compiledHooks),
      ...withWorkers(target.compiledMcpEntries),
    ]),
  }),
]);
