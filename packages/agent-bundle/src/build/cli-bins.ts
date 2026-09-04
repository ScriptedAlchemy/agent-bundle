import { resolve } from 'node:path';

import { cliBinCapability } from '../adapters/capability-state.ts';
import type { TargetRegistry } from '../adapters/registry.ts';
import { routedCliBinLayout, type TargetArtifactEntry } from '../adapters/types.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { AgentBundleToolsConfig, NormalizedBinEntry, NormalizedPlugin } from '../core/types.ts';
import type { AgentBundleMeta } from '../meta.ts';
import { resolveArtifactDestination } from './emit.ts';
import { runtimeIgnoredRoot, type CompiledEntry } from './entries.ts';
import {
  cliEntryRuntimePath,
  cliEntryRuntimeSpecifier,
  generatedCliBinEntrySource,
  generatedRenderedRouteWorkerSource,
} from './entry-shell.ts';
import { buildWithRslib, type RslibEntry } from './rslib.ts';

/**
 * The artifact-hosted routed CLI (#387). A generated-mode `src/cli/**`
 * surface already compiles into the npm package bin (`dist/bin/<name>.js`);
 * this module emits the same compiled command graph into every host artifact
 * whose adapter publishes the `cli` capability, as `bin/<name>.mjs` beside
 * an optional `bin/<name>-flight.mjs` react-server worker. The bin is a
 * plain self-contained ESM module invoked as `node <root>/bin/<name>.mjs`,
 * exactly like the artifact's `scripts/*.mjs`, so hooks, skills, and script
 * routes installed with the plugin can reach the routed CLI without a
 * separate npm install. The package build's own bin emission is untouched.
 */

/** The one directory the compiler emits the routed CLI into; the registry pins every `cliBin` layout to it. */
export const cliBinDirectory: string = routedCliBinLayout.directory;

/** The artifact-relative executable path for one routed-CLI bin. */
export const cliBinArtifactPath = (name: string): string => `${cliBinDirectory}/${name}.mjs`;

/** The artifact-relative react-server worker path beside a rendered routed-CLI bin. */
export const cliBinWorkerArtifactPath = (name: string): string => `${cliBinDirectory}/${name}-flight.mjs`;

/** The framework-generated routed-CLI bins of a project (never hand-written `bin` entries). */
export const routedCliBins = (model: NormalizedPlugin): readonly NormalizedBinEntry[] =>
  Object.freeze((model.packageBuild?.bins ?? []).filter((bin) => bin.generatedCli !== undefined));

/**
 * True when the target's adapter admits the routed CLI bin into its artifact —
 * by the component judgment (`componentCapabilities ?? capabilities`), so
 * emission and `inspect` accounting can never disagree.
 */
export const targetHostsCliBin = (registry: TargetRegistry, target: string): boolean =>
  registry.hostsComponent(target, cliBinCapability);

export interface CompiledCliBin extends CompiledEntry {
  readonly id: string;
  readonly target: string;
}

interface PlannedCliBin extends CompiledCliBin {
  readonly bin: NormalizedBinEntry;
  readonly rendered: boolean;
}

const generatedCli = (bin: NormalizedBinEntry): NonNullable<NormalizedBinEntry['generatedCli']> => {
  if (bin.generatedCli === undefined) {
    throw new Error(`Bin ${JSON.stringify(bin.name)} is not a framework-generated routed CLI.`);
  }
  return bin.generatedCli;
};

export const planCompiledCliBins = (
  model: NormalizedPlugin,
  options: { readonly outDir: string; readonly target: string },
): readonly PlannedCliBin[] => {
  const binRoot = resolve(options.outDir, cliBinDirectory);
  return Object.freeze(routedCliBins(model).map((bin): PlannedCliBin => {
    const cli = generatedCli(bin);
    const rendered = cli.commands.some((command) => command.rendered);
    const sourceInputs = Object.freeze([...new Set([
      bin.provenance.sourcePath,
      ...cli.routes.map((route) => route.source),
      ...(model.layouts ?? []).map((layout) => layout.source),
      ...(model.providers ?? []).map((provider) => provider.source),
      ...(model.state === undefined ? [] : [model.state.source]),
    ])]);
    return Object.freeze({
      bin,
      id: bin.id,
      name: bin.name,
      output: resolveArtifactDestination(binRoot, `${bin.name}.mjs`),
      outputKind: 'bundle' as const,
      rendered,
      source: bin.source,
      sourceInputs,
      target: options.target,
      ...(rendered
        ? {
          workerOutput: resolveArtifactDestination(binRoot, `${bin.name}-flight.mjs`),
          workerSourceInputs: sourceInputs,
        }
        : {}),
    });
  }));
};

/**
 * The Rslib entries one target's routed-CLI bins compile into. Shared with
 * `inspect --bundler` so the dump cannot drift from what the build lowers.
 */
