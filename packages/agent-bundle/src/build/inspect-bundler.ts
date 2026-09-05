import { dirname, resolve } from 'node:path';

import {
  eventIpcRuntimeSpecifier,
  eventProjectRuntimeSpecifier,
  hookWrapperAppliesOperatorEnv,
} from '../adapters/hook-contract.ts';
import type { TargetHookEntry } from '../adapters/types.ts';
import { isPlainRecord } from '../core/strict-json.ts';
import type { AgentBundleToolsConfig, NormalizedPlugin } from '../core/types.ts';
import { scanEntryExports } from './entry-exports.ts';
import {
  generatedExecutableEntrySource,
  generatedRouteArtifactEpoch,
  generatedRouteFlightWorkerSource,
  generatedRouteMcpEntrySource,
  generatedStdioMcpEntrySource,
  launchEnvRuntimePath,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
  stdioPreludeVirtualModule,
  terminalCapabilityRuntimePath,
  terminalCapabilityRuntimeSpecifier,
} from './entry-shell.ts';
import { launchEnvRuntimeSpecifier, operatorEnvLayerVirtualModule } from './launch-env-shell.ts';
import { cliBinRslibEntries, planCompiledCliBins } from './cli-bins.ts';
import type { CompositePlan } from './compose.ts';
import { eventRuntimeHosting, eventRuntimeModulePath, planCompiledMcpEntries, selectedServerHosts } from './entries.ts';
import { inspectMcpAppsConfig, planCompiledMcpApps } from './mcp-apps.ts';
import { projectMeta } from './meta.ts';
import { planPackageEntries, synthesizeDtsTsconfig } from './package-build.ts';
import { inspectRslibEntries, type RslibEntry } from './rslib.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { AgentBundleMeta } from '../meta.ts';


/**
 * `agent-bundle inspect --bundler` (RFC #50 §3.4): surfaces the lowered
 * Rspack configuration of every output the build compiles — the framework
 * profile with the consumer `tools` escape hatch merged over it and the
 * invariant hook applied last, resolved by Rslib (executables) or Rsbuild
 * (MCP App views) into what the compiler receives. The lowering is the
 * build's own step (`inspectRslibEntries`, `inspectMcpAppsConfig`), run in
 * production mode whatever `NODE_ENV` says and stopped where the build would
 * start compiling, so the inspection can never drift from what actually
 * compiles; a hatch value the invariants refuse fails the inspection the
 * way it would fail the build.
 *
 * Two build-time-only values are replaced with stable tokens so the output
 * is deterministic for one project: the composite artifact root (chosen by
 * `build --output` and staged per build) appears as `<output>`, and the
 * synthesized declaration tsconfig (a temporary file the package build
 * generates under `node_modules`) appears as `<generated-dts-tsconfig>`.
 * Nothing else is redacted; this is a local debugging surface, and the
 * lowered configs carry absolute paths of the project and of agent-bundle's
 * installed toolchain. The generated-module namespace
 * (`<project root>/.agent-bundle-virtual/...`) appears exactly as the build
 * composes it: it derives from the project root, not from the output root.
 */

export interface BundlerInspectionEntry {
  /** The engine that lowered this entry: Rslib for executables, Rsbuild for MCP App views. */
  readonly bundler: 'rsbuild' | 'rslib';
  /**
   * The lowered Rspack configuration, JSON-rendered: functions appear as
   * `[function <name>]`, class instances (plugins) as `[object <constructor>]`,
   * regular expressions as `[regexp <source>]`.
   */
  readonly config: unknown;
  /** The generated wrapper entry module, when the framework provides one. */
  readonly generatedEntry?: string;
  readonly kind: 'bin' | 'hook' | 'lib' | 'mcp-app' | 'mcp-entry' | 'script';
  readonly name: string;
  /** POSIX output path relative to the artifact root (artifact surfaces) or project root (package build). */
  readonly outputPath: string;
  /** The authored entry module. */
  readonly source: string;
  /** The composite identity of the selected projections; absent for package-build entries. */
  readonly target?: string;
}

export interface BundlerInspection {
  readonly entries: readonly BundlerInspectionEntry[];
}

export const generatedDtsTsconfigToken = '<generated-dts-tsconfig>';

const artifactOutputToken = '<output>';

const isPlainObject: (value: object) => boolean = isPlainRecord;

type PathTokens = readonly (readonly [absolute: string, token: string])[];

const tokenizePath = (value: string, tokens: PathTokens): string => {
  for (const [absolute, token] of tokens) {
    if (value === absolute) return token;
    if (value.startsWith(`${absolute}/`)) return `${token}${value.slice(absolute.length)}`;
  }
  return value;
};

