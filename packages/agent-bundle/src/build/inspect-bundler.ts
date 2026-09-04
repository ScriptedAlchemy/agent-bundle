import type { NoticeDeliveryAdvertisement } from '../adapters/notice-delivery.ts';
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
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
  terminalCapabilityRuntimePath,
  terminalCapabilityRuntimeSpecifier,
} from './entry-shell.ts';
import { cliBinRslibEntries, planCompiledCliBins } from './cli-bins.ts';
import { planCompiledMcpEntries } from './entries.ts';
import { composeMcpAppsRsbuildConfig, planCompiledMcpApps } from './mcp-apps.ts';
import { projectMeta } from './meta.ts';
import { planPackageEntries } from './package-build.ts';
import { composeEntryLibConfig, type RslibEntry } from './rslib.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { AgentBundleMeta } from '../meta.ts';


/**
 * `agent-bundle inspect --bundler` (RFC #50 §3.4): surfaces the internal
 * Rslib/Rsbuild configurations the build composes — the framework profile
 * with the consumer `tools` escape hatch merged over it and the invariant
 * hook appended last — for every synthesized output. The composition comes
 * from the same functions the build lowers (`composeEntryLibConfig`,
 * `composeMcpAppsRsbuildConfig`), so the inspection can never drift from
 * what actually compiles.
 *
 * Two build-time-only values are replaced with stable tokens so the output
 * is deterministic for one project: the artifact output root (chosen by
 * `build --output` and staged per build) appears as `<output>/<target>`,
 * and the synthesized declaration tsconfig (a temporary file the package
 * build generates under `node_modules`) appears as
 * `<generated-dts-tsconfig>`. Nothing else is redacted; this is a local
 * debugging surface. The generated-module namespace
 * (`<project root>/.agent-bundle-virtual/...`) appears exactly as the build
 * composes it: it derives from the project root, not from the output root.
 */

export interface BundlerInspectionEntry {
  readonly bundler: 'rsbuild' | 'rslib';
  /** The composed config, JSON-rendered: functions appear as `[function <name>]`. */
  readonly config: unknown;
  /** The generated wrapper entry module, when the framework provides one. */
  readonly generatedEntry?: string;
  readonly kind: 'bin' | 'hook' | 'lib' | 'mcp-apps' | 'mcp-entry' | 'script';
  readonly name: string;
  /** POSIX output path relative to the artifact root (targets) or project root (package build). */
  readonly outputPath: string;
  /** The authored entry module (absent for the per-target MCP Apps config). */
  readonly source?: string;
  readonly target?: string;
}

export interface BundlerInspection {
  readonly entries: readonly BundlerInspectionEntry[];
}

export const generatedDtsTsconfigToken = '<generated-dts-tsconfig>';

const artifactOutputToken = (target: string): string => `<output>/${target}`;

const isPlainObject: (value: object) => boolean = isPlainRecord;

/**
 * Renders a composed bundler config as JSON-safe data without dropping the
 * shape: functions (consumer `tools.rspack` mutators, the framework
 * invariant hook) become `[function <name>]`, class instances become
 * `[object <constructor>]`.
 */
