import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import { DiagnosticBag, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { assertInside } from '../core/paths.ts';
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
  emitPlanEntries,
  publishArtifact,
  resolveArtifactDestination,
  writeHookIndex,
  writeManifest,
  type ArtifactManifest,
} from './emit.ts';
import { validateArtifact } from './validate-artifact.ts';

export interface BuildResult {
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
  readonly compiledMcpApps: readonly CompiledMcpApp[];
  readonly compiledMcpEntries: readonly CompiledMcpEntry[];
  readonly manifest: ArtifactManifest;
  readonly outputRoot: string;
}

export interface BuildOptions {
  readonly model: NormalizedPlugin;
  readonly outputRoot: string;
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
    const plan = adapter.plan(options.model);
    diagnostics.push(...plan.diagnostics);
    planned.push({
      entries: plan.entries,
      hookEntries: plan.hookEntries ?? Object.freeze([]),
      name: target.name,
    });
  }
  new DiagnosticBag(diagnostics).throwIfErrors();
  return planned;
};

export const build = async (options: BuildOptions): Promise<BuildResult> => {
  const planned = planTargets(options);
  const outputRoot = resolve(options.outputRoot);
  const stageParent = dirname(outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(outputRoot)}.stage-`));

  try {
    const stagedTargets: StagedTarget[] = planned.map((target) => {
      const root = assertInside(stageRoot, resolve(stageRoot, target.name));
      const compiledEntries = planCompiledEntries(
        options.model.scripts.filter((script) => script.targets.includes(target.name)),
        { cwd: options.projectRoot, outDir: root },
      );
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
    assertUniqueArtifactDestinations(
      stagedTargets.flatMap((target) => [
        ...target.entries.map((entry) =>
          resolveArtifactDestination(target.root, entry.relativePath),
        ),
        ...target.compiledEntries.map((entry) => entry.output),
        ...target.compiledHooks.map((entry) => entry.output),
        ...target.compiledMcpApps.map((entry) => entry.output),
        ...target.compiledMcpEntries.map((entry) => entry.output),
      ]),
    );

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
        output: assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output))),
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
    const manifest = await writeManifest({
      artifactRoot: stageRoot,
      targets: stagedTargets.map((target) => target.name),
    });
    const diagnostics = await validateArtifact({ artifactRoot: stageRoot });
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      throw new DiagnosticError(diagnostics);
    }
    await publishArtifact({ outputRoot, stageRoot });
    return Object.freeze({
      compiledEntries: publishedCompiledEntries,
      compiledHooks: Object.freeze(compiledHooks.map((entry) => Object.freeze({
        ...entry,
        output: assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output))),
      }))),
      compiledMcpApps: Object.freeze(compiledMcpApps.map((entry) => Object.freeze({
        ...entry,
        output: assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output))),
      }))),
      compiledMcpEntries: Object.freeze(compiledMcpEntries.map((entry) => Object.freeze({
        ...entry,
        output: assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output))),
      }))),
      manifest,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
