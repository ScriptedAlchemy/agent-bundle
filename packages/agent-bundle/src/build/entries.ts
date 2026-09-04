import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NoticeDeliveryAdvertisement } from '../adapters/notice-delivery.ts';
import {
  eventArtifactEpochToken,
  eventFlightArtifactEpochToken,
  eventIpcRuntimeSpecifier,
  eventProjectRuntimeSpecifier,
  hookWrapperAppliesOperatorEnv,
  type TargetHookEntry,
} from '../adapters/hook-contract.ts';
import type {
  NormalizedHook,
  NormalizedMcpServer,
  NormalizedNoticeRetentionPolicy,
  NormalizedScript,
  NormalizedStateDefinition,
} from '../core/types.ts';
import { mcpEntryAliasPattern } from '../config/normalize.ts';
import { stableJson } from '../core/digest.ts';
import { emitPlanEntries, resolveArtifactDestination } from './emit.ts';
import { scanEntryExports } from './entry-exports.ts';
import { deepFreeze } from '../core/freeze.ts';
import { launchEnvRuntimeSpecifier, operatorEnvLayerVirtualModule } from './launch-env-shell.ts';
import {
  cliEntryRuntimePath,
  launchEnvRuntimePath,
  cliEntryRuntimeSpecifier,
  generatedExecutableEntrySource,
  generatedRenderedRouteWorkerSource,
  generatedRenderedScriptEntrySource,
  terminalCapabilityRuntimePath,
  terminalCapabilityRuntimeSpecifier,
  generatedRouteArtifactEpoch,
  generatedRouteFlightWorkerSource,
  generatedRouteMcpEntrySource,
  generatedStdioMcpEntrySource,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
} from './entry-shell.ts';
import { emptyRouteConfig, type CompiledLayout, type CompiledProvider } from '../routes/types.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';
import type { ArtifactOutputKind } from './provenance.ts';
import type { RslibEntry, RslibSurfacePlan } from './rslib.ts';

