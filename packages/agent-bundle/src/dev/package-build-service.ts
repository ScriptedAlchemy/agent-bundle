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
 * (every bundled module, recorded from bundler stats) and the normalized
 * `bin`/`lib` declaration is unchanged. Changes the bundler cannot attribute
 * to a tracked input — `package.json`, `tsconfig.json`, manual and initial
 * invalidations, or any previous failure — always rebuild.
 *
 * A package build failure never invalidates the artifact epoch that already
 * committed; it surfaces as one AB7103 warning on the succeeded attempt.
 */

export type DevPackageBuildState = 'absent' | 'built' | 'failed' | 'skipped';

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

export class DevPackageBuildService implements DevPackageBuilder {
  readonly #buildOutputs: typeof buildPackageOutputs;
  #last: Readonly<{
    identity: string;
    inputs: ReadonlySet<string>;
    succeeded: boolean;
  }> | undefined;

  constructor(options: DevPackageBuildServiceOptions = {}) {
    this.#buildOutputs = options.buildOutputs ?? buildPackageOutputs;
  }

  async build(prepared: PreparedProject, invalidation: Invalidation): Promise<DevPackageBuildOutcome> {
    const model = prepared.model;
    if (model?.packageBuild === undefined) {
      this.#last = undefined;
      return outcome('absent');
    }
    const identity = digest(model.packageBuild);
    if (!this.#shouldRebuild(identity, invalidation)) {
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
        return outcome('absent');
      }
      this.#last = Object.freeze({
        identity,
        inputs: new Set(result.files.flatMap((file) => file.sourceInputs)),
        succeeded: true,
      });
      return outcome('built');
    } catch (error) {
      this.#last = Object.freeze({ identity, inputs: new Set<string>(), succeeded: false });
      return outcome('failed', Object.freeze([Object.freeze({
        code: 'AB7103',
        message: `Package build (bin/lib) failed during development rebuild: ${
          error instanceof Error ? error.message : String(error)
        }`,
        severity: 'warning' as const,
        sourcePath: prepared.configPath,
      })]));
    }
  }

  #shouldRebuild(identity: string, invalidation: Invalidation): boolean {
    const last = this.#last;
    if (last === undefined || !last.succeeded || last.identity !== identity) return true;
    if (invalidation.reason !== 'source-change') return true;
    return invalidation.paths.some((path) =>
      last.inputs.has(path) || configurationInputs.has(path));
  }
}
