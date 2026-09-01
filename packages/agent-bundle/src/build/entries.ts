import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  eventArtifactEpochToken,
  eventIpcRuntimeSpecifier,
  eventProjectRuntimeSpecifier,
  type TargetHookEntry,
} from '../adapters/hook-contract.ts';
import type { AgentBundleToolsConfig, NormalizedHook, NormalizedMcpServer, NormalizedScript } from '../core/types.ts';
import { mcpEntryAliasPattern } from '../config/normalize.ts';
import { stableJson } from '../core/digest.ts';
import { emitPlanEntries, resolveArtifactDestination } from './emit.ts';
import { scanEntryExports } from './entry-exports.ts';
import {
  generatedExecutableEntrySource,
  generatedRouteArtifactEpoch,
  generatedRouteFlightWorkerSource,
  generatedRouteMcpEntrySource,
  generatedStdioMcpEntrySource,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
} from './entry-shell.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';
import type { ArtifactOutputKind } from './provenance.ts';
import { buildWithRslib } from './rslib.ts';

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
const runtimeIgnoredRoot = (path: string): string => {
  const normalized = path.replaceAll('\\', '/');
  const marker = normalized.includes('/dist/') ? '/dist/' : '/src/';
  return resolve(normalized.slice(0, normalized.lastIndexOf(marker)));
};

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly outputKind: ArtifactOutputKind;
  readonly source: string;
  readonly sourceInputs: readonly string[];
}

interface PlannedScriptEntry extends CompiledEntry {
  readonly mode: NormalizedScript['mode'];
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
  const names = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const filename = outputName(script);
    if (script.name.length === 0 || names.has(filename)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${filename}`)}.`);
    }
    names.add(filename);
    return {
      mode: script.mode,
      name: script.name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        filename,
      ),
      outputKind: script.mode === 'copy' ? 'copy' as const : 'bundle' as const,
      source: script.source,
      sourceInputs: Object.freeze([...new Set([script.provenance.sourcePath, script.source])]),
    };
  }).map((entry) => Object.freeze(entry)));
};

export const compileEntries = async (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string; readonly tools?: AgentBundleToolsConfig },
): Promise<readonly CompiledEntry[]> => {
  const compiled = planCompiledEntries(entries, options);
  const bundled = compiled.filter((entry) => entry.mode === 'bundle');
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: await Promise.all(bundled.map(async ({ name, source, sourceInputs }) => {
      // A Script whose module exports `main` receives the framework process
      // envelope (argv, numeric exit codes); self-executing modules keep
      // today's direct-bundle behavior byte for byte.
      const exports = await scanEntryExports(source);
      return {
        name,
        outputRelativePath: `scripts/${name}.mjs`,
        source,
        sourceInputs,
        ...(exports.hasMainExport
          ? { virtualSource: generatedExecutableEntrySource({ entrySource: source, exportName: 'main' }) }
          : {}),
      };
    })),
    outputRoot: options.outDir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
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
  })));
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

