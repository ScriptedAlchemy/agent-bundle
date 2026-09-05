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
import { isDirectOutputLayoutPath, matchesManifestFile } from './artifact-layout.ts';
import type { ArtifactFile } from './emit.ts';
import { artifactManifestName, type ArtifactManifest, type ArtifactManifestHook } from './manifest.ts';

/**
 * Proves the manifest's `executables.hooks[]` rows (#592 step 3) and the host
 * hooks documents describe the same wrappers: every row names an emitted
 * wrapper of a hook-capable selected projection, and every compiler wrapper a
 * host document runs is exactly one row.
 */
export const validateHookCoherence = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
}): Promise<readonly Diagnostic[]> => {
  const rows = options.manifest.executables.hooks;
  const diagnostics: Diagnostic[] = [];
  const files = new Map(options.files.map((file) => [file.path, file]));
  const manifestFiles = new Map(options.manifest.files.map((file) => [file.path, file]));
  const targets = new Set(options.manifest.projections.map((projection) => projection.host));
  const indexedByTarget = new Map<string, readonly ArtifactManifestHook[]>();
  for (const hook of rows) {
    const entries = indexedByTarget.get(hook.host) ?? [];
    indexedByTarget.set(hook.host, [...entries, hook]);
  }

  for (const hook of rows) {
    if (!targets.has(hook.host) || (options.registry.has(hook.host) && !options.registry.supports(hook.host, 'hooks'))) {
      diagnostics.push(diagnostic(
        'AB6018',
        `Manifest hook row ${JSON.stringify(hook.id)} selects undeclared or hook-incompatible projection ${JSON.stringify(hook.host)}.`,
        artifactManifestName,
        hook.host,
      ));
      continue;
    }
    if (!options.registry.has(hook.host)) continue;
    const contract = options.registry.hookContract(hook.host);
    const layout = options.registry.artifactLayout(hook.host).hookWrappers;
    const file = files.get(hook.path);
    const manifestFile = manifestFiles.get(hook.path);
    if (
      contract === undefined ||
      !isDirectOutputLayoutPath(hook.path, layout) ||
      file === undefined ||
      manifestFile === undefined ||
      !matchesManifestFile(file, manifestFile)
    ) {
      diagnostics.push(diagnostic(
        'AB6018',
        `Manifest hook row ${JSON.stringify(hook.id)} references missing or invalid target wrapper ${JSON.stringify(hook.path)}.`,
        hook.path,
        hook.host,
      ));
    }
  }

  for (const { host: target } of options.manifest.projections) {
    if (!options.registry.has(target) || !options.registry.supports(target, 'hooks')) continue;
    const contract = options.registry.hookContract(target);
    if (contract === undefined) continue;
    const hooks = indexedByTarget.get(target) ?? [];
    // Every selected host's document lives at its contract path inside the
    // one composite root; the wrappers it names are the host's own (#555).
    const manifestPath = contract.manifestPath;
    if (!files.has(manifestPath)) {
      if (hooks.length === 0) continue;
      diagnostics.push(diagnostic(
        'AB6018',
        `Manifest hook rows for ${JSON.stringify(target)} have no native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
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
        `Manifest hook rows for ${JSON.stringify(target)} have no native hook manifest ${JSON.stringify(contract.manifestPath)}.`,
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
      const relativePath = hook.path;
      relativePaths.set(relativePath, (relativePaths.get(relativePath) ?? 0) + 1);
      const command = generatedHookCommand(contract, relativePath);
      const occurrences = commands.commands.filter((candidate) => candidate.command === command).length;
      if (occurrences !== 1) {
        diagnostics.push(diagnostic(
          'AB6018',
          `Manifest hook row ${JSON.stringify(hook.id)} requires exactly one native command ${JSON.stringify(command)} but found ${occurrences}.`,
          manifestPath,
          target,
        ));
      }
    }
    const wrapperLayout = options.registry.artifactLayout(target).hookWrappers;
    for (const command of commands.commands) {
      const relativePath = compilerHookWrapperPath(contract, command.command);
      if (relativePath === undefined) continue;
      // Only compiler wrapper outputs are rows. A prebuilt hook command
      // without arguments parses like a wrapper command but points into its
      // payload directory, outside the wrapper layout, and is deliberately
      // absent from the manifest rows (like native hooks).
      if (!isDirectOutputLayoutPath(relativePath, wrapperLayout)) continue;
      const entries = relativePaths.get(relativePath) ?? 0;
      if (entries === 1) continue;
      diagnostics.push(diagnostic(
        'AB6018',
        entries === 0
          ? `Native hook command ${JSON.stringify(command.command)} has no manifest hook row.`
          : `Native hook command ${JSON.stringify(command.command)} has several manifest hook rows.`,
        manifestPath,
        target,
      ));
    }
  }
  return Object.freeze(diagnostics);
};
