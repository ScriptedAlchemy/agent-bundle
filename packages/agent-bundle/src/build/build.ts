import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import packageManifest from '../../package.json' with { type: 'json' };

import type { TargetRegistry } from '../adapters/registry.ts';
import { deduplicateDiagnostics, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type { ProjectContext } from '../core/project-context.ts';
import { pathTokens, type AgentBundleToolsConfig, type NormalizedPlugin } from '../core/types.ts';
import { assertInside, isInsideOrEqual } from '../core/paths.ts';
import { agentSkillsSchemaRevision } from '../schemas/agent-skills/contract.ts';
import {
  planCompiledEntries,
  planCompiledHooks,
  planCompiledMcpEntries,
  planHooksSurface,
  planMcpEntriesSurface,
  planScriptsSurface,
  type CompiledEntry,
  type CompiledHookEntry,
  type CompiledMcpEntry,
} from './entries.ts';
import { planCliBinsSurface, planCompiledCliBins, type CompiledCliBin } from './cli-bins.ts';
import { composeProjections, type CompositePlan } from './compose.ts';
import { projectMeta } from './meta.ts';
import {
  compileMcpApps,
  planCompiledMcpApps,
  type CompiledMcpApp,
  type McpAppCompileMode,
  type PlannedMcpApp,
} from './mcp-apps.ts';
import { bundleSyntaxCheckFor } from './module-imports.ts';
import { compileRslibSurfaces, settledRslibSurface } from './rslib.ts';
import { planCompileStages } from './compile-stages.ts';
import {
  assertUniqueArtifactDestinations,
  createArtifactManifestFiles,
  emitPlanEntries,
  listArtifactFiles,
  publishArtifact,
  resolveArtifactDestination,
  writeManifest,
} from './emit.ts';
import {
  artifactManifestVersion,
  compareArtifactManifestHooks,
  type ArtifactManifest,
  type ArtifactManifestBin,
  type ArtifactManifestDistribution,
  type ArtifactManifestExecutables,
  type ArtifactManifestHook,
  type ArtifactManifestMcpApp,
  type ArtifactManifestMcpServer,
  type ArtifactManifestProjection,
  type ArtifactManifestScript,
} from './manifest.ts';
import { artifactRoutesFor } from './manifest-routes.ts';
import type { CompiledRouteGraph } from '../routes/types.ts';
import {
  createOutputProvenance,
  type ArtifactOutputCandidate,
  type ArtifactOutputProvenance,
} from './provenance.ts';
import { validateArtifact, validateArtifactFiles } from './validate-artifact.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface BuildResult {
  /** The routed-CLI executables emitted into host artifacts (#387), one per hosting target. */
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  /**
   * Non-fatal compiler findings the artifact survived — MCP App view compile
   * warnings and size advisories. Errors never reach here: a failing compile
   * throws a `DiagnosticError` carrying them.
   */
  readonly diagnostics: readonly Diagnostic[];
  readonly manifest: ArtifactManifest;
  readonly outputProvenance: readonly ArtifactOutputProvenance[];
  readonly outputRoot: string;
}

export interface BuildOptions {
  /**
   * The MCP App view compile profile; defaults to `production`. Only the
   * Workbench dev loop passes `development` (readable output, inline source
   * maps); artifact and Rslib surfaces are unaffected.
   */
  readonly mode?: McpAppCompileMode;
  readonly model: NormalizedPlugin;
  readonly outputRoot: string;
  readonly projectContext: ProjectContext;
  readonly projectRoot: string;
  readonly registry: TargetRegistry;
  /** The compiled route graph the manifest records as the artifact's Application IR (#592 step 3). */
  readonly routeGraph: CompiledRouteGraph;
  /** The consumer bundler escape hatch, applied to every synthesized config. */
  readonly tools?: AgentBundleToolsConfig;
}

/** The compiled outputs of the one composite root, planned before anything compiles. */
interface StagedRoot {
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly PlannedMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly root: string;
}

const prebuiltArtifactPaths = (model: NormalizedPlugin): ReadonlySet<string> =>
  new Set((model.payloads ?? []).flatMap((payload) =>
    payload.files.map((file) => `${payload.name}/${file.relativePath}`)));

