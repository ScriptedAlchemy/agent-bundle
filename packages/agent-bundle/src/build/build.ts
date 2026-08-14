import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import { DiagnosticBag, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { assertInside } from '../core/paths.ts';
import { compileEntries, planCompiledEntries, type CompiledEntry } from './entries.ts';
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
  readonly name: string;
}

interface StagedTarget extends PlannedTarget {
  readonly compiledEntries: readonly CompiledEntry[];
  readonly root: string;
}

const planTargets = (options: BuildOptions): readonly PlannedTarget[] => {
  const diagnostics: Diagnostic[] = [];
  const planned: PlannedTarget[] = [];

  for (const target of options.model.targets) {
    const adapter = options.registry.get(target.name);
    const plan = adapter.plan(options.model);
    diagnostics.push(...plan.diagnostics);
    planned.push({ entries: plan.entries, name: target.name });
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
      return { ...target, compiledEntries, root };
    });
    assertUniqueArtifactDestinations(
      stagedTargets.flatMap((target) => [
        ...target.entries.map((entry) =>
          resolveArtifactDestination(target.root, entry.relativePath),
        ),
        ...target.compiledEntries.map((entry) => entry.output),
      ]),
    );

    const compiledEntries: CompiledEntry[] = [];
    for (const target of stagedTargets) {
      await emitPlanEntries({ entries: target.entries, root: target.root });
      compiledEntries.push(
        ...(await compileEntries(
          options.model.scripts.filter((script) => script.targets.includes(target.name)),
          { cwd: options.projectRoot, outDir: target.root },
        )),
      );
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
      manifest,
      outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