export const cliBinRslibEntries = (
  planned: readonly PlannedCliBin[],
  model: NormalizedPlugin,
): readonly RslibEntry[] => planned.flatMap((entry) => {
  const cli = generatedCli(entry.bin);
  const workerFile = `${entry.name}-flight.mjs`;
  const entries: RslibEntry[] = [{
    aliases: { [cliEntryRuntimeSpecifier]: cliEntryRuntimePath() },
    name: `bin-${entry.name}`,
    outputRelativePath: cliBinArtifactPath(entry.name),
    ...(entry.rendered ? { rscManifest: true as const } : {}),
    source: entry.source,
    sourceInputs: entry.sourceInputs,
    virtualSource: generatedCliBinEntrySource({
      commands: cli.commands,
      plugin: {
        ...(model.metadata.description === undefined ? {} : { description: model.metadata.description }),
        name: model.metadata.name,
        version: model.metadata.version,
      },
      ...(model.notices === undefined ? {} : { noticeRetention: model.notices.retention.resolved }),
      providers: model.providers ?? [],
      routes: cli.routes,
      ...(model.state === undefined ? {} : { state: model.state }),
      // Durable state anchors on the artifact root (the parent of `bin/`),
      // the same fallback the generated MCP worker beside it uses, so a
      // co-installed CLI and server observe one store.
      stateFallback: 'artifact',
      ...(entry.rendered ? { workerFile } : {}),
    }),
  }];
  if (entry.rendered) {
    const renderedRoutes = cli.routes.filter((route) =>
      cli.commands.some((command) => command.rendered && command.routeId === route.id));
    entries.push({
      name: `bin-${entry.name}-flight`,
      outputRelativePath: cliBinWorkerArtifactPath(entry.name),
      reactServer: true,
      rscManifest: true,
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: generatedRenderedRouteWorkerSource({
        layouts: model.layouts ?? [],
        ...(model.notices === undefined ? {} : { noticeRetention: model.notices.retention.resolved }),
        providers: model.providers ?? [],
        routes: renderedRoutes,
        ...(model.state === undefined ? {} : { state: model.state }),
        stateFallback: 'artifact',
      }),
    });
  }
  return entries;
});

export const compileCliBins = async (
  model: NormalizedPlugin,
  options: {
    readonly cwd: string;
    readonly meta: AgentBundleMeta;
    readonly outDir: string;
    readonly target: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): Promise<readonly CompiledCliBin[]> => {
  const planned = planCompiledCliBins(model, options);
  if (planned.length === 0) return Object.freeze([]);
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: cliBinRslibEntries(planned, model),
    ignoredSourcePaths: [runtimeIgnoredRoot(cliEntryRuntimePath())],
    logLevel: 'error',
    meta: options.meta,
    outputRoot: options.outDir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  const bundledInputs = (path: string, label: string): readonly string[] => {
    const inputs = evidenceByPath.get(path);
    if (inputs === undefined) throw new Error(`Missing bundled routed CLI ${label} evidence for ${JSON.stringify(path)}.`);
    return inputs;
  };
  return Object.freeze(planned.map((entry): CompiledCliBin => Object.freeze({
    id: entry.id,
    name: entry.name,
    output: entry.output,
    outputKind: entry.outputKind,
    source: entry.source,
    sourceInputs: bundledInputs(cliBinArtifactPath(entry.name), 'executable'),
    target: entry.target,
    ...(entry.workerOutput === undefined
      ? {}
      : {
        workerOutput: entry.workerOutput,
        workerSourceInputs: bundledInputs(cliBinWorkerArtifactPath(entry.name), 'worker'),
      }),
  })));
};

/**
 * AB4766: the routed CLI bin's artifact paths are framework-owned. A target
 * plan that already places a file there (for example a Claude `claude.bin`
 * directory shipping `<plugin-name>.mjs`) cannot be merged silently, so the
 * build refuses with the colliding paths named. Paths are compared
 * case-folded: on the case-insensitive filesystems most plugins are developed
 * and installed on, `bin/MyPlugin.mjs` and `bin/myplugin.mjs` are one file,
 * and a name that differs only by case is a hazard everywhere else.
 */
export const cliBinCollisionDiagnostics = (
  model: NormalizedPlugin,
  target: string,
  entries: readonly TargetArtifactEntry[],
): readonly Diagnostic[] => {
  const planned = new Map<string, string>();
  for (const entry of entries) {
    const folded = entry.relativePath.toLowerCase();
    if (!planned.has(folded)) planned.set(folded, entry.relativePath);
  }
  return Object.freeze(routedCliBins(model).flatMap((bin) => {
    const rendered = generatedCli(bin).commands.some((command) => command.rendered);
    return [cliBinArtifactPath(bin.name), ...(rendered ? [cliBinWorkerArtifactPath(bin.name)] : [])]
      .flatMap((owned) => {
        const emitted = planned.get(owned.toLowerCase());
        return emitted === undefined ? [] : [{ emitted, owned }];
      })
      .map(({ emitted, owned }): Diagnostic => ({
        code: 'AB4766',
        message: emitted === owned
          ? `Target ${JSON.stringify(target)} already emits ${JSON.stringify(emitted)}, which the routed CLI bin ${JSON.stringify(bin.name)} owns; the compiler never chooses silently.`
          : `Target ${JSON.stringify(target)} already emits ${JSON.stringify(emitted)}, which differs only by case from ${JSON.stringify(owned)} owned by the routed CLI bin ${JSON.stringify(bin.name)}; on a case-insensitive filesystem they are one file, so the compiler never chooses silently.`,
        recovery: `Rename or remove the host-emitted ${JSON.stringify(emitted)} (for example the file in the configured claude.bin directory), or set bin: false to keep the host file and drop the routed CLI executable.`,
        severity: 'error',
        sourcePath: bin.provenance.sourcePath,
        target,
      }));
  }));
};