const missingPrebuiltDiagnostic = (subject: string, artifactPath: string): Diagnostic => ({
  code: 'AB4748',
  message: `${subject} ${JSON.stringify(artifactPath)} is not present in its declared payload; run the project's own build before "agent-bundle build".`,
  severity: 'error',
});

/**
 * AB4747-AB4749: an artifact build packages prebuilt payloads exactly as
 * they exist, so it refuses to run while a declared payload is missing or
 * empty, a prebuilt entry file is absent, or a payload directory overlaps
 * the artifact output root. Validation reports the first two states as
 * warnings (AB4743/AB4745) because development flows never require the
 * consumer's own build to have run.
 */
const prebuiltPayloadDiagnostics = (
  model: NormalizedPlugin,
  outputRoot: string,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const selectedTargets = new Set(model.targets.map((target) => target.name));
  for (const payload of model.payloads ?? []) {
    if (isInsideOrEqual(payload.source, outputRoot) || isInsideOrEqual(outputRoot, payload.source)) {
      diagnostics.push({
        code: 'AB4749',
        message: `Payload ${JSON.stringify(payload.name)} source ${JSON.stringify(payload.source)} overlaps the artifact output ${JSON.stringify(outputRoot)}; pass a different --output.`,
        severity: 'error',
      });
    }
    if (payload.files.length === 0 && payload.targets.some((target) => selectedTargets.has(target))) {
      diagnostics.push({
        code: 'AB4747',
        message: `Payload ${JSON.stringify(payload.name)} contains no files; run the project's own build before "agent-bundle build".`,
        severity: 'error',
      });
    }
  }
  const artifactPaths = prebuiltArtifactPaths(model);
  const tokenPrefix = `${pathTokens.pluginRoot}/`;
  for (const server of model.mcpServers) {
    if (server.provenance.kind !== 'prebuilt') continue;
    const entry = server.args?.[0];
    if (typeof entry !== 'string' || !entry.startsWith(tokenPrefix)) continue;
    const artifactPath = entry.slice(tokenPrefix.length);
    if (!artifactPaths.has(artifactPath)) {
      diagnostics.push(missingPrebuiltDiagnostic(`MCP server ${JSON.stringify(server.name)} prebuilt entry`, artifactPath));
    }
  }
  for (const hook of model.hooks) {
    if (hook.prebuiltPath === undefined) continue;
    if (!artifactPaths.has(hook.prebuiltPath)) {
      diagnostics.push(missingPrebuiltDiagnostic(`Hook ${JSON.stringify(hook.name)} prebuilt handler`, hook.prebuiltPath));
    }
  }
  return diagnostics;
};

/**
 * The scripts a composite root compiles: every script whose target set
 * intersects the selection, once. Script sources are host-neutral, so one
 * `scripts/<name>.mjs` serves every selected host that declares it.
 */
const selectedScripts = (model: NormalizedPlugin, selected: readonly string[]): NormalizedPlugin['scripts'] =>
  model.scripts.filter((script) => script.targets.some((target) => selected.includes(target)));

const planStagedRoot = (options: {
  readonly composite: CompositePlan;
  readonly model: NormalizedPlugin;
  readonly projectRoot: string;
  readonly root: string;
}): StagedRoot => {
  const { composite, model, root } = options;
  const compiledEntries = planCompiledEntries(selectedScripts(model, composite.selected), { cwd: options.projectRoot, outDir: root });
  const compiledHooks = planCompiledHooks(composite.hookEntries, { outDir: root });
  const compiledMcpApps = planCompiledMcpApps(model.mcpApps ?? [], {
    outDir: root,
    selected: composite.selected,
    target: composite.identity,
  });
  const compiledMcpEntries = planCompiledMcpEntries(model.mcpServers, {
    outDir: root,
    target: composite.identity,
    targets: composite.selected,
  });
  const compiledCliBins = composite.cliBin
    ? planCompiledCliBins(model, { outDir: root, target: composite.identity })
    : Object.freeze([]);
  return { compiledCliBins, compiledEntries, compiledHooks, compiledMcpApps, compiledMcpEntries, root };
};