/**
 * Renders a lowered Rspack config as JSON-safe data without dropping the
 * shape: functions (function-form externals, hatch callbacks) become
 * `[function <name>]`, class instances (plugins, loaders' option objects)
 * become `[object <constructor>]`, regular expressions (module rules,
 * externals) become `[regexp <source>]`.
 */
const renderConfigValue = (value: unknown, tokens: PathTokens, ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return tokenizePath(value, tokens);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'function') return `[function ${value.name.length === 0 ? 'anonymous' : value.name}]`;
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[circular]';

  ancestors.add(value);
  try {
    if (value instanceof RegExp) return `[regexp ${String(value)}]`;
    if (Array.isArray(value)) {
      return value.map((item) => renderConfigValue(item, tokens, ancestors));
    }
    if (!isPlainObject(value)) {
      const constructor = value.constructor?.name;
      return `[object ${constructor === undefined || constructor.length === 0 ? 'anonymous' : constructor}]`;
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, renderConfigValue(item, tokens, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
};

/** One Rslib-compiled output the inspection lowers, before its config is known. */
interface PlannedRslibInspection {
  readonly entry: RslibEntry;
  readonly kind: Exclude<BundlerInspectionEntry['kind'], 'mcp-app'>;
  readonly name: string;
  readonly outputPath: string;
  readonly target?: string;
}

const scriptEntries = async (
  model: NormalizedPlugin,
  composite: CompositeSelection,
): Promise<readonly PlannedRslibInspection[]> => {
  const target = composite.identity;
  const scripts = model.scripts.filter((script) =>
    script.mode === 'bundle' && script.targets.some((candidate) => composite.selected.includes(candidate)));
  return Promise.all(scripts.map(async (script) => {
    const exports = await scanEntryExports(script.source);
    return {
      entry: {
        name: script.name,
        outputRelativePath: `scripts/${script.name}.mjs`,
        source: script.source,
        sourceInputs: [],
        ...(exports.hasMainExport
          ? {
            aliases: { [terminalCapabilityRuntimeSpecifier]: terminalCapabilityRuntimePath() },
            virtualSource: generatedExecutableEntrySource({
              entrySource: script.source,
              exportName: 'main',
              hostSurface: 'script',
            }),
          }
          : {}),
      },
      kind: 'script' as const,
      name: script.name,
      outputPath: `scripts/${script.name}.mjs`,
      target,
    };
  }));
};

/** The artifact-hosted routed CLI bins of the composite root (#387), composed by the build's own planner. */
const cliBinEntries = (model: NormalizedPlugin, outDir: string, target: string): readonly PlannedRslibInspection[] => {
  const planned = planCompiledCliBins(model, { outDir, target });
  return cliBinRslibEntries(planned, model).map((entry) => ({
    entry,
    kind: 'bin' as const,
    name: entry.name.replace(/^bin-/u, ''),
    outputPath: entry.outputRelativePath,
    target,
  }));
};

const mcpEntryEntries = async (
  model: NormalizedPlugin,
  composite: CompositeSelection,
  outDir: string,
): Promise<readonly PlannedRslibInspection[]> => {
  const target = composite.identity;
  const noticeDelivery = composite.noticeDelivery;
  const planned = planCompiledMcpEntries(model.mcpServers, { outDir, target, targets: composite.selected });
  const hosting = eventRuntimeHosting(model.mcpServers, composite.selected);
  const entries: PlannedRslibInspection[] = [];
  for (const entry of planned) {
    const server = model.mcpServers.find((candidate) => candidate.id === entry.id);
    const serverName = entry.id.startsWith('mcp:') ? entry.id.slice('mcp:'.length) : entry.name;
    const generatedRoutes = server?.generatedRoutes;
    const wrapped = generatedRoutes !== undefined || (await scanEntryExports(entry.source)).hasDefaultExport;
    const workerFile = `${entry.name}-flight.mjs`;
    const routeSource = generatedRoutes === undefined || server === undefined
      ? undefined
      : generatedRouteMcpEntrySource({
        allowedTargets: hosting.serverIds.has(server.id) ? hosting.allowedTargets : [],
        hosts: selectedServerHosts(server, composite.selected),
        ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
        ...(model.notices === undefined ? {} : { noticeRetention: model.notices.retention.resolved }),
        plugin: { name: model.metadata.name, version: model.metadata.version },
        routes: generatedRoutes,
        serverName,
        ...(model.state === undefined ? {} : { state: model.state }),
        workerFile,
      });
    entries.push({
      entry: {
        aliases: {
          // Every stdio entry can import the operator `.env` layer (#469); the
          // lifecycle shell of a wrapped entry applies it itself.
          [launchEnvRuntimeSpecifier]: launchEnvRuntimePath(),
          ...(wrapped
            ? {
              [mcpEntryRuntimeSpecifier]: mcpEntryRuntimePath(),
              ...(routeSource === undefined ? {} : { [mcpServerRuntimeSpecifier]: mcpServerRuntimePath() }),
            }
            : {}),
        },
        ...(wrapped
          ? {
            virtualSource: generatedStdioMcpEntrySource({
              entrySource: routeSource === undefined ? entry.source : 'agent-bundle/generated-route-server',
              serverName,
            }),
          }
          : {}),
        name: entry.name,
        outputRelativePath: `mcp/${entry.name}.mjs`,
        ...(routeSource === undefined ? {} : { rscManifest: true as const }),
        source: entry.source,
        sourceInputs: [],
        virtualModules: [
          {
            name: 'agent-bundle/mcp-apps',
            source: '/* The MCP App registry virtual module is generated from built app HTML at build time. */',
          },
          ...(routeSource === undefined ? [] : [{ name: 'agent-bundle/generated-route-server', source: routeSource }]),
          ...(wrapped ? [stdioPreludeVirtualModule(server?.env)] : []),
        ],
      },
      kind: 'mcp-entry',
      name: serverName,
      outputPath: `mcp/${entry.name}.mjs`,
      target,
    });
    if (generatedRoutes !== undefined) {
      entries.push({
        entry: {
          name: `${entry.name}-flight`,
          outputRelativePath: `mcp/${workerFile}`,
          reactServer: true,
          rscManifest: true,
          source: entry.source,
          sourceInputs: [],
          virtualSource: generatedRouteFlightWorkerSource({
            artifactEpoch: generatedRouteArtifactEpoch({ name: model.metadata.name, version: model.metadata.version }),
            layouts: model.layouts ?? [],
            ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
            ...(model.notices === undefined ? {} : { noticeRetention: model.notices.retention.resolved }),
            providers: model.providers ?? [],
            routes: generatedRoutes,
            serverName,
            ...(model.state === undefined ? {} : { state: model.state }),
          }),
        },
        kind: 'mcp-entry',
        name: `${serverName}:flight`,
        outputPath: `mcp/${workerFile}`,
        target,
      });
    }
  }
  return entries;
};

const hookEntries = (entries: readonly TargetHookEntry[], target: string): readonly PlannedRslibInspection[] =>
  entries.map((entry) => ({
    entry: {
      aliases: {
        [launchEnvRuntimeSpecifier]: launchEnvRuntimePath(),
        ...(entry.hook.eventRoute === undefined
          ? {}
          : {
            [eventIpcRuntimeSpecifier]: eventRuntimeModulePath('ipc'),
            [eventProjectRuntimeSpecifier]: eventRuntimeModulePath('project'),
          }),
      },
      name: entry.relativePath.replaceAll('/', '-').replace(/\.mjs$/u, ''),
      outputRelativePath: entry.relativePath,
      source: entry.hook.source,
      sourceInputs: [],
      virtualSource: entry.virtualSource,
      ...(hookWrapperAppliesOperatorEnv(entry) ? { virtualModules: [operatorEnvLayerVirtualModule()] } : {}),
    },
    kind: 'hook' as const,
    name: entry.hook.name,
    outputPath: entry.relativePath,
    target,
  }));

const packageBuildEntries = async (
  model: NormalizedPlugin,
  dtsTsconfigPath: string | undefined,
): Promise<readonly PlannedRslibInspection[]> => {
  const packageBuild = model.packageBuild;
  if (packageBuild === undefined) return [];
  const planned = await planPackageEntries(model, dtsTsconfigPath);
  return planned.map((entry) => {
    const bin = entry.executable;
    return {
      entry,
      kind: bin ? 'bin' as const : 'lib' as const,
      name: bin ? entry.name.replace(/^bin-/u, '') : entry.name,
      outputPath: `${packageBuild.outputDir}/${entry.outputRelativePath}`,
    };
  });
};

const loweredRslibEntries = async (
  planned: readonly PlannedRslibInspection[],
  run: {
    readonly meta: AgentBundleMeta;
    readonly outputRoot: string;
    readonly projectRoot: string;
    readonly tokens: PathTokens;
    readonly tools?: AgentBundleToolsConfig;
  },
): Promise<readonly BundlerInspectionEntry[]> => {
  const configs = await inspectRslibEntries({
    cwd: run.projectRoot,
    meta: run.meta,
    outputRoot: run.outputRoot,
    ...(run.tools === undefined ? {} : { tools: run.tools }),
  }, planned.map((item) => item.entry));
  return planned.map((item, index) => Object.freeze({
    bundler: 'rslib' as const,
    config: renderConfigValue(configs[index], run.tokens),
    ...(item.entry.virtualSource === undefined ? {} : { generatedEntry: item.entry.virtualSource }),
    kind: item.kind,
    name: item.name,
    outputPath: item.outputPath,
    source: item.entry.source,
    ...(item.target === undefined ? {} : { target: item.target }),
  }));
};

const mcpAppEntries = async (
  model: NormalizedPlugin,
  projectRoot: string,
  composite: CompositeSelection,
  outputRoot: string,
  tokens: PathTokens,
  tools: AgentBundleToolsConfig | undefined,
): Promise<readonly BundlerInspectionEntry[]> => {
  const target = composite.identity;
  const apps = model.mcpApps ?? [];
  const planned = planCompiledMcpApps(apps, { outDir: outputRoot, selected: composite.selected, target });
  if (planned.length === 0) return [];
  const sources = planned.map((app) => {
    const source = apps.find((candidate) => candidate.id === app.id);
    if (source === undefined) {
      throw new Error(`MCP App ${JSON.stringify(app.id)} disappeared during bundler inspection.`);
    }
    return source;
  });
  const configs = await inspectMcpAppsConfig(planned, sources, {
    cwd: projectRoot,
    meta: projectMeta(model.metadata),
    outDir: outputRoot,
    ...(tools === undefined ? {} : { tools }),
  });
  return planned.map((app, index) => Object.freeze({
    bundler: 'rsbuild' as const,
    config: renderConfigValue(configs[index], tokens),
    kind: 'mcp-app' as const,
    name: app.name,
    outputPath: `mcp-apps/${app.name}.html`,
    source: app.source,
    target,
  }));
};

const entryOrder = (left: BundlerInspectionEntry, right: BundlerInspectionEntry): number =>
  (left.target ?? '').localeCompare(right.target ?? '') ||
  left.kind.localeCompare(right.kind) ||
  left.name.localeCompare(right.name);

/** The composite root's selection, as the build planned it (#555). */
export type CompositeSelection = Pick<CompositePlan, 'cliBin' | 'hookEntries' | 'identity' | 'noticeDelivery' | 'selected'>;

export const composeBundlerInspection = async (options: {
  readonly composite: CompositeSelection;
  readonly model: NormalizedPlugin;
  /** The project root: the bundler `context` and the root of the generated-module namespace. */
  readonly projectRoot: string;
  readonly tools?: AgentBundleToolsConfig;
}): Promise<BundlerInspection> => {
  const { composite, model, projectRoot, tools } = options;
  const meta = projectMeta(model.metadata);
  const packageLib = model.packageBuild?.lib;
  const dtsTsconfig = packageLib?.dts === true
    ? await synthesizeDtsTsconfig({ projectRoot, sourceDir: dirname(packageLib.source) })
    : undefined;
  // The output roots are absolute, as the build passes them and as the
  // resolved-config assertions expect them; the rendering folds the token
  // root back to its token.
  const artifactOutputRoot = resolve(projectRoot, artifactOutputToken);
  const tokens: PathTokens = [
    [artifactOutputRoot, artifactOutputToken],
    ...(dtsTsconfig === undefined
      ? []
      : [[dtsTsconfig.path, generatedDtsTsconfigToken] as const]),
  ];
  try {
    // The artifact surfaces ride one Rslib run, as the build stages them; the
    // package build is its own run with its own output root.
    const artifactSurfaces: readonly PlannedRslibInspection[] = [
      ...(composite.cliBin ? cliBinEntries(model, artifactOutputRoot, composite.identity) : []),
      ...(await scriptEntries(model, composite)),
      ...(await mcpEntryEntries(model, composite, artifactOutputRoot)),
      ...hookEntries(composite.hookEntries, composite.identity),
    ];
    const entries: BundlerInspectionEntry[] = [
      ...(await loweredRslibEntries(artifactSurfaces, {
        meta,
        outputRoot: artifactOutputRoot,
        projectRoot,
        tokens,
        ...(tools === undefined ? {} : { tools }),
      })),
      ...(await mcpAppEntries(model, projectRoot, composite, artifactOutputRoot, tokens, tools)),
      ...(model.packageBuild === undefined
        ? []
        : await loweredRslibEntries(await packageBuildEntries(model, dtsTsconfig?.path), {
          meta,
          outputRoot: resolve(projectRoot, model.packageBuild.outputDir),
          projectRoot,
          tokens,
          ...(tools === undefined ? {} : { tools }),
        })),
    ];
    return deepFreeze({
      entries: entries.sort(entryOrder),
    });
  } finally {
    await dtsTsconfig?.cleanup();
  }
};
