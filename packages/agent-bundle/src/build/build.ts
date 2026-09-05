import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import packageManifest from '../../package.json' with { type: 'json' };

import type { ArtifactRootContracts, TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactEntry, TargetHookEntry } from '../adapters/types.ts';
import { deduplicateDiagnostics, DiagnosticBag, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
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
import {
  cliBinCollisionDiagnostics,
  planCliBinsSurface,
  planCompiledCliBins,
  targetHostsCliBin,
  type CompiledCliBin,
} from './cli-bins.ts';
import { projectMeta } from './meta.ts';
import { compileMcpApps, planCompiledMcpApps, type CompiledMcpApp } from './mcp-apps.ts';
import { compileRslibSurfaces, settledRslibSurface } from './rslib.ts';
import { planTargetStages } from './target-stages.ts';
import {
  assertUniqueArtifactDestinations,
  artifactHookIndexName,
  createArtifactManifestFiles,
  emitPlanEntries,
  listArtifactFiles,
  publishArtifact,
  resolveArtifactDestination,
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


export interface BuildResult {
  /** The routed-CLI executables emitted into host artifacts (#387), one per hosting target. */
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly manifest: ArtifactManifest;
  readonly outputProvenance: readonly ArtifactOutputProvenance[];
  readonly outputRoot: string;
}

export interface BuildOptions {
  readonly model: NormalizedPlugin;
  readonly outputRoot: string;
  readonly projectContext: ProjectContext;
  readonly projectRoot: string;
  readonly registry: TargetRegistry;
  /** The consumer bundler escape hatch, applied to every synthesized config. */
  readonly tools?: AgentBundleToolsConfig;
}

/**
 * The one plugin root a build emits (#555): every selected target's projection
 * planned into the same directory. A single target is its adapter's plan; two
 * or more are composed by the registry's root contracts.
 */
interface PlannedRoot {
  /** True when any projected host publishes the `cli` capability, admitting the routed CLI bin. */
  readonly cliBin: boolean;
  readonly contracts: ArtifactRootContracts;
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
  /** The root's identity: the host name, or the composite name of several hosts. */
  readonly name: string;
  /** The projected hosts, in the order the model selected them. */
  readonly targets: readonly string[];
}

interface StagedRoot extends PlannedRoot {
  readonly compiledCliBins: readonly CompiledCliBin[];
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
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

const planRoot = (options: BuildOptions): PlannedRoot => {
  const diagnostics: Diagnostic[] = [];
  const targets = options.model.targets.map((target) => target.name);
  const contracts = options.registry.root(targets);
  const plan = contracts.adapter.plan(options.model);
  diagnostics.push(...plan.diagnostics);
  const hookEntries = plan.hookEntries ?? Object.freeze([]);
  for (const hookEntry of hookEntries) {
    const served = hookEntry.hosts ?? [hookEntry.target];
    const foreign = served.filter((host) => !targets.includes(host));
    if (foreign.length > 0) {
      diagnostics.push({
        code: 'AB5000',
        message: `Plugin root ${JSON.stringify(contracts.name)} planned hook ${JSON.stringify(hookEntry.hook.id)} for ${JSON.stringify(foreign)}, which it does not project.`,
        severity: 'error',
      });
    }
  }
  const cliBin = targets.some((target) => targetHostsCliBin(options.registry, target));
  if (cliBin) diagnostics.push(...cliBinCollisionDiagnostics(options.model, contracts.name, plan.entries));
  new DiagnosticBag(deduplicateDiagnostics(diagnostics)).throwIfErrors();
  return Object.freeze({ cliBin, contracts, entries: plan.entries, hookEntries, name: contracts.name, targets });
};

const planStagedRoot = (options: {
  readonly artifactRoot: string;
  readonly model: NormalizedPlugin;
  readonly planned: PlannedRoot;
  readonly projectRoot: string;
}): StagedRoot => {
  const { planned } = options;
  const root = options.artifactRoot;
  const selection = { hosts: planned.targets, target: planned.name };
  const scripts = options.model.scripts.filter((script) => script.targets.some((target) => planned.targets.includes(target)));
  const compiledEntries = planCompiledEntries(scripts, { cwd: options.projectRoot, outDir: root });
  const compiledHooks = planCompiledHooks(planned.hookEntries, { outDir: root });
  const compiledMcpApps = planCompiledMcpApps(options.model.mcpApps ?? [], { outDir: root, ...selection });
  const compiledMcpEntries = planCompiledMcpEntries(options.model.mcpServers, { outDir: root, ...selection });
  const compiledCliBins = planned.cliBin
    ? planCompiledCliBins(options.model, { outDir: root, target: planned.name })
    : Object.freeze([]);
  return { ...planned, compiledCliBins, compiledEntries, compiledHooks, compiledMcpApps, compiledMcpEntries, root };
};

const plannedDestinations = (staged: StagedRoot): readonly string[] => [
  ...staged.entries.map((entry) => resolveArtifactDestination(staged.root, entry.relativePath)),
  ...staged.compiledCliBins.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
  ...staged.compiledEntries.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
  ...staged.compiledHooks.flatMap((entry) => [entry.output, ...(entry.workerOutput === undefined ? [] : [entry.workerOutput])]),
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
  readonly model: NormalizedPlugin;
  readonly staged: StagedRoot;
}): readonly ArtifactOutputCandidate[] => [
  ...options.staged.entries.map((entry) => ({
    kind: entry.kind !== 'copy'
      ? 'generated' as const
      : entry.prebuilt === true ? 'prebuilt' as const : 'copy' as const,
    path: resolveArtifactDestination(options.staged.root, entry.relativePath),
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
  {
    kind: 'generated' as const,
    path: resolveArtifactDestination(options.artifactRoot, artifactHookIndexName),
    sourceInputs: hookIndexSourceInputs(options.model, options.compiledHooks),
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

/** The manifest names the real host projections of the root, never the composite identity. */
const manifestTargets = (
  registry: TargetRegistry,
  targets: readonly string[],
): ArtifactManifest['targets'] => Object.freeze(targets
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

const manifestFor = (options: {
  readonly files: ArtifactManifest['files'];
  readonly model: NormalizedPlugin;
  readonly projectContext: ProjectContext;
  readonly registry: TargetRegistry;
  readonly targets: readonly string[];
}): ArtifactManifest => {
  const targets = manifestTargets(options.registry, options.targets);
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
  };
};

export const build = async (options: BuildOptions): Promise<BuildResult> => {
  const outputRoot = resolve(options.outputRoot);
  const payloadDiagnostics = prebuiltPayloadDiagnostics(options.model, outputRoot);
  if (payloadDiagnostics.length > 0) throw new DiagnosticError(payloadDiagnostics);
  const planned = planRoot(options);
  const preflight = planStagedRoot({
    artifactRoot: outputRoot,
    model: options.model,
    planned,
    projectRoot: options.projectRoot,
  });
  assertUniqueArtifactDestinations(plannedDestinations(preflight));
  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  const publishedOutput = (entry: { readonly output: string }): string =>
    assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output)));

  try {
    const staged = planStagedRoot({
      artifactRoot: stageRoot,
      model: options.model,
      planned,
      projectRoot: options.projectRoot,
    });
    assertUniqueArtifactDestinations(plannedDestinations(staged));

    const compiledCliBins: CompiledCliBin[] = [];
    const compiledEntries: CompiledEntry[] = [];
    const compiledHooks: CompiledHookEntry[] = [];
    const compiledMcpApps: CompiledMcpApp[] = [];
    const compiledMcpEntries: CompiledMcpEntry[] = [];
    const tools = options.tools === undefined ? {} : { tools: options.tools };
    // The resolved `notices.retention`; generated ledgers fall back to the runtime defaults without it.
    const noticePolicy = options.model.notices === undefined
      ? {}
      : { noticeRetention: options.model.notices.retention.resolved };
    // One identity feeds every compiled surface, exactly the identity the
    // manifest, `inspect`, and dev status report (issue #237).
    const meta = projectMeta(options.model.metadata);
    const plugin = { name: options.model.metadata.name, version: options.model.metadata.version };
    const selection = { hosts: staged.targets, target: staged.name };
    let rootMcpApps: readonly CompiledMcpApp[] = Object.freeze([]);
    for (const stage of planTargetStages(staged)) {
      switch (stage.kind) {
        case 'mcp-apps':
          // The optional browser stage, always first: the MCP entries embed
          // its HTML, and its Rsbuild pass asserts the root holds nothing but
          // that HTML.
          rootMcpApps = await compileMcpApps(options.model.mcpApps ?? [], {
            cwd: options.projectRoot,
            meta,
            outDir: staged.root,
            ...selection,
            ...tools,
          });
          compiledMcpApps.push(...rootMcpApps);
          break;
        case 'node-surfaces': {
          await emitPlanEntries({ entries: staged.entries, root: staged.root });
          // The generated entries serve every projected host, so they wire
          // only the cross-request routes all of them advertise.
          const noticeDelivery = staged.contracts.noticeDelivery;
          // Every agent-host surface of the root lowers through one Rslib
          // instance; each surface keeps its own evidence and result.
          const [cliBins, scripts, hooks, mcpEntries] = await compileRslibSurfaces(
            { cwd: options.projectRoot, meta, outputRoot: staged.root, ...tools },
            [
              staged.cliBin
                ? planCliBinsSurface(options.model, { outDir: staged.root, target: staged.name })
                : settledRslibSurface<readonly CompiledCliBin[]>(Object.freeze([])),
              await planScriptsSurface(
                options.model.scripts.filter((script) => script.targets.some((target) => staged.targets.includes(target))),
                {
                  cwd: options.projectRoot,
                  layouts: options.model.layouts ?? [],
                  outDir: staged.root,
                  ...noticePolicy,
                  providers: options.model.providers ?? [],
                  ...(options.model.state === undefined ? {} : { state: options.model.state }),
                },
              ),
              planHooksSurface(staged.hookEntries, {
                artifactEpoch: options.projectContext.revision,
                ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
                ...noticePolicy,
                outDir: staged.root,
                plugin,
                providers: options.model.providers ?? [],
                ...(options.model.state === undefined ? {} : { state: options.model.state }),
              }),
              await planMcpEntriesSurface(options.model.mcpServers, {
                apps: rootMcpApps,
                artifactEpoch: options.projectContext.revision,
                eventHooks: staged.hookEntries
                  .filter((entry) => entry.hook.eventRoute !== undefined)
                  .map((entry) => entry.hook),
                layouts: options.model.layouts ?? [],
                ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
                ...noticePolicy,
                outDir: staged.root,
                plugin,
                providers: options.model.providers ?? [],
                ...(options.model.state === undefined ? {} : { state: options.model.state }),
                ...selection,
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
          throw new Error(`Unknown target compile stage ${JSON.stringify(exhaustive)}.`);
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
      // keeps exactly one entry per hook and host projection, pointing at the
      // canonical wrapper that host's contract simulates. One wrapper shared
      // by several hosts is listed once per host it serves (#555).
      hooks: compiledHooks
        .filter((entry) => entry.indexed !== false)
        .flatMap((entry) => (entry.hosts ?? [entry.target]).map((target) => ({
          event: entry.event,
          id: entry.id,
          name: entry.name,
          path: relative(stageRoot, entry.output).replaceAll('\\', '/'),
          target,
          ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
        }))),
    });
    const outputProvenance = createOutputProvenance({
      artifactRoot: stageRoot,
      outputs: outputCandidatesFor({
        artifactRoot: stageRoot,
        compiledCliBins,
        compiledEntries,
        compiledHooks,
        compiledMcpApps,
        compiledMcpEntries,
        model: options.model,
        staged,
      }),
      projectRoot: options.projectRoot,
    });
    assertOutputProvenanceSources({ outputProvenance, projectContext: options.projectContext });
    const files = createArtifactManifestFiles({
      files: await listArtifactFiles(stageRoot),
      outputProvenance,
    });
    // The bundler's own output is trusted to the ESM lexer; once a consumer
    // hatch can rewrite emitted assets (a banner, a processAssets pass), the
    // final bytes are no longer the bundler's proof and are parsed in full.
    const bundleSyntaxCheck = options.tools?.rspack === undefined && options.tools?.rsbuild === undefined
      ? 'lexed'
      : 'parsed';
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
        files,
        model: options.model,
        projectContext: options.projectContext,
        registry: options.registry,
        targets: staged.targets,
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
      manifest,
      outputProvenance,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