export const compileMcpEntries = async (
  servers: readonly NormalizedMcpServer[],
  options: {
    readonly apps?: readonly CompiledMcpApp[];
    readonly artifactEpoch: string;
    readonly cwd: string;
    readonly eventHooks: readonly NormalizedHook[];
    readonly outDir: string;
    readonly plugin: { readonly name: string; readonly version: string };
    readonly target: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): Promise<readonly CompiledMcpEntry[]> => {
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
        plugin: options.plugin,
        routes: server.generatedRoutes,
        serverName: server.name,
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
        routes: server.generatedRoutes,
        serverName: server.name,
      });
  });
  // Factory-exporting entries (default export) are wrapped in the framework
  // stdio lifecycle shell; self-connecting entries keep today's behavior byte
  // for byte. The shell is aliased onto the local runtime module so emitted
  // bundles stay self-contained (no residual `agent-bundle` import).
  const entryShells = await Promise.all(compiled.map(async (entry, index) => {
    if (generatedRouteSources[index] !== undefined) {
      return generatedStdioMcpEntrySource({
        entrySource: routeModuleSpecifier,
        serverName: entry.id.startsWith('mcp:') ? entry.id.slice('mcp:'.length) : entry.name,
      });
    }
    return (await scanEntryExports(entry.source)).hasDefaultExport
      ? generatedStdioMcpEntrySource({
        entrySource: entry.source,
        serverName: entry.id.startsWith('mcp:') ? entry.id.slice('mcp:'.length) : entry.name,
      })
      : undefined;
  }));
  const runtimeShell = entryShells.some((shell) => shell !== undefined) ? mcpEntryRuntimePath() : undefined;
  const eventIpcRuntime = options.eventHooks.length === 0 ? undefined : eventRuntimeModulePath('ipc');
  const eventProjectRuntime = options.eventHooks.length === 0 ? undefined : eventRuntimeModulePath('project');
  const serverRuntime = generatedRouteSources.some((routeSource) => routeSource !== undefined)
    ? mcpServerRuntimePath()
    : undefined;
  const mainEntries = compiled.map(({ id, name, source, sourceInputs }, index) => ({
    ...(entryShells[index] === undefined || runtimeShell === undefined
      ? {}
      : {
        aliases: {
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
        },
        virtualSource: entryShells[index],
      }),
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
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: [...mainEntries, ...workerEntries],
    ...([runtimeShell, eventIpcRuntime, serverRuntime].filter((path): path is string => path !== undefined).length === 0
      ? {}
      : {
        ignoredSourcePaths: [
          ...(runtimeShell === undefined ? [] : [runtimeShell]),
          ...(eventIpcRuntime === undefined ? [] : [runtimeIgnoredRoot(eventIpcRuntime)]),
          ...(serverRuntime === undefined ? [] : [runtimeIgnoredRoot(serverRuntime)]),
        ],
      }),
    logLevel: 'error',
    outputRoot: options.outDir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(`mcp/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled MCP evidence for ${JSON.stringify(entry.name)}.`); })(),
    ...(entry.workerOutput === undefined ? {} : {
      workerSourceInputs: evidenceByPath.get(`mcp/${entry.name}-flight.mjs`) ?? (() => { throw new Error(`Missing bundled MCP Flight worker evidence for ${JSON.stringify(entry.name)}.`); })(),
    }),
  })));
};

export const planCompiledHooks = (
  entries: readonly TargetHookEntry[],
  options: { readonly outDir: string },
): readonly CompiledHookEntry[] => Object.freeze(entries.map((entry) => Object.freeze({
  event: entry.event,
  id: entry.hook.id,
  ...(entry.indexed === false ? { indexed: false as const } : {}),
  name: entry.hook.name,
  output: resolveArtifactDestination(options.outDir, entry.relativePath),
  outputKind: 'bundle',
  source: entry.hook.source,
  sourceInputs: Object.freeze([entry.hook.provenance.sourcePath, entry.hook.source]),
  target: entry.target,
  ...(entry.hook.timeout === undefined ? {} : { timeout: entry.hook.timeout }),
})));

export const compileHooks = async (
  entries: readonly TargetHookEntry[],
  options: {
    readonly artifactEpoch: string;
    readonly cwd: string;
    readonly outDir: string;
    readonly tools?: AgentBundleToolsConfig;
  },
): Promise<readonly CompiledHookEntry[]> => {
  const compiled = planCompiledHooks(entries, options);
  const routeEntries = entries.filter((entry) => entry.hook.eventRoute !== undefined);
  const eventIpcRuntime = routeEntries.length === 0 ? undefined : eventRuntimeModulePath('ipc');
  const eventProjectRuntime = routeEntries.some((entry) =>
    entry.hook.eventRoute?.runtime === 'standalone' || entry.hook.eventRoute?.fallback === 'standalone')
    ? eventRuntimeModulePath('project')
    : undefined;
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map((entry, index) => ({
      // One hook can compile into several host wrappers (for example a shared
      // Claude/Codex wrapper plus a Cursor-codec wrapper), so the bundler
      // library id derives from the unique output path, not the hook name.
      name: entries[index]!.relativePath.replaceAll('/', '-').replace(/\.mjs$/u, ''),
      outputRelativePath: entries[index]!.relativePath,
      ...(entries[index]!.hook.eventRoute === undefined || eventIpcRuntime === undefined
        ? {}
        : {
          aliases: {
            [eventIpcRuntimeSpecifier]: eventIpcRuntime,
            ...(eventProjectRuntime === undefined ? {} : { [eventProjectRuntimeSpecifier]: eventProjectRuntime }),
          },
        }),
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: entries[index]!.virtualSource.replaceAll(eventArtifactEpochToken, options.artifactEpoch),
    })),
    ...(eventIpcRuntime === undefined
      ? {}
      : {
        ignoredSourcePaths: [runtimeIgnoredRoot(eventIpcRuntime)],
      }),
    outputRoot: options.outDir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry, index) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(entries[index]!.relativePath) ?? (() => { throw new Error(`Missing bundled hook evidence for ${JSON.stringify(entry.name)}.`); })(),
  })));
};
