import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import { deduplicateDiagnostics, DiagnosticBag, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type { ProjectContext } from '../core/project-context.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { assertInside } from '../core/paths.ts';
import { agentSkillsSchemaRevision } from '../schemas/agent-skills/contract.ts';
import {
  compileEntries,
  compileHooks,
  compileMcpEntries,
  planCompiledEntries,
  planCompiledHooks,
  planCompiledMcpEntries,
  type CompiledEntry,
  type CompiledHookEntry,
  type CompiledMcpEntry,
} from './entries.ts';
import { compileMcpApps, planCompiledMcpApps, type CompiledMcpApp } from './mcp-apps.ts';
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

declare const __AGENT_BUNDLE_VERSION__: string;

export interface BuildResult {
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
}

interface PlannedTarget {
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly import('../adapters/types.ts').TargetHookEntry[];
  readonly name: string;
}

interface StagedTarget extends PlannedTarget {
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly root: string;
}

const planTargets = (options: BuildOptions): readonly PlannedTarget[] => {
  const diagnostics: Diagnostic[] = [];
  const planned: PlannedTarget[] = [];

  for (const target of options.model.targets) {
    const adapter = options.registry.get(target.name);
    diagnostics.push(...adapter.validateModel(options.model));
    const plan = adapter.plan(options.model);
    diagnostics.push(...plan.diagnostics);
    const hookEntries = plan.hookEntries ?? Object.freeze([]);
    for (const hookEntry of hookEntries) {
      if (hookEntry.target !== target.name) {
        diagnostics.push({
          code: 'AB5000',
          message: `Target adapter ${JSON.stringify(target.name)} planned hook ${JSON.stringify(hookEntry.hook.id)} for target ${JSON.stringify(hookEntry.target)}, expected ${JSON.stringify(target.name)}.`,
          severity: 'error',
          target: target.name,
        });
      }
    }
    planned.push({
      entries: plan.entries,
      hookEntries,
      name: target.name,
    });
  }
  new DiagnosticBag(deduplicateDiagnostics(diagnostics)).throwIfErrors();
  return planned;
};

const planStagedTargets = (options: {
  readonly artifactRoot: string;
  readonly model: NormalizedPlugin;
  readonly projectRoot: string;
  readonly targets: readonly PlannedTarget[];
}): readonly StagedTarget[] => options.targets.map((target) => {
  const root = assertInside(options.artifactRoot, resolve(options.artifactRoot, target.name));
  const scripts = options.model.scripts.filter((script) => script.targets.includes(target.name));
  const compiledEntries = planCompiledEntries(scripts, { cwd: options.projectRoot, outDir: root });
  const compiledHooks = planCompiledHooks(target.hookEntries, { outDir: root });
  const compiledMcpApps = planCompiledMcpApps(options.model.mcpApps ?? [], {
    outDir: root,
    target: target.name,
  });
  const compiledMcpEntries = planCompiledMcpEntries(options.model.mcpServers, {
    outDir: root,
    target: target.name,
  });
  return { ...target, compiledEntries, compiledHooks, compiledMcpApps, compiledMcpEntries, root };
});

const plannedDestinations = (targets: readonly StagedTarget[]): readonly string[] =>
  targets.flatMap((target) => [
    ...target.entries.map((entry) =>
      resolveArtifactDestination(target.root, entry.relativePath),
    ),
    ...target.compiledEntries.map((entry) => entry.output),
    ...target.compiledHooks.map((entry) => entry.output),
    ...target.compiledMcpApps.map((entry) => entry.output),
    ...target.compiledMcpEntries.map((entry) => entry.output),
  ]);

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
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly model: NormalizedPlugin;
  readonly targets: readonly StagedTarget[];
}): readonly ArtifactOutputCandidate[] => [
  ...options.targets.flatMap((target) => target.entries.map((entry) => ({
    kind: entry.kind === 'copy' ? 'copy' as const : 'generated' as const,
    path: resolveArtifactDestination(target.root, entry.relativePath),
    sourceInputs: entry.sourceInputs,
  }))),
  ...options.compiledEntries.map((entry) => ({
    kind: entry.outputKind,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  })),
  ...options.compiledHooks.map((entry) => ({
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  })),
  ...options.compiledMcpApps.map((entry) => ({
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  })),
  ...options.compiledMcpEntries.map((entry) => ({
    kind: 'bundle' as const,
    path: entry.output,
    sourceInputs: entry.sourceInputs,
  })),
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

const manifestTargets = (
  registry: TargetRegistry,
  targets: readonly StagedTarget[],
): ArtifactManifest['targets'] => Object.freeze(targets
  .map(({ name }) => {
    const metadata = registry.metadata(name);
    return Object.freeze({
      adapterRevision: metadata.adapterRevision,
      capabilityRevision: metadata.capabilityRevision,
      capabilitySha256: metadata.capabilitySha256,
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
  readonly targets: readonly StagedTarget[];
}): ArtifactManifest => {
  const targets = manifestTargets(options.registry, options.targets);
  return {
    agentSkills: agentSkillsSchemaRevision,
    files: options.files,
    producer: { name: 'agent-bundle', version: __AGENT_BUNDLE_VERSION__ },
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
  const planned = planTargets(options);
  const outputRoot = resolve(options.outputRoot);
  const preflightTargets = planStagedTargets({
    artifactRoot: outputRoot,
    model: options.model,
    projectRoot: options.projectRoot,
    targets: planned,
  });
  assertUniqueArtifactDestinations(plannedDestinations(preflightTargets));
  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));
  const publishedOutput = (entry: { readonly output: string }): string =>
    assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output)));

  try {
    const stagedTargets = planStagedTargets({
      artifactRoot: stageRoot,
      model: options.model,
      projectRoot: options.projectRoot,
      targets: planned,
    });
    assertUniqueArtifactDestinations(plannedDestinations(stagedTargets));

    const compiledEntries: CompiledEntry[] = [];
    const compiledHooks: CompiledHookEntry[] = [];
    const compiledMcpApps: CompiledMcpApp[] = [];
    const compiledMcpEntries: CompiledMcpEntry[] = [];
    for (const target of stagedTargets) {
      const targetMcpApps = await compileMcpApps(options.model.mcpApps ?? [], {
        cwd: options.projectRoot,
        outDir: target.root,
        target: target.name,
      });
      compiledMcpApps.push(...targetMcpApps);
      await emitPlanEntries({ entries: target.entries, root: target.root });
      compiledEntries.push(
        ...(await compileEntries(
          options.model.scripts.filter((script) => script.targets.includes(target.name)),
          { cwd: options.projectRoot, outDir: target.root },
        )),
      );
      compiledHooks.push(...(await compileHooks(target.hookEntries, { cwd: options.projectRoot, outDir: target.root })));
      compiledMcpEntries.push(...(await compileMcpEntries(options.model.mcpServers, {
        apps: targetMcpApps,
        cwd: options.projectRoot,
        outDir: target.root,
        target: target.name,
      })));
    }
    const publishedCompiledEntries = Object.freeze(compiledEntries.map((entry) =>
      Object.freeze({
        ...entry,
        output: publishedOutput(entry),
      }),
    ));
    await writeHookIndex({
      artifactRoot: stageRoot,
      hooks: compiledHooks.map((entry) => ({
        event: entry.event,
        id: entry.id,
        name: entry.name,
        path: relative(stageRoot, entry.output).replaceAll('\\', '/'),
        target: entry.target,
        ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
      })),
    });
    const outputProvenance = createOutputProvenance({
      artifactRoot: stageRoot,
      outputs: outputCandidatesFor({
        artifactRoot: stageRoot,
        compiledEntries,
        compiledHooks,
        compiledMcpApps,
        compiledMcpEntries,
        model: options.model,
        targets: stagedTargets,
      }),
      projectRoot: options.projectRoot,
    });
    assertOutputProvenanceSources({ outputProvenance, projectContext: options.projectContext });
    const files = createArtifactManifestFiles({
      files: await listArtifactFiles(stageRoot),
      outputProvenance,
    });
    const preManifestDiagnostics = await validateArtifactFiles({ artifactRoot: stageRoot });
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
        targets: stagedTargets,
      }),
    });
    const diagnostics = await validateArtifact({ artifactRoot: stageRoot, registry: options.registry });
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      throw new DiagnosticError(diagnostics);
    }
    await publishArtifact({ outputRoot, stageRoot });
    return Object.freeze({
      compiledEntries: publishedCompiledEntries,
      compiledHooks: Object.freeze(compiledHooks.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
      }))),
      compiledMcpApps: Object.freeze(compiledMcpApps.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
      }))),
      compiledMcpEntries: Object.freeze(compiledMcpEntries.map((entry) => Object.freeze({
        ...entry,
        output: publishedOutput(entry),
      }))),
      manifest,
      outputProvenance,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