const plannedDestinations = (composite: CompositePlan, staged: StagedRoot): readonly string[] => [
  ...composite.entries.map((entry) => resolveArtifactDestination(staged.root, entry.relativePath)),
  ...staged.compiledCliBins.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
  ...staged.compiledEntries.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
  ...staged.compiledHooks.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
  ...staged.compiledMcpApps.map((entry) => entry.output),
  ...staged.compiledMcpEntries.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
];

const outputCandidatesFor = (options: {
  readonly artifactRoot: string;
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly entries: CompositePlan['entries'];
}): readonly ArtifactOutputCandidate[] => [
  ...options.entries.map((entry) => ({
    kind: entry.kind !== 'copy'
      ? 'generated' as const
      : entry.prebuilt === true ? 'prebuilt' as const : 'copy' as const,
    path: resolveArtifactDestination(options.artifactRoot, entry.relativePath),
    sourceInputs: entry.sourceInputs,
  })),
  ...options.compiledCliBins.flatMap((entry) => [{
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  }, ...(entry.workerOutput === undefined ? [] : [{
    kind: 'bundle' as const,
    path: entry.workerOutput,
    sourceInputs: entry.workerSourceInputs ?? entry.sourceInputs,
  }])]),
  ...options.compiledEntries.flatMap((entry) => [{
    kind: entry.outputKind,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  }, ...(entry.workerOutput === undefined ? [] : [{
    kind: 'bundle' as const,
    path: entry.workerOutput,
    sourceInputs: entry.workerSourceInputs ?? entry.sourceInputs,
  }])]),
  ...options.compiledHooks.flatMap((entry) => [{
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  }, ...(entry.workerOutput === undefined ? [] : [{
    kind: 'bundle' as const,
    path: entry.workerOutput,
    sourceInputs: entry.workerSourceInputs ?? entry.sourceInputs,
  }])]),
  ...options.compiledMcpApps.map((entry) => ({
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  })),
  ...options.compiledMcpEntries.flatMap((entry) => [{
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  }, ...(entry.workerOutput === undefined ? [] : [{
    kind: 'bundle' as const,
    path: entry.workerOutput,
    sourceInputs: entry.workerSourceInputs ?? entry.sourceInputs,
  }])]),
];

const assertOutputProvenanceSources = (options: {
  readonly outputProvenance: readonly ArtifactOutputProvenance[];
  readonly projectContext: ProjectContext;
}): void => {
  const declaredSources = new Set(options.projectContext.sourceInputs.map((input) => input.path));
  for (const output of options.outputProvenance) {
    for (const sourceInput of output.sourceInputs) {
      if (!declaredSources.has(sourceInput)) {
        throw new Error(`Output provenance source ${JSON.stringify(sourceInput)} is not declared in the project context.`);
      }
    }
  }
};

const sortedHosts = (hosts: Iterable<string>): readonly string[] =>
  Object.freeze([...new Set(hosts)].sort((left, right) => left.localeCompare(right)));

