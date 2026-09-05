import type { CompiledCliBin } from './cli-bins.ts';
import type { CompiledEntry, CompiledHookEntry, CompiledMcpEntry } from './entries.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';

/** The planned compiled outputs of the composite root, before anything compiles. */
export interface PlannedRootOutputs {
  readonly compiledCliBins: readonly Pick<CompiledCliBin, 'output' | 'workerOutput'>[];
  readonly compiledEntries: readonly Pick<CompiledEntry, 'output' | 'outputKind' | 'workerOutput'>[];
  readonly compiledHooks: readonly Pick<CompiledHookEntry, 'executorOutput' | 'output' | 'workerOutput'>[];
  readonly compiledMcpApps: readonly Pick<CompiledMcpApp, 'output'>[];
  readonly compiledMcpEntries: readonly Pick<CompiledMcpEntry, 'output' | 'workerOutput'>[];
}

/**
 * One compile stage of the composite root, in dependency order.
 *
 * - `mcp-apps`: the browser environment — MCP App views through the
 *   workspace `@rsbuild/core`. Present only when the selection reaches an
 *   app, and always first: the MCP entries embed its emitted HTML, and its
 *   pass asserts the root holds nothing but that HTML.
 * - `node-surfaces`: every agent-host surface — the routed CLI bin, bundled
 *   scripts, hook wrappers, MCP entries, and each surface's react-server
 *   Flight worker — lowered together through one Rslib instance (one
 *   Rsbuild environment per output, one Rspack multi-compiler). A Flight
 *   worker and the host surface that spawns it share this stage: the host
 *   reaches the worker by file name at run time, never through a build-time
 *   manifest, so nothing orders them within it.
 */
export type CompileStage =
  | { readonly kind: 'mcp-apps'; readonly outputs: readonly string[] }
  | { readonly kind: 'node-surfaces'; readonly outputs: readonly string[] };

const withWorkers = (
  entries: readonly {
    readonly executorOutput?: string;
    readonly output: string;
    readonly workerOutput?: string;
  }[],
): readonly string[] => entries.flatMap((entry) => [
  entry.output,
  ...(entry.executorOutput === undefined ? [] : [entry.executorOutput]),
  ...(entry.workerOutput === undefined ? [] : [entry.workerOutput]),
]);

/**
 * The compile stages of the composite root. The build runs them in this
 * order; the browser stage is skipped entirely — no Rsbuild instance — for a
 * root without MCP Apps, and the node stage creates no Rslib instance when
 * it has no outputs.
 */
export const planCompileStages = (root: PlannedRootOutputs): readonly CompileStage[] => Object.freeze([
  ...(root.compiledMcpApps.length === 0
    ? []
    : [Object.freeze({
      kind: 'mcp-apps' as const,
      outputs: Object.freeze(root.compiledMcpApps.map((app) => app.output)),
    })]),
  Object.freeze({
    kind: 'node-surfaces' as const,
    outputs: Object.freeze([
      ...withWorkers(root.compiledCliBins),
      ...withWorkers(root.compiledEntries.filter((entry) => entry.outputKind === 'bundle')),
      ...withWorkers(root.compiledHooks),
      ...withWorkers(root.compiledMcpEntries),
    ]),
  }),
]);
