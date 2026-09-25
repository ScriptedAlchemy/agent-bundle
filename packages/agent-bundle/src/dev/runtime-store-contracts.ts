import type { JsonValue } from './types.ts';

/**
 * The generation store contract a `dev.runtime.provider` drives, spelled
 * without its implementation (#485). The class in `runtime-generation-store.ts`
 * implements these interfaces and throws `YieldableFrameworkError`s, which
 * reach `effect`; a public `.d.ts` graph must not (`docs/effect-conventions.md`,
 * boundary modules), so `agent-bundle/api` exports this module and the factory
 * in `runtime-store-factories.ts`, never the class.
 */

export interface RuntimeGenerationAsset {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeGenerationMetadataCodec<TMetadata> {
  decode(value: JsonValue): TMetadata;
  encode(value: TMetadata): JsonValue;
}

export interface RuntimeGenerationManifestInput<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
}

export interface RuntimeGenerationManifest<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly createdAt: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly metadata: TMetadata;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationValidationInput<TMetadata> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
  readonly root: string;
}

export type RuntimeGenerationValidator<TMetadata> = (
  input: RuntimeGenerationValidationInput<TMetadata>,
) => Promise<TMetadata> | TMetadata;

export interface RuntimeGenerationActivationGuard<TMetadata> {
  wait(manifest: RuntimeGenerationManifest<TMetadata>): Promise<void>;
  check(manifest: RuntimeGenerationManifest<TMetadata>): boolean;
}

export interface RuntimeGenerationPrepareOptions<TMetadata> {
  readonly guard?: RuntimeGenerationActivationGuard<TMetadata>;
}

export interface RuntimeGenerationCandidate {
  readonly id: string;
  readonly root: string;
  readonly sequence: number;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationPreparedActivation<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  readonly sequence: number;
}

export interface RuntimeGeneration<TMetadata = unknown> {
  readonly id: string;
  readonly manifest: RuntimeGenerationManifest<TMetadata>;
  readonly root: string;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationLease<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  release(): Promise<void>;
}

export interface RuntimeGenerationStoreOptions<TMetadata> {
  readonly metadataCodec: RuntimeGenerationMetadataCodec<TMetadata>;
  readonly now?: () => Date;
  /** Test seam for cleanup failures; production callers use recursive `rm`. */
  readonly remove?: (path: string) => Promise<void>;
  readonly retainInactive?: number;
  readonly storageRoot: string;
  readonly validateMetadata: RuntimeGenerationValidator<TMetadata>;
}

export interface RuntimeGenerationCloseFailure {
  readonly error: unknown;
  readonly path: string;
}

/** The `code` of an error the generation store throws (`name: 'RuntimeGenerationStoreError'`). */
export type RuntimeGenerationStoreErrorCode =
  | 'RUNTIME_GENERATION_CLOSED'
  | 'RUNTIME_GENERATION_CONFLICT'
  | 'RUNTIME_GENERATION_INVALID'
  | 'RUNTIME_GENERATION_NOT_FOUND'
  | 'RUNTIME_GENERATION_SUPERSEDED';

/**
 * The durable, epoch-pinned generation store a provider session drives:
 * stage a candidate, prepare and commit (or abort) its activation, lease the
 * active generation for a run, and close. Created with
 * `createRuntimeGenerationStore` from `agent-bundle/api`.
 */
export interface DevRuntimeGenerationStore<TMetadata = unknown> {
  abort(prepared: RuntimeGenerationPreparedActivation<TMetadata>): Promise<void>;
  active(): RuntimeGeneration<TMetadata> | undefined;
  begin(input: Readonly<{ readonly id: string; readonly sourceRevision: string }>): Promise<RuntimeGenerationCandidate>;
  canCommit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): boolean;
  close(): Promise<void>;
  commit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): RuntimeGeneration<TMetadata>;
  fail(candidate: RuntimeGenerationCandidate): Promise<void>;
  lease(id?: string): Promise<RuntimeGenerationLease<TMetadata>>;
  prepare(
    candidate: RuntimeGenerationCandidate,
    input: RuntimeGenerationManifestInput<TMetadata>,
    options?: RuntimeGenerationPrepareOptions<TMetadata>,
  ): Promise<RuntimeGenerationPreparedActivation<TMetadata>>;
}
