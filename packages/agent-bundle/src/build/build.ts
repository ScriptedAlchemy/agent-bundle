import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { rspack } from '@rslib/core';

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
import { compileRslibSurfaces, settledRslibSurface } from './compiler.ts';
import {
  compileEvidenceFileName,
  createCompileEvidenceRecord,
  type CompileEvidenceRecord,
} from './compile-evidence.ts';
import type { CompileResult } from './compile-result.ts';
import { planCompileStages } from './compile-stages.ts';
import {
  assertUniqueArtifactDestinations,
  artifactHookIndexName,
  createArtifactManifestFiles,
  emitPlanEntries,
  listArtifactFiles,
  publishArtifact,
  resolveArtifactDestination,
  writeCompileEvidence,
  writeHookIndex,
  writeManifest,
} from './emit.ts';
import type { ArtifactManifest } from './manifest.ts';
import {
  createOutputProvenance,
  type ArtifactOutputCandidate,
  type ArtifactOutputProvenance,
} from './provenance.ts';
import { validateArtifact, validateArtifactFiles } from './validate-artifact.ts';
import { deepFreeze } from '../core/freeze.ts';
import { parseWebManifest, type WebManifest } from '../web-host/manifest.ts';


export interface BuildResult {
  /** The routed-CLI executables emitted into host artifacts (#387), one per hosting target. */
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly compileEvidence: CompileEvidenceRecord;
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
  ...staged.compiledHooks.flatMap((entry) => [
    entry.output,
    ...(entry.executorOutput === undefined ? [] : [entry.executorOutput]),
    ...(entry.workerOutput === undefined ? [] : [entry.workerOutput]),
  ]),
  ...staged.compiledMcpApps.map((entry) => entry.output),
  ...staged.compiledMcpEntries.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
];

const hookIndexSourceInputs = (
  model: NormalizedPlugin,
  compiledHooks: readonly CompiledHookEntry[],
): readonly string[] => {
  const hookIds = new Set(compiledHooks.map((hook) => hook.id));
  const inputs = model.hooks
    .filter((hook) => hookIds.has(hook.id))
    .map((hook) => hook.provenance.sourcePath);
  return inputs.length === 0 ? [model.metadata.provenance.sourcePath] : inputs;
};

