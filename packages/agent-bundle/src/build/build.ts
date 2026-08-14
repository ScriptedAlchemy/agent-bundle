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
  planCompiledEntries,
  planCompiledHooks,
  type CompiledEntry,
  type CompiledHookEntry,
} from './entries.ts';
import {
  assertUniqueArtifactDestinations,
  emitPlanEntries,
  publishArtifact,
  resolveArtifactDestination,
  writeManifest,
  type ArtifactManifest,
} from './emit.ts';
import { validateArtifact } from './validate-artifact.ts';

export interface BuildResult {
  readonly compiledEntries: readonly CompiledEntry[];
  readonly compiledHooks: readonly CompiledHookEntry[];
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
      return { ...target, compiledEntries, compiledHooks, root };
    });
    assertUniqueArtifactDestinations(
      stagedTargets.flatMap((target) => [
        ...target.entries.map((entry) =>
          resolveArtifactDestination(target.root, entry.relativePath),
        ),
        ...target.compiledEntries.map((entry) => entry.output),
        ...target.compiledHooks.map((entry) => entry.output),
      ]),
    );

    const compiledEntries: CompiledEntry[] = [];
    const compiledHooks: CompiledHookEntry[] = [];
    for (const target of stagedTargets) {
      await emitPlanEntries({ entries: target.entries, root: target.root });
      compiledEntries.push(
        ...(await compileEntries(
          options.model.scripts.filter((script) => script.targets.includes(target.name)),
          { cwd: options.projectRoot, outDir: target.root },
        )),
      );
      compiledHooks.push(...(await compileHooks(target.hookEntries, { cwd: options.projectRoot, outDir: target.root })));
    }
    const publishedCompiledEntries = Object.freeze(compiledEntries.map((entry) =>
      Object.freeze({
        ...entry,
        output: assertInside(outputRoot, resolve(outputRoot, relative(stageRoot, entry.output))),
      }),
    ));
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
      manifest,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