const renderConfigValue = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'function') return `[function ${value.name.length === 0 ? 'anonymous' : value.name}]`;
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => renderConfigValue(item, ancestors));
    }
    if (!isPlainObject(value)) {
      return `[object ${value.constructor?.name ?? 'unknown'}]`;
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, renderConfigValue(item, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
};

const rslibInspectionEntry = (options: {
  readonly entry: RslibEntry;
  readonly kind: BundlerInspectionEntry['kind'];
  readonly meta: AgentBundleMeta;
  readonly name: string;
  readonly outputPath: string;
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly source: string;
  readonly target?: string;
  readonly tools?: AgentBundleToolsConfig;
}): BundlerInspectionEntry => Object.freeze({
  bundler: 'rslib',
  config: renderConfigValue(composeEntryLibConfig(options.entry, {
    cwd: options.projectRoot,
    meta: options.meta,
    outputRoot: options.outputRoot,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  })),
  ...(options.entry.virtualSource === undefined ? {} : { generatedEntry: options.entry.virtualSource }),
  kind: options.kind,
  name: options.name,
  outputPath: options.outputPath,
  source: options.source,
  ...(options.target === undefined ? {} : { target: options.target }),
});

const scriptEntries = async (
  model: NormalizedPlugin,
  projectRoot: string,
  target: string,
  tools: AgentBundleToolsConfig | undefined,
): Promise<readonly BundlerInspectionEntry[]> => {
  const meta = projectMeta(model.metadata);
  const outputRoot = artifactOutputToken(target);
  const scripts = model.scripts.filter((script) =>
    script.mode === 'bundle' && script.targets.includes(target));
  return Promise.all(scripts.map(async (script) => {
    const exports = await scanEntryExports(script.source);
    return rslibInspectionEntry({
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
      kind: 'script',
      meta,
      name: script.name,
      outputPath: `${target}/scripts/${script.name}.mjs`,
      outputRoot,
      projectRoot,
      source: script.source,
      target,
      ...(tools === undefined ? {} : { tools }),
    });
  }));
};

/** The artifact-hosted routed CLI bins of one target (#387), composed by the build's own planner. */
const cliBinEntries = (
  model: NormalizedPlugin,
  projectRoot: string,
  target: string,
  tools: AgentBundleToolsConfig | undefined,
): readonly BundlerInspectionEntry[] => {
  const meta = projectMeta(model.metadata);
  const outputRoot = artifactOutputToken(target);
  const planned = planCompiledCliBins(model, { outDir: outputRoot, target });
  return cliBinRslibEntries(planned, model).map((entry) => rslibInspectionEntry({
    entry,
    kind: 'bin',
    meta,
    name: entry.name.replace(/^bin-/u, ''),
    outputPath: `${target}/${entry.outputRelativePath}`,
    outputRoot,
    projectRoot,
    source: entry.source,
    target,
    ...(tools === undefined ? {} : { tools }),
  }));
};

const mcpEntryEntries = async (
  model: NormalizedPlugin,
  projectRoot: string,
  target: string,
  tools: AgentBundleToolsConfig | undefined,
  noticeDelivery: NoticeDeliveryAdvertisement | undefined,
): Promise<readonly BundlerInspectionEntry[]> => {
  const meta = projectMeta(model.metadata);
  const outputRoot = artifactOutputToken(target);
  const planned = planCompiledMcpEntries(model.mcpServers, { outDir: outputRoot, target });
  const entries: BundlerInspectionEntry[] = [];
  for (const entry of planned) {
    const server = model.mcpServers.find((candidate) => candidate.id === entry.id);
    const serverName = entry.id.startsWith('mcp:') ? entry.id.slice('mcp:'.length) : entry.name;
    const generatedRoutes = server?.generatedRoutes;
    const wrapped = generatedRoutes !== undefined || (await scanEntryExports(entry.source)).hasDefaultExport;
    const workerFile = `${entry.name}-flight.mjs`;
    const routeSource = generatedRoutes === undefined
      ? undefined
      : generatedRouteMcpEntrySource({
        ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
        ...(model.notices === undefined ? {} : { noticeRetention: model.notices.retention.resolved }),
        plugin: { name: model.metadata.name, version: model.metadata.version },
        routes: generatedRoutes,
        serverName,
        ...(model.state === undefined ? {} : { state: model.state }),
        workerFile,
      });
    entries.push(rslibInspectionEntry({
      entry: {
        ...(wrapped
          ? {
            aliases: {
              [mcpEntryRuntimeSpecifier]: mcpEntryRuntimePath(),
              ...(routeSource === undefined ? {} : { [mcpServerRuntimeSpecifier]: mcpServerRuntimePath() }),
            },
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
        ],
      },
      kind: 'mcp-entry',
      meta,
      name: serverName,
      outputPath: `${target}/mcp/${entry.name}.mjs`,
      outputRoot,
      projectRoot,
      source: entry.source,
      target,
      ...(tools === undefined ? {} : { tools }),
    }));
    if (generatedRoutes !== undefined) {
      entries.push(rslibInspectionEntry({
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
        meta,
        name: `${serverName}:flight`,
        outputPath: `${target}/mcp/${workerFile}`,
        outputRoot,
        projectRoot,
        source: entry.source,
        target,
        ...(tools === undefined ? {} : { tools }),
      }));
    }
  }
  return Object.freeze(entries);
};

const hookEntries = (
  entries: readonly TargetHookEntry[],
  meta: AgentBundleMeta,
  projectRoot: string,
  target: string,
  tools: AgentBundleToolsConfig | undefined,
): readonly BundlerInspectionEntry[] => {
  const outputRoot = artifactOutputToken(target);
  return entries.map((entry) => rslibInspectionEntry({
    entry: {
      name: entry.relativePath.replaceAll('/', '-').replace(/\.mjs$/u, ''),
      outputRelativePath: entry.relativePath,
      source: entry.hook.source,
      sourceInputs: [],
      virtualSource: entry.virtualSource,
    },
    kind: 'hook',
    meta,
    name: entry.hook.name,
    outputPath: `${target}/${entry.relativePath}`,
    outputRoot,
    projectRoot,
    source: entry.hook.source,
    target,
    ...(tools === undefined ? {} : { tools }),
  }));
};

const mcpAppsEntry = (
  model: NormalizedPlugin,
  projectRoot: string,
  target: string,
  tools: AgentBundleToolsConfig | undefined,
): readonly BundlerInspectionEntry[] => {
  const outputRoot = artifactOutputToken(target);
  const apps = model.mcpApps ?? [];
  const planned = planCompiledMcpApps(apps, { outDir: outputRoot, target });
  if (planned.length === 0) return [];
  const sources = planned.map((app) => {
    const source = apps.find((candidate) => candidate.id === app.id);
    if (source === undefined) {
      throw new Error(`MCP App ${JSON.stringify(app.id)} disappeared during bundler inspection.`);
    }
    return source;
  });
  return [Object.freeze({
    bundler: 'rsbuild' as const,
    config: renderConfigValue(composeMcpAppsRsbuildConfig(sources, {
      cwd: projectRoot,
      meta: projectMeta(model.metadata),
      outDir: outputRoot,
      ...(tools === undefined ? {} : { tools }),
    })),
    kind: 'mcp-apps' as const,
    name: 'mcp-apps',
    outputPath: `${target}/mcp-apps`,
    target,
  })];
};

const packageBuildEntries = async (
  model: NormalizedPlugin,
  projectRoot: string,
  tools: AgentBundleToolsConfig | undefined,
): Promise<readonly BundlerInspectionEntry[]> => {
  const packageBuild = model.packageBuild;
  if (packageBuild === undefined) return [];
  const dtsTsconfig = packageBuild.lib?.dts === true ? generatedDtsTsconfigToken : undefined;
  const planned = await planPackageEntries(model, dtsTsconfig);
  const meta = projectMeta(model.metadata);
  return planned.map((entry) => {
    const bin = entry.executable;
    return rslibInspectionEntry({
      entry,
      kind: bin ? 'bin' : 'lib',
      meta,
      name: bin ? entry.name.replace(/^bin-/u, '') : entry.name,
      outputPath: `${packageBuild.outputDir}/${entry.outputRelativePath}`,
      outputRoot: packageBuild.outputDir,
      projectRoot,
      source: entry.source,
      ...(tools === undefined ? {} : { tools }),
    });
  });
};

const entryOrder = (left: BundlerInspectionEntry, right: BundlerInspectionEntry): number =>
  (left.target ?? '').localeCompare(right.target ?? '') ||
  left.kind.localeCompare(right.kind) ||
  left.name.localeCompare(right.name);

export const composeBundlerInspection = async (options: {
  readonly model: NormalizedPlugin;
  /** The project root: the bundler `context` and the root of the generated-module namespace. */
  readonly projectRoot: string;
  readonly targets: readonly {
    /** True when the target hosts the routed CLI bin (its adapter publishes the `cli` capability). */
    readonly cliBin?: boolean;
    readonly hookEntries: readonly TargetHookEntry[];
    readonly name: string;
    readonly noticeDelivery?: NoticeDeliveryAdvertisement;
  }[];
  readonly tools?: AgentBundleToolsConfig;
}): Promise<BundlerInspection> => {
  const entries: BundlerInspectionEntry[] = [];
  const meta = projectMeta(options.model.metadata);
  for (const target of options.targets) {
    entries.push(
      ...(target.cliBin === true ? cliBinEntries(options.model, options.projectRoot, target.name, options.tools) : []),
      ...(await scriptEntries(options.model, options.projectRoot, target.name, options.tools)),
      ...(await mcpEntryEntries(options.model, options.projectRoot, target.name, options.tools, target.noticeDelivery)),
      ...hookEntries(target.hookEntries, meta, options.projectRoot, target.name, options.tools),
      ...mcpAppsEntry(options.model, options.projectRoot, target.name, options.tools),
    );
  }
  entries.push(...(await packageBuildEntries(options.model, options.projectRoot, options.tools)));
  return deepFreeze({
    entries: entries.sort(entryOrder),
  });
};
