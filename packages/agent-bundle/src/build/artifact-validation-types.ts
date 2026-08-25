import type { TargetRegistry } from '../adapters/registry.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  ArtifactFile,
  ArtifactFilesystemSnapshot,
  ArtifactHook,
} from './emit.ts';
import type { ArtifactManifest } from './manifest.ts';

export interface ValidateArtifactOptions {
  /** Enables the one store-owned epoch staging marker after its exact schema validates. */
  readonly allowEpochStagingMarker?: true;
  readonly artifactRoot: string;
  /** Target contracts that produced and must validate this artifact. */
  readonly registry?: TargetRegistry;
}

/** Safe runtime facts derived during the same validation pass as the manifest. */
export interface ValidatedArtifactRuntimeEvidence {
  readonly hooks: readonly ArtifactHook[];
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
