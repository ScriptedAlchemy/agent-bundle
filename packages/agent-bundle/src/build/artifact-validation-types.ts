import type { TargetRegistry } from '../adapters/registry.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  ArtifactFile,
  ArtifactFilesystemSnapshot,
} from './emit.ts';
import type { ArtifactManifest, ArtifactManifestHook } from './manifest.ts';
import type { ModuleSyntaxCheck } from './module-imports.ts';

export interface ValidateArtifactOptions {
  /** Enables the one store-owned epoch staging marker after its exact schema validates. */
  readonly allowEpochStagingMarker?: true;
  readonly artifactRoot: string;
  /**
   * How the syntax of a module the framework compiled (manifest kind
   * `bundle`) is checked: `lexed` (the default) trusts the bundler's own
   * output to the ESM lexer; `parsed` runs the full parse a build selects
   * when a consumer bundler hatch may have rewritten the emitted assets.
   * Every other module is always parsed in full.
   */
  readonly bundleSyntaxCheck?: ModuleSyntaxCheck;
  /**
   * Artifact-relative paths of prebuilt payload files for pre-manifest
   * validation. Prebuilt files are integrity-checked but never subjected to
   * generated-content validation; after the manifest exists, its `prebuilt`
   * file kind carries this information instead.
   */
  readonly prebuiltPaths?: ReadonlySet<string>;
  /** Target contracts that produced and must validate this artifact. */
  readonly registry?: TargetRegistry;
}

/** Safe runtime facts derived during the same validation pass as the manifest. */
export interface ValidatedArtifactRuntimeEvidence {
  /** The manifest's own `executables.hooks[]` rows, re-proven against the host hooks documents. */
  readonly hooks: readonly ArtifactManifestHook[];
  readonly mcpServers: readonly ValidatedArtifactMcpServerEvidence[];
}

/** One non-secret modern MCP server fact validated against manifested target files. */
export interface ValidatedArtifactMcpServerEvidence {
  readonly entryPaths: readonly string[];
  readonly kind: 'stdio' | 'streamable-http';
  readonly manifestPath: string;
  readonly name: string;
  readonly target: string;
}

/** Deeply frozen artifact evidence that passed one complete validation pass. */
export interface ValidatedArtifactSnapshot {
  readonly files: readonly ArtifactFile[];
  readonly filesystem: ArtifactFilesystemSnapshot;
  readonly manifest: ArtifactManifest;
  readonly runtime: ValidatedArtifactRuntimeEvidence;
}

/** Validation diagnostics plus immutable evidence only when no diagnostics were found. */
export interface ValidateArtifactSnapshotResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot?: ValidatedArtifactSnapshot;
}