const outputCandidatesFor = (options: {
  readonly artifactRoot: string;
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly entries: CompositePlan['entries'];
  readonly model: NormalizedPlugin;
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
  }, ...(entry.executorOutput === undefined ? [] : [{
    kind: 'bundle' as const,
    path: entry.executorOutput,
    sourceInputs: entry.executorSourceInputs ?? entry.sourceInputs,
  }]), ...(entry.workerOutput === undefined ? [] : [{
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
  {
    kind: 'generated' as const,
    path: resolveArtifactDestination(options.artifactRoot, artifactHookIndexName),
    sourceInputs: hookIndexSourceInputs(options.model, options.compiledHooks),
  },
  {
    kind: 'generated' as const,
    path: resolveArtifactDestination(options.artifactRoot, compileEvidenceFileName),
    sourceInputs: [options.model.metadata.provenance.sourcePath],
  },
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

/** The selected real projections the composite root holds, with their adapter provenance. */
const manifestTargets = (
  registry: TargetRegistry,
  selected: readonly string[],
): ArtifactManifest['targets'] => Object.freeze(selected
  .map((name) => {
    const metadata = registry.metadata(name);
    return Object.freeze({
      adapterRevision: metadata.adapterRevision,
      name,
      observedVersion: metadata.observedVersion,
      schemas: Object.freeze(metadata.schemas
        .map((schema) => Object.freeze({ ...schema }))
        .sort((left, right) => left.name.localeCompare(right.name))),
    });
  })
  .sort((left, right) => left.name.localeCompare(right.name)));

/**
 * The manifest `web` section for this composite root: the exposed Apps whose
 * declaration targets intersect the selection, exactly the Apps
 * `planCompiledMcpApps` compiles into it. An App scoped to a host outside the
 * selection is not advertised, since the server the root ships cannot serve
 * it; a selection that exposes none leaves the section out.
 */
const webManifestFor = (options: {
  readonly artifactRoot: string;
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly model: NormalizedPlugin;
  readonly selected: readonly string[];
}): WebManifest | undefined => {
  if (options.model.web === undefined) return undefined;
  const entries = new Map(options.compiledMcpEntries.map((entry) => [
    entry.id,
    relative(options.artifactRoot, entry.output).replaceAll('\\', '/'),
  ]));
  const servers = new Map(options.model.mcpServers.map((server) => [server.id, server]));
  const selectedApps = (options.model.mcpApps ?? []).filter((app) =>
    app.targets.some((target) => options.selected.includes(target)));
  const exposed = options.model.web.apps.filter((app) =>
    selectedApps.some((candidate) => candidate.serverId === app.serverId && candidate.name === app.appName));
  if (exposed.length === 0) return undefined;
  const apps = exposed.map((app) => {
    const server = servers.get(app.serverId);
    const declaredEntry = server?.args?.[0];
    const pluginRootPrefix = `${pathTokens.pluginRoot}/`;
    const entry = entries.get(app.serverId) ??
      (declaredEntry?.startsWith(pluginRootPrefix) === true
        ? declaredEntry.slice(pluginRootPrefix.length)
        : undefined);
    if (server === undefined || entry === undefined) {
      throw new Error(`Web App ${JSON.stringify(app.app)} has no compiled MCP server entry.`);
    }
    return {
      allow: [...app.allow],
      app: app.app,
      args: server.args?.slice(1) ?? [],
      entry,
      env: { ...(server.env ?? {}) },
      ...(app.input === undefined ? {} : { input: structuredClone(app.input) }),
      name: app.appName,
      resourceUri: app.resourceUri,
      server: app.serverName,
      ...(app.tool === undefined ? {} : { tool: app.tool }),
    };
  }).sort((left, right) => left.app.localeCompare(right.app));
  return parseWebManifest({ apps, open: options.model.web.open });
};

const manifestFor = (options: {
  readonly artifactRoot: string;
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly files: ArtifactManifest['files'];
  readonly model: NormalizedPlugin;
  readonly projectContext: ProjectContext;
  readonly registry: TargetRegistry;
  readonly selected: readonly string[];
}): ArtifactManifest => {
  const targets = manifestTargets(options.registry, options.selected);
  const web = webManifestFor(options);
  return {
    agentSkills: agentSkillsSchemaRevision,
    files: options.files,
    producer: { name: 'agent-bundle', version: packageManifest.version },
    project: options.projectContext,
    runtime: { ...options.model.runtime },
    targets,
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: targets.map(({ name }) => ({ name, status: 'passed' })),
    },
    ...(web === undefined ? {} : { web }),
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
    const compileResults: CompileResult[] = [];
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
            compileResults.push(...views.compileResults);
            compileDiagnostics.push(...views.diagnostics);
          }
          break;
        case 'node-surfaces': {
          await emitPlanEntries({ entries: composite.entries, root: stageRoot });
          // Every agent-host surface of the root lowers through one Rslib
          // instance; each surface keeps its own evidence and result.
          const compiled = await compileRslibSurfaces(
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
          const [cliBins, scripts, hooks, mcpEntries] = compiled.results;
          compileResults.push(...compiled.compileResults);
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
    await writeHookIndex({
      artifactRoot: stageRoot,
      // Host-document wrapper variants stay out of the canonical index: it
      // keeps exactly one entry per hook and target, pointing at the
      // canonical wrapper their target contract simulates.
      hooks: compiledHooks.filter((entry) => entry.indexed !== false).map((entry) => ({
        event: entry.event,
        id: entry.id,
        name: entry.name,
        path: relative(stageRoot, entry.output).replaceAll('\\', '/'),
        target: entry.target,
        ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
      })),
    });
    const compileEvidence = await createCompileEvidenceRecord({
      results: compileResults,
      rewritable: options.tools?.rspack !== undefined || options.tools?.rsbuild !== undefined,
      root: stageRoot,
      rspackVersion: rspack.rspackVersion,
    });
    await writeCompileEvidence({ artifactRoot: stageRoot, evidence: compileEvidence });
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
        model: options.model,
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
        compiledMcpEntries,
        files,
        model: options.model,
        projectContext: options.projectContext,
        registry: options.registry,
        selected: composite.selected,
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
        ...(entry.executorOutput === undefined ? {} : { executorOutput: publishedOutput({ output: entry.executorOutput }) }),
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
      compileEvidence,
      diagnostics: deepFreeze(deduplicateDiagnostics(compileDiagnostics)),
      manifest,
      outputProvenance,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