const eventRuntimeModulePath = (module: 'ipc' | 'project'): string => {
  for (const candidate of [
    new URL(`./event-${module}.js`, import.meta.url),
    new URL(`../../dist/event-${module}.js`, import.meta.url),
    new URL(`../events/${module}.ts`, import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`Unable to locate the compiler-owned event ${module} runtime module.`);
};

/**
 * The package root owning one compiler-provided runtime module. Provenance
 * collects consumer sources, and a runtime module reaches its own siblings
 * (`routes/public.ts`, `core/*`) as it is inlined, so the whole owning package
 * is what has to be ignored rather than the single aliased file.
 */
export const runtimeIgnoredRoot = (path: string): string => {
  const normalized = path.replaceAll('\\', '/');
  let directory = dirname(normalized);
  while (true) {
    if (basename(directory) === 'dist' || basename(directory) === 'src') {
      return resolve(dirname(directory));
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Runtime module is not under an owning package src or dist directory: ${JSON.stringify(path)}.`);
    }
    directory = parent;
  }
};

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly outputKind: ArtifactOutputKind;
  readonly source: string;
  readonly sourceInputs: readonly string[];
  /** The sibling react-server Flight worker of a rendered script (#102 stage 3). */
  readonly workerOutput?: string;
  readonly workerSourceInputs?: readonly string[];
}

interface PlannedScriptEntry extends CompiledEntry {
  readonly mode: NormalizedScript['mode'];
  /** The conventional rendered-script route this entry renders (#102 stage 3). */
  readonly rendered?: {
    readonly routeId: string;
    readonly workerFile: string;
  };
}

export interface CompiledHookEntry extends CompiledEntry {
  readonly event: TargetHookEntry['event'];
  readonly id: string;
  /** False when this wrapper is a host-document variant excluded from the canonical hook index. */
  readonly indexed?: false;
  readonly target: string;
  /** Native hook timeout in seconds. Omit it to use the host default. */
  readonly timeout?: number;
}

export interface CompiledMcpEntry extends CompiledEntry {
  readonly id: string;
  readonly workerOutput?: string;
  readonly workerSourceInputs?: readonly string[];
  readonly target: string;
}

const outputName = (script: NormalizedScript): string =>
  script.mode === 'bundle' ? `${script.name}.mjs` : `${script.name}${extname(script.source).toLowerCase()}`;

export const planCompiledEntries = (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): readonly PlannedScriptEntry[] => {
  const destinations = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const filename = outputName(script);
    if (script.name.length === 0 || destinations.has(filename)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${filename}`)}.`);
    }
    destinations.add(filename);
    const workerFile = `${script.name}-flight.mjs`;
    if (script.rendered === true) {
      if (destinations.has(workerFile)) {
        throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${workerFile}`)}.`);
      }
      destinations.add(workerFile);
    }
    return {
      mode: script.mode,
      name: script.name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        filename,
      ),
      outputKind: script.mode === 'copy' ? 'copy' as const : 'bundle' as const,
      ...(script.rendered === true
        ? {
          rendered: { routeId: script.id, workerFile },
          workerOutput: resolveArtifactDestination(resolve(options.outDir, 'scripts'), workerFile),
        }
        : {}),
      source: script.source,
      sourceInputs: Object.freeze([...new Set([script.provenance.sourcePath, script.source])]),
    };
  }).map((entry) => Object.freeze(entry)));
};

/**
 * Plans the artifact scripts of one target as a surface of the target's
 * shared Rslib run: bundled scripts (with the react-server Flight worker
 * beside each rendered one) compile there; copied scripts are emitted when
 * the surface finishes.
 */
export const planScriptsSurface = async (
  entries: readonly NormalizedScript[],
  options: {
    readonly cwd: string;
    readonly layouts?: readonly CompiledLayout[];
    readonly outDir: string;
    readonly providers?: readonly CompiledProvider[];
    readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
    readonly state?: NormalizedStateDefinition;
  },
): Promise<RslibSurfacePlan<readonly CompiledEntry[]>> => {
  const compiled = planCompiledEntries(entries, options);
  const bundled = compiled.filter((entry) => entry.mode === 'bundle');
  const cliRuntimeShell = bundled.some((entry) => entry.rendered !== undefined)
    ? cliEntryRuntimePath()
    : undefined;
  // The builder decides the envelope statically, before any module runs.
  const mainExports = new Map(await Promise.all(bundled
    .filter((entry) => entry.rendered === undefined)
    .map(async (entry) => [entry.source, (await scanEntryExports(entry.source)).hasMainExport] as const)));
  const terminalProbe = [...mainExports.values()].some(Boolean) ? terminalCapabilityRuntimePath() : undefined;
  // Every compiler-owned runtime module lives in this package, so one ignored
  // root covers the cli-entry shell and the terminal probe alike.
  const ignoredRuntime = cliRuntimeShell ?? terminalProbe;
  return {
    entries: await Promise.all(bundled.flatMap((entry): readonly Promise<RslibEntry>[] => {
      const { name, rendered, source, sourceInputs } = entry;
      if (rendered !== undefined) {
        const workerSourceInputs = Object.freeze([...new Set([
          ...sourceInputs,
          ...(options.providers ?? []).map((provider) => provider.source),
          ...(options.layouts ?? []).map((layout) => layout.source),
        ])]);
        // A rendered script route (#102 stage 3): the entry projects the
        // dispatcher's render-event stream onto the CLI output contract and
        // a sibling react-server worker executes the component.
        return [
          Promise.resolve({
            aliases: { [cliEntryRuntimeSpecifier]: cliRuntimeShell! },
            name,
            outputRelativePath: `scripts/${name}.mjs`,
            rscManifest: true as const,
            source,
            sourceInputs,
            virtualSource: generatedRenderedScriptEntrySource({
              name,
              routeId: rendered.routeId,
              ...(options.noticeRetention === undefined ? {} : { noticeRetention: options.noticeRetention }),
        ...(options.state === undefined ? {} : { state: options.state }),
              workerFile: rendered.workerFile,
            }),
          }),
          Promise.resolve({
            name: `${name}-flight`,
            outputRelativePath: `scripts/${rendered.workerFile}`,
            reactServer: true as const,
            rscManifest: true as const,
            source,
            sourceInputs: workerSourceInputs,
            virtualSource: generatedRenderedRouteWorkerSource({
              ...(options.layouts === undefined ? {} : { layouts: options.layouts }),
              ...(options.providers === undefined ? {} : { providers: options.providers }),
              routes: [{
                config: emptyRouteConfig,
                id: rendered.routeId,
                kind: 'script',
                provenance: { kind: 'conventional', relativePath: `scripts/${name}` },
                source,
              }],
              ...(options.noticeRetention === undefined ? {} : { noticeRetention: options.noticeRetention }),
        ...(options.state === undefined ? {} : { state: options.state }),
            }),
          }),
        ];
      }
      // A Script whose module exports `main` receives the framework process
      // envelope (argv, the terminal capability, numeric exit codes);
      // self-executing modules keep today's direct-bundle behavior byte for
      // byte.
      return [Promise.resolve({
        name,
        outputRelativePath: `scripts/${name}.mjs`,
        source,
        sourceInputs,
        ...(mainExports.get(source) === true
          ? {
            aliases: { [terminalCapabilityRuntimeSpecifier]: terminalProbe! },
            virtualSource: generatedExecutableEntrySource({ entrySource: source, exportName: 'main', hostSurface: 'script' }),
          }
          : {}),
      })];
    })),
    ...(ignoredRuntime === undefined ? {} : { ignoredSourcePaths: [runtimeIgnoredRoot(ignoredRuntime)] }),
    finish: async (evidence) => {
      await emitPlanEntries({
        entries: await Promise.all(compiled
          .filter((entry) => entry.mode === 'copy')
          .map(async (entry) => ({
            bytes: (await stat(entry.source)).size,
            kind: 'copy' as const,
            relativePath: relative(options.outDir, entry.output).replaceAll('\\', '/'),
            source: entry.source,
            sourceInputs: entry.sourceInputs,
          }))),
        root: options.outDir,
      });

      const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
      return Object.freeze(compiled.map((entry) => Object.freeze({
        ...entry,
        sourceInputs: entry.mode === 'bundle'
          ? evidenceByPath.get(`scripts/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled script evidence for ${JSON.stringify(entry.name)}.`); })()
          : entry.sourceInputs,
        ...(entry.rendered === undefined ? {} : {
          workerSourceInputs: evidenceByPath.get(`scripts/${entry.rendered.workerFile}`) ?? (() => { throw new Error(`Missing bundled script worker evidence for ${JSON.stringify(entry.name)}.`); })(),
        }),
      })));
    },
  };
};

const localMcpOutputName = (server: NormalizedMcpServer): string => {
  const output = server.args?.[0];
  const match = typeof output === 'string'
    ? mcpEntryAliasPattern.exec(output)
    : undefined;
  if (server.source === undefined || match?.[1] === undefined) {
    throw new Error(`MCP server ${JSON.stringify(server.name)} has an unsafe local output alias.`);
  }
  return match[1];
};

export const planCompiledMcpEntries = (
  servers: readonly NormalizedMcpServer[],
  options: { readonly outDir: string; readonly target: string },
): readonly CompiledMcpEntry[] => {
  const names = new Set<string>();
  return Object.freeze(servers
    .filter((server) => server.source !== undefined && server.targets.includes(options.target))
    .map((server) => {
      const outputName = localMcpOutputName(server);
      const name = outputName.slice(0, -extname(outputName).length);
      if (names.has(name)) {
        throw new Error(`Duplicate compiled MCP destination ${JSON.stringify(`mcp/${outputName}`)}.`);
      }
      names.add(name);
      const sourceInputs = Object.freeze([...new Set([
        server.provenance.sourcePath,
        server.source!,
        ...(server.generatedRoutes ?? []).map((route) => route.source),
      ])]);
      return Object.freeze({
        id: server.id,
        name,
        output: resolveArtifactDestination(resolve(options.outDir, 'mcp'), outputName),
        outputKind: 'bundle',
        source: server.source!,
        sourceInputs,
        target: options.target,
        ...(server.generatedRoutes === undefined ? {} : {
          workerOutput: resolveArtifactDestination(resolve(options.outDir, 'mcp'), `${name}-flight.mjs`),
          workerSourceInputs: sourceInputs,
        }),
      });
    }));
};

/**
 * Plans the local MCP servers of one target as a surface of the target's
 * shared Rslib run: each stdio entry plus the react-server Flight worker of
 * each route-generated server. The compiled MCP App HTML is read here, so
 * the target's browser stage must have finished before this plan is made.
 */
export const planMcpEntriesSurface = async (
  servers: readonly NormalizedMcpServer[],
  options: {
    readonly apps?: readonly CompiledMcpApp[];
    readonly artifactEpoch: string;
    readonly eventHooks: readonly NormalizedHook[];
    readonly layouts?: readonly CompiledLayout[];
    /** The target adapter's notice delivery advertisement; absent wires no cross-request route. */
    readonly noticeDelivery?: NoticeDeliveryAdvertisement;
    readonly outDir: string;
    readonly plugin: { readonly name: string; readonly version: string };
    readonly providers?: readonly CompiledProvider[];
    readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
    readonly state?: NormalizedStateDefinition;
    readonly target: string;
  },
): Promise<RslibSurfacePlan<readonly CompiledMcpEntry[]>> => {
  const compiled = planCompiledMcpEntries(servers, options);
  const eventHostId = compiled.find((entry) =>
    servers.find((server) => server.id === entry.id)?.generatedRoutes !== undefined)?.id;
  const virtualSources = await Promise.all(compiled.map(async (entry) => {
    const records = await Promise.all((options.apps ?? [])
      .filter((app) => app.serverIds.includes(entry.id))
      .map(async (app) => ({
        ...(app._meta === undefined ? {} : { _meta: app._meta }),
        html: await readFile(app.output, 'utf8'),
        mimeType: app.mimeType,
        name: app.name,
        resourceUri: app.resourceUri,
      })));
    return [
      `const mcpApps = Object.freeze(${stableJson(records)});`,
      'export { mcpApps };',
      'export default mcpApps;',
      '',
    ].join('\n');
  }));
  const routeModuleSpecifier = 'agent-bundle/generated-route-server';
  const generatedRouteSources = compiled.map((entry) => {
    const server = servers.find((candidate) => candidate.id === entry.id);
    return server?.generatedRoutes === undefined
      ? undefined
      : generatedRouteMcpEntrySource({
        artifactEpoch: options.artifactEpoch,
        eventRoutes: entry.id === eventHostId ? options.eventHooks : [],
        ...(options.noticeDelivery === undefined ? {} : { noticeDelivery: options.noticeDelivery }),
        plugin: options.plugin,
        routes: server.generatedRoutes,
        serverName: server.name,
        ...(options.noticeRetention === undefined ? {} : { noticeRetention: options.noticeRetention }),
        ...(options.state === undefined ? {} : { state: options.state }),
        target: options.target,
        workerFile: `${entry.name}-flight.mjs`,
      });
  });
  const generatedWorkerSources = compiled.map((entry) => {
    const server = servers.find((candidate) => candidate.id === entry.id);
    return server?.generatedRoutes === undefined
      ? undefined
      : generatedRouteFlightWorkerSource({
        artifactEpoch: generatedRouteArtifactEpoch(options.plugin),
        eventRoutes: entry.id === eventHostId ? options.eventHooks : [],
        layouts: options.layouts ?? [],
        ...(options.noticeDelivery === undefined ? {} : { noticeDelivery: options.noticeDelivery }),
        providers: options.providers ?? [],
        routes: server.generatedRoutes,
        serverName: server.name,
        ...(options.noticeRetention === undefined ? {} : { noticeRetention: options.noticeRetention }),
        ...(options.state === undefined ? {} : { state: options.state }),
      });
  });
  // Factory-exporting entries (default export) are wrapped in the framework
  // stdio lifecycle shell; self-connecting entries keep today's behavior byte
  // for byte. The shell is aliased onto the local runtime module so emitted
  // bundles stay self-contained (no residual `agent-bundle` import).
  const entryShells = await Promise.all(compiled.map(async (entry, index) => {
    const serverName = entry.id.startsWith('mcp:') ? entry.id.slice('mcp:'.length) : entry.name;
    if (generatedRouteSources[index] !== undefined) {
      return generatedStdioMcpEntrySource({ entrySource: routeModuleSpecifier, serverName });
    }
    return (await scanEntryExports(entry.source)).hasDefaultExport
      ? generatedStdioMcpEntrySource({ entrySource: entry.source, serverName })
      : undefined;
  }));
  const runtimeShell = entryShells.some((shell) => shell !== undefined) ? mcpEntryRuntimePath() : undefined;
  // The operator `.env` layer (#469) is public API for every stdio entry: the
  // lifecycle shell applies it before the deferred server import, and a
  // self-connecting entry — which has no shell — imports
  // `agent-bundle/launch-env` and calls `applyOperatorEnv` itself. The alias
  // is unconditional so that import resolves to this package's plain-Node
  // module and can never be externalized; the bundler inlines it only where
  // an import reaches it, so an entry that never imports it is unchanged.
  const launchEnvRuntime = launchEnvRuntimePath();
  const eventIpcRuntime = options.eventHooks.length === 0 ? undefined : eventRuntimeModulePath('ipc');
  const eventProjectRuntime = options.eventHooks.length === 0 ? undefined : eventRuntimeModulePath('project');
  const serverRuntime = generatedRouteSources.some((routeSource) => routeSource !== undefined)
    ? mcpServerRuntimePath()
    : undefined;
  const mainEntries = compiled.map(({ id, name, source, sourceInputs }, index) => ({
    aliases: {
      [launchEnvRuntimeSpecifier]: launchEnvRuntime,
      ...(entryShells[index] === undefined || runtimeShell === undefined
        ? {}
        : {
          [mcpEntryRuntimeSpecifier]: runtimeShell,
          ...(id !== eventHostId || eventIpcRuntime === undefined || eventProjectRuntime === undefined
            ? {}
            : {
              [eventIpcRuntimeSpecifier]: eventIpcRuntime,
              [eventProjectRuntimeSpecifier]: eventProjectRuntime,
            }),
          ...(generatedRouteSources[index] === undefined || serverRuntime === undefined
            ? {}
            : { [mcpServerRuntimeSpecifier]: serverRuntime }),
        }),
    },
    ...(entryShells[index] === undefined ? {} : { virtualSource: entryShells[index] }),
    name,
    outputRelativePath: `mcp/${name}.mjs`,
    ...(generatedRouteSources[index] === undefined ? {} : { rscManifest: true as const }),
    source,
    sourceInputs: Object.freeze([
      ...sourceInputs,
      ...(options.apps ?? [])
        .filter((app) => app.serverIds.includes(id))
        .flatMap((app) => app.sourceInputs),
    ]),
    virtualModules: [
      { name: 'agent-bundle/mcp-apps', source: virtualSources[index]! },
      ...(generatedRouteSources[index] === undefined ? [] : [{
        name: routeModuleSpecifier,
        source: generatedRouteSources[index],
      }]),
      // The shell's operator `.env` layer (#469) carries the server's manifest
      // `env` block, so the layer can tell a passed-through default from a
      // host export; a self-connecting entry has no shell and applies the
      // layer itself if it wants it.
      ...(entryShells[index] === undefined
        ? []
        : [operatorEnvLayerVirtualModule(servers.find((candidate) => candidate.id === id)?.env)]),
    ],
  }));
  const workerEntries = compiled.flatMap((entry, index) => {
    const workerSource = generatedWorkerSources[index];
    if (workerSource === undefined) return [];
    return [{
      name: `${entry.name}-flight`,
      outputRelativePath: `mcp/${entry.name}-flight.mjs`,
      reactServer: true as const,
      rscManifest: true as const,
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: workerSource,
    }];
  });
  return {
    entries: [...mainEntries, ...workerEntries],
    ignoredSourcePaths: [
      ...(runtimeShell === undefined ? [] : [runtimeShell]),
      // The package root, not the file: from the built package the
      // module shares chunks with its siblings under `dist/`.
      runtimeIgnoredRoot(launchEnvRuntime),
      ...(eventIpcRuntime === undefined ? [] : [runtimeIgnoredRoot(eventIpcRuntime)]),
      ...(serverRuntime === undefined ? [] : [runtimeIgnoredRoot(serverRuntime)]),
    ],
    finish: async (evidence) => {
      const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
      return Object.freeze(compiled.map((entry) => Object.freeze({
        ...entry,
        sourceInputs: evidenceByPath.get(`mcp/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled MCP evidence for ${JSON.stringify(entry.name)}.`); })(),
        ...(entry.workerOutput === undefined ? {} : {
          workerSourceInputs: evidenceByPath.get(`mcp/${entry.name}-flight.mjs`) ?? (() => { throw new Error(`Missing bundled MCP Flight worker evidence for ${JSON.stringify(entry.name)}.`); })(),
        }),
      })));
    },
    logLevel: 'error',
  };
};

export const planCompiledHooks = (
  entries: readonly TargetHookEntry[],
  options: { readonly outDir: string },
): readonly CompiledHookEntry[] => {
  const workerOwner = entries.findIndex((entry) =>
    entry.hook.eventRoute?.runtime === 'standalone' || entry.hook.eventRoute?.fallback === 'standalone');
  const workerSourceInputs = Object.freeze([...new Set(entries
    .filter((entry) =>
      entry.hook.eventRoute?.runtime === 'standalone' || entry.hook.eventRoute?.fallback === 'standalone')
    .flatMap((entry) => [entry.hook.provenance.sourcePath, entry.hook.source]))]);
  return deepFreeze(entries.map((entry, index) => ({
    event: entry.event,
    id: entry.hook.id,
    ...(entry.indexed === false ? { indexed: false as const } : {}),
    name: entry.hook.name,
    output: resolveArtifactDestination(options.outDir, entry.relativePath),
    outputKind: 'bundle',
    source: entry.hook.source,
    sourceInputs: Object.freeze([entry.hook.provenance.sourcePath, entry.hook.source]),
    target: entry.target,
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    ...(index === workerOwner
      ? {
        workerOutput: resolveArtifactDestination(resolve(options.outDir, 'hooks'), 'hooks-flight.mjs'),
        workerSourceInputs,
      }
      : {}),
  })));
};

/**
 * Plans the hook wrappers of one target as a surface of the target's shared
 * Rslib run, plus the one standalone react-server Flight worker the
 * event-routed hooks share.
 */
export const planHooksSurface = (
  entries: readonly TargetHookEntry[],
  options: {
    readonly artifactEpoch: string;
    readonly noticeDelivery?: NoticeDeliveryAdvertisement;
    readonly outDir: string;
    readonly plugin: { readonly name: string; readonly version: string };
    readonly providers?: readonly CompiledProvider[];
    readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
    readonly state?: NormalizedStateDefinition;
  },
): RslibSurfacePlan<readonly CompiledHookEntry[]> => {
  const compiled = planCompiledHooks(entries, options);
  const routeEntries = entries.filter((entry) => entry.hook.eventRoute !== undefined);
  const standaloneEventRoutes = [...new Map(routeEntries
    .filter((entry) =>
      entry.hook.eventRoute?.runtime === 'standalone' || entry.hook.eventRoute?.fallback === 'standalone')
    .map((entry) => [entry.hook.id, entry.hook])).values()];
  const workerArtifactEpoch = generatedRouteArtifactEpoch(options.plugin);
  const eventIpcRuntime = routeEntries.length === 0 ? undefined : eventRuntimeModulePath('ipc');
  const eventProjectRuntime = routeEntries.length === 0 ? undefined : eventRuntimeModulePath('project');
  const launchEnvRuntime = launchEnvRuntimePath();
  const workerEntry = standaloneEventRoutes.length === 0
    ? undefined
    : {
      name: 'hooks-flight',
      outputRelativePath: 'hooks/hooks-flight.mjs',
      reactServer: true as const,
      rscManifest: true as const,
      source: standaloneEventRoutes[0]!.source,
      sourceInputs: Object.freeze([
        ...new Set([
          ...standaloneEventRoutes.flatMap((hook) => [hook.provenance.sourcePath, hook.source]),
          ...(options.providers ?? []).map((provider) => provider.source),
          ...(options.state === undefined ? [] : [options.state.provenance.sourcePath, options.state.source]),
        ]),
      ]),
      virtualSource: generatedRouteFlightWorkerSource({
        artifactEpoch: workerArtifactEpoch,
        eventRoutes: standaloneEventRoutes,
        ...(options.noticeDelivery === undefined ? {} : { noticeDelivery: options.noticeDelivery }),
        providers: options.providers ?? [],
        routes: [],
        serverName: 'hooks',
        ...(options.noticeRetention === undefined ? {} : { noticeRetention: options.noticeRetention }),
        ...(options.state === undefined ? {} : { state: options.state }),
      }),
    };
  return {
    entries: [
      ...compiled.map((entry, index) => ({
      // One hook can compile into several host wrappers (for example a shared
      // Claude/Codex wrapper plus a Cursor-codec wrapper), so the bundler
      // library id derives from the unique output path, not the hook name.
      name: entries[index]!.relativePath.replaceAll('/', '-').replace(/\.mjs$/u, ''),
      outputRelativePath: entries[index]!.relativePath,
      ...(entries[index]!.hook.eventRoute?.runtime === 'standalone'
        || entries[index]!.hook.eventRoute?.fallback === 'standalone'
        ? { rscManifest: true as const }
        : {}),
      aliases: {
        // Every wrapper that runs plugin code applies the operator `.env` layer (#469).
        [launchEnvRuntimeSpecifier]: launchEnvRuntime,
        ...(entries[index]!.hook.eventRoute === undefined || eventIpcRuntime === undefined
          ? {}
          : {
            [eventIpcRuntimeSpecifier]: eventIpcRuntime,
            ...(eventProjectRuntime === undefined ? {} : { [eventProjectRuntimeSpecifier]: eventProjectRuntime }),
          }),
      },
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: entries[index]!.virtualSource
        .replaceAll(eventArtifactEpochToken, options.artifactEpoch)
        .replaceAll(eventFlightArtifactEpochToken, workerArtifactEpoch),
      // The layer module the wrapper imports first; a shared-runtime
      // event-route wrapper runs no plugin code and imports none.
      ...(hookWrapperAppliesOperatorEnv(entries[index]!) ? { virtualModules: [operatorEnvLayerVirtualModule()] } : {}),
      })),
      ...(workerEntry === undefined ? [] : [workerEntry]),
    ],
    ignoredSourcePaths: [
      runtimeIgnoredRoot(launchEnvRuntime),
      ...(eventIpcRuntime === undefined ? [] : [runtimeIgnoredRoot(eventIpcRuntime)]),
    ],
    finish: async (evidence) => {
      const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
      return Object.freeze(compiled.map((entry, index) => Object.freeze({
        ...entry,
        sourceInputs: evidenceByPath.get(entries[index]!.relativePath) ?? (() => { throw new Error(`Missing bundled hook evidence for ${JSON.stringify(entry.name)}.`); })(),
        ...(entry.workerOutput === undefined ? {} : {
          workerSourceInputs: evidenceByPath.get('hooks/hooks-flight.mjs') ?? (() => { throw new Error('Missing bundled hook Flight worker evidence.'); })(),
        }),
      })));
    },
  };
};
