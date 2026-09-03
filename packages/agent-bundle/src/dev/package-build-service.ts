import { rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { toPosixRelative } from '../core/paths.ts';

import { buildPackageOutputs } from '../build/package-build.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import type { PreparedProject } from './project-service.ts';
import type { Invalidation } from './types.ts';

/**
 * Dev-watch parity for the framework-owned package build (RFC #50 §3.5):
 * `agent-bundle dev` rebuilds `dist/` bin and lib outputs inside the same
 * debounced, serialized rebuild pass that produces artifact epochs. The
 * incremental boundary is provenance-based: a rebuild is skipped only when
 * no invalidated path was an input of the previous successful package build
 * (every bundled module, recorded from bundler stats) and the rebuild
 * identity — the normalized `bin`/`lib` declaration plus the `tools` escape
 * hatch (functions compared by source text) — is unchanged. Changes the
 * bundler cannot attribute to a tracked input — the project configuration
 * file, `package.json`, `tsconfig.json`, manual and initial invalidations,
 * or any previous failure — always rebuild.
 *
 * When every package entry disappears within a live session (entries removed
 * or opted out with `bin: false` / `lib: false`), the outputs this session
 * previously published are removed so `dist/` never serves executables the
 * configuration no longer declares. Outputs published by earlier sessions
 * are untouched, matching `agent-bundle build`.
 *
 * A package build failure never invalidates the artifact epoch that already
 * committed; it surfaces as one AB7103 warning on the succeeded attempt.
 */

export type DevPackageBuildState = 'absent' | 'built' | 'failed' | 'removed' | 'skipped';

export interface DevPackageBuildOutcome {
  readonly diagnostics: readonly Diagnostic[];
  readonly state: DevPackageBuildState;
}

export interface DevPackageBuilder {
  build(prepared: PreparedProject, invalidation: Invalidation): Promise<DevPackageBuildOutcome>;
}

export interface DevPackageBuildServiceOptions {
  /** Injectable only for deterministic unit tests. */
  readonly buildOutputs?: typeof buildPackageOutputs;
}

/** Files that change the package build without appearing in bundle provenance. */
const configurationInputs = new Set(['package.json', 'tsconfig.json']);

const emptyDiagnostics: readonly Diagnostic[] = Object.freeze([]);

const outcome = (
  state: DevPackageBuildState,
  diagnostics: readonly Diagnostic[] = emptyDiagnostics,
): DevPackageBuildOutcome => Object.freeze({ diagnostics, state });

const warning = (message: string, sourcePath: string): Diagnostic => Object.freeze({
  code: 'AB7103',
  message,
  severity: 'warning' as const,
  sourcePath,
});

/**
 * The `tools` hatch participates in the rebuild identity so a hatch edit in
 * the configuration graph rebuilds `dist/` even when no tracked source input
 * changed. Functions (rspack mutators) compare by their source text, which
 * the fresh per-preparation config evaluation keeps current.
 */
const toolsIdentity = (value: unknown): unknown => {
  if (typeof value === 'function') return String(value);
  if (Array.isArray(value)) return value.map((item) => toolsIdentity(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, toolsIdentity(item)]));
  }
  return value;
};

const relativePosix = toPosixRelative;

export class DevPackageBuildService implements DevPackageBuilder {
  readonly #buildOutputs: typeof buildPackageOutputs;
  #last: Readonly<{
    identity: string;
    inputs: ReadonlySet<string>;
    succeeded: boolean;
  }> | undefined;
  /** The outputs this session last published, for removal when the package build disappears. */
  #published: Readonly<{ outputRoot: string; paths: readonly string[] }> | undefined;

  constructor(options: DevPackageBuildServiceOptions = {}) {
    this.#buildOutputs = options.buildOutputs ?? buildPackageOutputs;
  }

  async build(prepared: PreparedProject, invalidation: Invalidation): Promise<DevPackageBuildOutcome> {
    const model = prepared.model;
    if (model?.packageBuild === undefined) {
      this.#last = undefined;
      return this.#removePublishedOutputs(prepared.configPath);
    }
    const identity = digest({
      packageBuild: model.packageBuild,
      tools: prepared.tools === undefined ? null : toolsIdentity(prepared.tools),
    });
    if (!this.#shouldRebuild(identity, invalidation, prepared)) {
      return outcome('skipped');
    }
    try {
      const result = await this.#buildOutputs({
        model,
        projectRoot: prepared.root,
        ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
      });
      if (result === undefined) {
        this.#last = undefined;
        return this.#removePublishedOutputs(prepared.configPath);
      }
      this.#last = Object.freeze({
        identity,
        inputs: new Set(result.files.flatMap((file) => file.sourceInputs)),
        succeeded: true,
      });
      this.#published = Object.freeze({
        outputRoot: result.outputRoot,
        paths: Object.freeze(result.files.map((file) => file.path)),
      });
      return outcome('built');
    } catch (error) {
      this.#last = Object.freeze({ identity, inputs: new Set<string>(), succeeded: false });
      return outcome('failed', Object.freeze([warning(
        `Package build (bin/lib) failed during development rebuild: ${
          error instanceof Error ? error.message : String(error)
        }`,
        prepared.configPath,
      )]));
    }
  }

  #shouldRebuild(identity: string, invalidation: Invalidation, prepared: PreparedProject): boolean {
    const last = this.#last;
    if (last === undefined || !last.succeeded || last.identity !== identity) return true;
    if (invalidation.reason !== 'source-change') return true;
    const configPath = relativePosix(prepared.root, prepared.configPath);
    return invalidation.paths.some((path) =>
      path === configPath || last.inputs.has(path) || configurationInputs.has(path));
  }

  async #removePublishedOutputs(configPath: string): Promise<DevPackageBuildOutcome> {
    const published = this.#published;
    if (published === undefined) return outcome('absent');
    this.#published = undefined;
    try {
      for (const path of published.paths) {
        await rm(join(published.outputRoot, path), { force: true });
      }
      // Prune now-empty directories, deepest first; a directory that still
      // holds files another producer wrote simply stays.
      const directories = [...new Set(published.paths
        .map((path) => dirname(path))
        .filter((directory) => directory !== '.'))]
        .sort((left, right) => right.length - left.length);
      for (const directory of [...directories.map((entry) => join(published.outputRoot, entry)), published.outputRoot]) {
        try {
          await rmdir(directory);
        } catch {
          // Nonempty or already gone: both fine.
        }
      }
      return outcome('removed');
    } catch (error) {
      return outcome('removed', Object.freeze([warning(
        `Unable to remove stale package build outputs: ${
          error instanceof Error ? error.message : String(error)
        }`,
        configPath,
      )]));
    }
  }
}
