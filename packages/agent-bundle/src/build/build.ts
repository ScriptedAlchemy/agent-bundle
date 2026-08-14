import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import { DiagnosticBag, DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { compileEntries, type CompiledEntry } from './entries.ts';
import { emitPlanEntries, publishArtifact, writeManifest, type ArtifactManifest } from './emit.ts';
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
  const stageParent = dirname(options.outputRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(options.outputRoot)}.stage-`));

  try {
    const compiledEntries: CompiledEntry[] = [];
    for (const target of planned) {
      const targetRoot = join(stageRoot, target.name);
      await emitPlanEntries({ entries: target.entries, root: targetRoot });
      compiledEntries.push(
        ...(await compileEntries(
          options.model.scripts.filter((script) => script.targets.includes(target.name)),
          { cwd: options.projectRoot, outDir: targetRoot },
        )),
      );
    }
    const manifest = await writeManifest({
      artifactRoot: stageRoot,
      targets: planned.map((target) => target.name),
    });
    const diagnostics = await validateArtifact({ artifactRoot: stageRoot });
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      throw new DiagnosticError(diagnostics);
    }
    await publishArtifact({ outputRoot: options.outputRoot, stageRoot });
    return Object.freeze({
      compiledEntries: Object.freeze(compiledEntries),
      manifest,
      outputRoot: options.outputRoot,
    });
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
};