/** Artifact-root-relative POSIX path; refuses anything the parser would reject. */
const artifactPath = (artifactRoot: string, absolute: string): string => {
  const path = relative(artifactRoot, absolute).replaceAll('\\', '/');
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]:/iu.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Artifact path ${JSON.stringify(absolute)} is not relocatable relative to ${JSON.stringify(artifactRoot)}.`);
  }
  return path;
};

/** The selected host projections the composite root holds, with their adapter provenance and derived-document pointers. */
const manifestProjections = (options: {
  readonly composite: CompositePlan;
  readonly filePaths: ReadonlySet<string>;
  readonly registry: TargetRegistry;
}): readonly ArtifactManifestProjection[] => Object.freeze(options.composite.projections
  .map((projection): ArtifactManifestProjection => {
    const host = projection.name;
    const metadata = options.registry.metadata(host);
    const documents = projection.plan.documents;
    const emitted = (path: string | undefined): string | undefined =>
      path !== undefined && options.filePaths.has(path) ? path : undefined;
    const plugin = emitted(documents?.plugin);
    const marketplace = emitted(documents?.marketplace?.path);
    const mcp = emitted(options.registry.mcpRuntime(host)?.manifestPath);
    const hooks = emitted(options.registry.hookContract(host)?.manifestPath);
    const builtInHost = options.registry.builtInHost(host);
    return Object.freeze({
      adapterRevision: metadata.adapterRevision,
      ...(builtInHost === undefined ? {} : { builtInHost }),
      documents: Object.freeze({
        ...(hooks === undefined ? {} : { hooks }),
        ...(marketplace === undefined ? {} : { marketplace }),
        ...(mcp === undefined ? {} : { mcp }),
        ...(plugin === undefined ? {} : { plugin }),
      }),
      host,
      ...(marketplace === undefined || documents?.marketplace === undefined
        ? {}
        : { marketplace: Object.freeze({ name: documents.marketplace.name }) }),
      observedVersion: metadata.observedVersion,
      schemas: Object.freeze(metadata.schemas
        .map((schema) => Object.freeze({ ...schema }))
        .sort((left, right) => left.name.localeCompare(right.name))),
    });
  })
  .sort((left, right) => left.host.localeCompare(right.host)));

const manifestBins = (options: {
  readonly artifactRoot: string;
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly composite: CompositePlan;
}): readonly ArtifactManifestBin[] => {
  const hosts = sortedHosts(options.composite.projections
    .filter((projection) => projection.cliBin)
    .map((projection) => projection.name));
  return Object.freeze(options.compiledCliBins
    .map((bin): ArtifactManifestBin => Object.freeze({
      hosts,
      name: bin.name,
      path: artifactPath(options.artifactRoot, bin.output),
      ...(bin.workerOutput === undefined ? {} : { worker: artifactPath(options.artifactRoot, bin.workerOutput) }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name)));
};

const manifestHooks = (options: {
  readonly artifactRoot: string;
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly model: NormalizedPlugin;
}): readonly ArtifactManifestHook[] => {
  const eventRoutes = new Map(options.model.hooks
    .flatMap((hook) => hook.eventRoute === undefined ? [] : [[hook.id, `event:${hook.eventRoute.event}`] as const]));
  // Host-document wrapper variants stay out of the canonical rows: exactly one
  // row per hook and host, pointing at the wrapper its host contract simulates.
  return Object.freeze(options.compiledHooks
    .filter((entry) => entry.indexed !== false)
    .map((entry): ArtifactManifestHook => Object.freeze({
      event: entry.event,
      host: entry.target,
      id: entry.id,
      kind: eventRoutes.has(entry.id) ? 'event-route' : 'config',
      name: entry.name,
      path: artifactPath(options.artifactRoot, entry.output),
      ...(eventRoutes.has(entry.id) ? { routeId: eventRoutes.get(entry.id)! } : {}),
      ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    }))
    .sort(compareArtifactManifestHooks));
};

const manifestMcpServers = (options: {
  readonly artifactRoot: string;
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly model: NormalizedPlugin;
  readonly selected: readonly string[];
}): readonly ArtifactManifestMcpServer[] => {
  const entries = new Map(options.compiledMcpEntries.map((entry) => [entry.id, entry]));
  return Object.freeze(options.model.mcpServers
    .map((server) => ({ hosts: sortedHosts(server.targets.filter((target) => options.selected.includes(target))), server }))
    .filter(({ hosts }) => hosts.length > 0)
    .map(({ hosts, server }): ArtifactManifestMcpServer => {
      const entry = entries.get(server.id);
      const compiledApps = options.compiledMcpApps
        .filter((app) => app.serverIds.includes(server.id))
        .map((app): ArtifactManifestMcpApp => Object.freeze({
          id: app.id,
          name: app.name,
          path: artifactPath(options.artifactRoot, app.output),
          resourceUri: app.resourceUri,
        }));
      const prebuiltApps = (options.model.mcpApps ?? [])
        .filter((app) => app.prebuilt === true && app.serverId === server.id &&
          app.targets.some((target) => options.selected.includes(target)))
        .map((app): ArtifactManifestMcpApp => Object.freeze({
          id: app.id,
          name: app.name,
          prebuilt: true,
          resourceUri: app.resourceUri,
        }));
      return Object.freeze({
        apps: Object.freeze([...compiledApps, ...prebuiltApps].sort((left, right) => left.id.localeCompare(right.id))),
        ...(entry === undefined
          ? {}
          : {
            entry: Object.freeze({
              path: artifactPath(options.artifactRoot, entry.output),
              ...(entry.workerOutput === undefined ? {} : { worker: artifactPath(options.artifactRoot, entry.workerOutput) }),
            }),
          }),
        hosts,
        id: server.id,
        kind: entry !== undefined ? 'compiled' : server.url !== undefined ? 'remote' : 'command',
        name: server.name,
        transport: server.transport,
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id)));
};

const manifestScripts = (options: {
  readonly artifactRoot: string;
  readonly compiledEntries: readonly CompiledEntry[];
  readonly model: NormalizedPlugin;
  readonly selected: readonly string[];
}): readonly ArtifactManifestScript[] => {
  const compiled = new Map(options.compiledEntries.map((entry) => [entry.name, entry]));
  return Object.freeze(selectedScripts(options.model, options.selected)
    .flatMap((script): ArtifactManifestScript[] => {
      const entry = compiled.get(script.name);
      if (entry === undefined) return [];
      return [Object.freeze({
        hosts: sortedHosts(script.targets.filter((target) => options.selected.includes(target))),
        id: script.id,
        mode: script.mode,
        name: script.name,
        path: artifactPath(options.artifactRoot, entry.output),
        ...(script.rendered === true ? { rendered: Object.freeze({ routeId: script.id }) } : {}),
        ...(entry.workerOutput === undefined ? {} : { worker: artifactPath(options.artifactRoot, entry.workerOutput) }),
      })];
    })
    .sort((left, right) => left.id.localeCompare(right.id)));
};

const manifestDistribution = (options: {
  readonly filePaths: ReadonlySet<string>;
  readonly projectContext: ProjectContext;
}): ArtifactManifestDistribution => {
  const instructions = options.filePaths.has('INSTALL.md') ? 'INSTALL.md' : undefined;
  const script = options.filePaths.has('install.mjs') ? 'install.mjs' : undefined;
  return Object.freeze({
    channels: Object.freeze(options.projectContext.packageName === undefined ? ['local' as const] : ['local' as const, 'npm' as const]),
    ...(instructions === undefined && script === undefined
      ? {}
      : {
        install: Object.freeze({
          ...(instructions === undefined ? {} : { instructions }),
          ...(script === undefined ? {} : { script }),
        }),
      }),
  });
};

const manifestFor = (options: {
  readonly artifactRoot: string;
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly composite: CompositePlan;
  readonly files: ArtifactManifest['files'];
  readonly model: NormalizedPlugin;
  readonly projectContext: ProjectContext;
  readonly registry: TargetRegistry;
  readonly routeGraph: CompiledRouteGraph;
}): ArtifactManifest => {
  const filePaths = new Set(options.files.map((file) => file.path));
  const projections = manifestProjections({ composite: options.composite, filePaths, registry: options.registry });
  const selected = options.composite.selected;
  const executables: ArtifactManifestExecutables = Object.freeze({
    bins: manifestBins({ artifactRoot: options.artifactRoot, compiledCliBins: options.compiledCliBins, composite: options.composite }),
    hooks: manifestHooks({ artifactRoot: options.artifactRoot, compiledHooks: options.compiledHooks, model: options.model }),
    mcpServers: manifestMcpServers({
      artifactRoot: options.artifactRoot,
      compiledMcpApps: options.compiledMcpApps,
      compiledMcpEntries: options.compiledMcpEntries,
      model: options.model,
      selected,
    }),
    scripts: manifestScripts({
      artifactRoot: options.artifactRoot,
      compiledEntries: options.compiledEntries,
      model: options.model,
      selected,
    }),
  });
  return {
    agentSkills: agentSkillsSchemaRevision,
    application: {
      ...(options.model.metadata.description === undefined ? {} : { description: options.model.metadata.description }),
      id: options.model.metadata.id,
      name: options.model.metadata.name,
      version: options.model.metadata.version,
    },
    distribution: manifestDistribution({ filePaths, projectContext: options.projectContext }),
    executables,
    files: options.files,
    manifestVersion: artifactManifestVersion,
    producer: { name: 'agent-bundle', version: packageManifest.version },
    project: options.projectContext,
    projections,
    routes: artifactRoutesFor(options.routeGraph),
    runtime: { ...options.model.runtime },
    validation: {
      artifact: { status: 'passed' },
      projections: projections.map(({ host }) => ({ host, status: 'passed' })),
      source: { status: 'passed' },
    },
  };
};

export const build = async (options: BuildOptions): Promise<BuildResult> => {
  const outputRoot = resolve(options.outputRoot);
  const payloadDiagnostics = prebuiltPayloadDiagnostics(options.model, outputRoot);
  if (payloadDiagnostics.length > 0) throw new DiagnosticError(payloadDiagnostics);
  // One composite root (#555): the selected host projections are planned
  // together and staged as one tree at the artifact root, never one
  // subdirectory per target.
  const composite = composeProjections(options.model, options.registry);
  const preflight = planStagedRoot({
    composite,
    model: options.model,
    projectRoot: options.projectRoot,
    root: outputRoot,
  });
  assertUniqueArtifactDestinations(plannedDestinations(composite, preflight));
  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  const publishedOutput = (entry: { readonly output: string }): string =>
    assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output)));

  try {
    const staged = planStagedRoot({
      composite,
      model: options.model,
      projectRoot: options.projectRoot,
      root: stageRoot,
    });
    assertUniqueArtifactDestinations(plannedDestinations(composite, staged));

    const compiledCliBins: CompiledCliBin[] = [];
    const compiledEntries: CompiledEntry[] = [];
    const compiledHooks: CompiledHookEntry[] = [];
    const compiledMcpApps: CompiledMcpApp[] = [];
    const compiledMcpEntries: CompiledMcpEntry[] = [];
    const compileDiagnostics: Diagnostic[] = [];
    const tools = options.tools === undefined ? {} : { tools: options.tools };
    // The resolved `notices.retention`; generated ledgers fall back to the runtime defaults without it.
    const noticePolicy = options.model.notices === undefined
      ? {}
      : { noticeRetention: options.model.notices.retention.resolved };
    // One identity feeds every compiled surface, exactly the identity the
    // manifest, `inspect`, and dev status report (issue #237).
    const meta = projectMeta(options.model.metadata);
    const plugin = { name: options.model.metadata.name, version: options.model.metadata.version };
    // The routes every selected host honours; the shared MCP entries and each
    // host's hook wrappers are wired from the same advertisement.
    const noticeDelivery = composite.noticeDelivery === undefined ? {} : { noticeDelivery: composite.noticeDelivery };
    let stagedMcpApps: readonly CompiledMcpApp[] = Object.freeze([]);
    for (const stage of planCompileStages(staged)) {
      switch (stage.kind) {
        case 'mcp-apps':
          // The optional browser stage, always first: the MCP entries embed
          // its HTML, and its Rsbuild pass asserts the root holds nothing but
          // that HTML.
          {
            const views = await compileMcpApps(options.model.mcpApps ?? [], {
              cwd: options.projectRoot,
              meta,
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              outDir: stageRoot,
              selected: composite.selected,
              target: composite.identity,
              ...tools,
            });
            stagedMcpApps = views.apps;
            compiledMcpApps.push(...views.apps);
            compileDiagnostics.push(...views.diagnostics);
          }
          break;
        case 'node-surfaces': {
          await emitPlanEntries({ entries: composite.entries, root: stageRoot });
          // Every agent-host surface of the root lowers through one Rslib
          // instance; each surface keeps its own evidence and result.
          const [cliBins, scripts, hooks, mcpEntries] = await compileRslibSurfaces(
            { cwd: options.projectRoot, meta, outputRoot: stageRoot, ...tools },
            [
              composite.cliBin
                ? planCliBinsSurface(options.model, { outDir: stageRoot, target: composite.identity })
                : settledRslibSurface<readonly CompiledCliBin[]>(Object.freeze([])),
              await planScriptsSurface(
                selectedScripts(options.model, composite.selected),
                {
                  cwd: options.projectRoot,
                  layouts: options.model.layouts ?? [],
                  outDir: stageRoot,
                  ...noticePolicy,
                  providers: options.model.providers ?? [],
                  ...(options.model.state === undefined ? {} : { state: options.model.state }),
                },
              ),
              planHooksSurface(composite.hookEntries, {
                artifactEpoch: options.projectContext.revision,
                ...noticeDelivery,
                ...noticePolicy,
                outDir: stageRoot,
                plugin,
                providers: options.model.providers ?? [],
                ...(options.model.state === undefined ? {} : { state: options.model.state }),
              }),
              await planMcpEntriesSurface(options.model.mcpServers, {
                apps: stagedMcpApps,
                artifactEpoch: options.projectContext.revision,
                eventHooks: [...new Map(composite.hookEntries
                  .filter((entry) => entry.hook.eventRoute !== undefined)
                  .map((entry) => [entry.hook.id, entry.hook])).values()],
                layouts: options.model.layouts ?? [],
                ...noticeDelivery,
                ...noticePolicy,
                outDir: stageRoot,
                plugin,
                providers: options.model.providers ?? [],
                ...(options.model.state === undefined ? {} : { state: options.model.state }),
                target: composite.identity,
                targets: composite.selected,
              }),
            ],
          );
          compiledCliBins.push(...cliBins);
          compiledEntries.push(...scripts);
          compiledHooks.push(...hooks);
          compiledMcpEntries.push(...mcpEntries);
          break;
        }
        default: {
          const exhaustive: never = stage;
          throw new Error(`Unknown compile stage ${JSON.stringify(exhaustive)}.`);
        }
      }
    }
    const publishedCompiledEntries = deepFreeze(compiledEntries.map((entry) =>
      ({
        ...entry,
        output: publishedOutput(entry),
      }),
    ));
    const outputProvenance = createOutputProvenance({
      artifactRoot: stageRoot,
      outputs: outputCandidatesFor({
        artifactRoot: stageRoot,
        compiledCliBins,
        compiledEntries,
        compiledHooks,
        compiledMcpApps,
        compiledMcpEntries,
        entries: composite.entries,
      }),
      projectRoot: options.projectRoot,
    });
    assertOutputProvenanceSources({ outputProvenance, projectContext: options.projectContext });
    const files = createArtifactManifestFiles({
      files: await listArtifactFiles(stageRoot),
      outputProvenance,
    });
    const bundleSyntaxCheck = bundleSyntaxCheckFor(options.tools);
    const preManifestDiagnostics = await validateArtifactFiles({
      artifactRoot: stageRoot,
      bundleSyntaxCheck,
      manifestFiles: files,
      prebuiltPaths: new Set(outputProvenance
        .filter((output) => output.kind === 'prebuilt')
        .map((output) => output.path)),
    });
    if (preManifestDiagnostics.some((entry) => entry.severity === 'error')) {
      throw new DiagnosticError(preManifestDiagnostics);
    }
    const manifest = await writeManifest({
      artifactRoot: stageRoot,
      manifest: manifestFor({
        artifactRoot: stageRoot,
        compiledCliBins,
        compiledEntries,
        compiledHooks,
        compiledMcpApps,
        compiledMcpEntries,
        composite,
        files,
        model: options.model,
        projectContext: options.projectContext,
        registry: options.registry,
        routeGraph: options.routeGraph,
      }),
    });
    const diagnostics = await validateArtifact({ artifactRoot: stageRoot, bundleSyntaxCheck, registry: options.registry });
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      throw new DiagnosticError(diagnostics);
    }
    await publishArtifact({ outputRoot, stageRoot });
    return Object.freeze({
      compiledCliBins: Object.freeze(compiledCliBins.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
        ...(entry.workerOutput === undefined ? {} : { workerOutput: publishedOutput({ output: entry.workerOutput }) }),
      }))),
      compiledEntries: publishedCompiledEntries,
      compiledHooks: Object.freeze(compiledHooks.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
        ...(entry.workerOutput === undefined ? {} : { workerOutput: publishedOutput({ output: entry.workerOutput }) }),
      }))),
      compiledMcpApps: Object.freeze(compiledMcpApps.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
      }))),
      compiledMcpEntries: Object.freeze(compiledMcpEntries.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
        ...(entry.workerOutput === undefined ? {} : { workerOutput: publishedOutput({ output: entry.workerOutput }) }),
      }))),
      diagnostics: deepFreeze(deduplicateDiagnostics(compileDiagnostics)),
      manifest,
      outputProvenance,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
