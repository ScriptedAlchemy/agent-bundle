import { resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import {
  compilerHookWrapperPath,
  generatedHookCommand,
  readTargetNativeHookCommands,
} from '../adapters/hook-contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { artifactDiagnostic as diagnostic } from './artifact-diagnostics.ts';
import { matchesManifestFile, pathInTargetOutputLayout, targetArtifactPath } from './artifact-layout.ts';
import {
  artifactHookIndexName,
  type ArtifactFile,
  type ArtifactHook,
  type ArtifactHookIndex,
} from './emit.ts';
import { parseArtifactHookIndex } from './hook-index.ts';
import type { ArtifactManifest } from './manifest.ts';

const readArtifactHookIndex = async (artifactRoot: string): Promise<ArtifactHookIndex | undefined> => {
  try {
    return parseArtifactHookIndex(await runWithPlatform(readFileString(resolve(artifactRoot, artifactHookIndexName))));
  } catch {
    return undefined;
  }
};

export const validateHookCoherence = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
  readonly hooks: ArtifactHook[];
}): Promise<readonly Diagnostic[]> => {
  const indexFile = options.files.find((file) => file.path === artifactHookIndexName);
  const index = indexFile === undefined ? undefined : await readArtifactHookIndex(options.artifactRoot);
  if (index === undefined) {
    return Object.freeze([diagnostic(
      'AB6018',
      'Artifact hook metadata is not strict canonical hook index data.',
      artifactHookIndexName,
      'artifact',
    )]);
  }

  options.hooks.push(...index.hooks);

  const diagnostics: Diagnostic[] = [];
  const files = new Map(options.files.map((file) => [file.path, file]));
  const manifestFiles = new Map(options.manifest.files.map((file) => [file.path, file]));
  const targets = new Set(options.manifest.targets.map((target) => target.name));
  const indexedByTarget = new Map<string, typeof index.hooks>();
  for (const hook of index.hooks) {
    const entries = indexedByTarget.get(hook.target) ?? [];
    indexedByTarget.set(hook.target, [...entries, hook]);
  }

  for (const hook of index.hooks) {
    if (!targets.has(hook.target) || (options.registry.has(hook.target) && !options.registry.supports(hook.target, 'hooks'))) {
      diagnostics.push(diagnostic(
        'AB6018',
        `Hook index entry ${JSON.stringify(hook.id)} selects undeclared or hook-incompatible target ${JSON.stringify(hook.target)}.`,
        artifactHookIndexName,
        hook.target,
      ));
      continue;
    }
    if (!options.registry.has(hook.target)) continue;
    const contract = options.registry.hookContract(hook.target);
    const layout = options.registry.artifactLayout(hook.target).hookWrappers;
    const expectedPrefix = `${hook.target}/`;
    const file = files.get(hook.path);
    const manifestFile = manifestFiles.get(hook.path);
    if (
      contract === undefined ||
      !hook.path.startsWith(expectedPrefix) ||
      !pathInTargetOutputLayout(hook.path, hook.target, layout) ||
      file === undefined ||
      manifestFile === undefined ||
      !matchesManifestFile(file, manifestFile)
    ) {
      diagnostics.push(diagnostic(
        'AB6018',
        `Hook index entry ${JSON.stringify(hook.id)} references missing or invalid target wrapper ${JSON.stringify(hook.path)}.`,
        hook.path,
        hook.target,
      ));
    }
  }

  for (const { name: target } of options.manifest.targets) {
    if (!options.registry.has(target) || !options.registry.supports(target, 'hooks')) continue;
    const contract = options.registry.hookContract(target);
    if (contract === undefined) continue;
    const hooks = indexedByTarget.get(target) ?? [];
    const manifestPath = targetArtifactPath(target, contract.manifestPath);
    if (!files.has(manifestPath)) {
      if (hooks.length === 0) continue;
      diagnostics.push(diagnostic(
        'AB6018',
        `Hook index target ${JSON.stringify(target)} is missing native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
        manifestPath,
        target,
      ));
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(await runWithPlatform(readFileString(resolve(options.artifactRoot, manifestPath))));
    } catch {
      diagnostics.push(diagnostic(
        'AB6018',
        `Hook index target ${JSON.stringify(target)} is missing native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
        manifestPath,
        target,
      ));
      continue;
    }
    const commands = readTargetNativeHookCommands(contract, document);
    if (commands.status === 'invalid') {
      diagnostics.push(diagnostic(
        'AB6018',
        `Native hook manifest ${JSON.stringify(contract.manifestPath)} for target ${JSON.stringify(target)} is invalid for command enumeration.`,
        manifestPath,
        target,
      ));
      continue;
    }
    const relativePaths = new Map<string, number>();
    for (const hook of hooks) {
      const relativePath = hook.path.slice(target.length + 1);
      relativePaths.set(relativePath, (relativePaths.get(relativePath) ?? 0) + 1);
      const command = generatedHookCommand(contract, relativePath);
      const occurrences = commands.commands.filter((candidate) => candidate.command === command).length;
      if (occurrences !== 1) {
        diagnostics.push(diagnostic(
          'AB6018',
          `Hook index entry ${JSON.stringify(hook.id)} requires exactly one native command ${JSON.stringify(command)} but found ${occurrences}.`,
          manifestPath,
          target,
        ));
      }
    }
    const wrapperLayout = options.registry.artifactLayout(target).hookWrappers;
    for (const command of commands.commands) {
      const relativePath = compilerHookWrapperPath(contract, command.command);
      if (relativePath === undefined) continue;
      // Only compiler wrapper outputs must be indexed. A prebuilt hook
      // command without arguments parses like a wrapper command but points
      // into its payload directory, outside the wrapper layout, and is
      // deliberately absent from the hook index (like native hooks).
      if (!pathInTargetOutputLayout(targetArtifactPath(target, relativePath), target, wrapperLayout)) continue;
      const entries = relativePaths.get(relativePath) ?? 0;
      if (entries === 1) continue;
      diagnostics.push(diagnostic(
        'AB6018',
        entries === 0
          ? `Native hook command ${JSON.stringify(command.command)} is not indexed.`
          : `Native hook command ${JSON.stringify(command.command)} is indexed multiple times.`,
        manifestPath,
        target,
      ));
    }
  }
  return Object.freeze(diagnostics);
};
