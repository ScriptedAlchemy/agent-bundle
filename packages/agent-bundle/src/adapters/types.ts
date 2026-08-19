import type { Diagnostic } from '../core/diagnostics.ts';
import { snapshotStrictJsonValue } from '../core/strict-json.ts';
import type {
  AgentBundleConfig,
  NormalizedPlugin,
} from '../core/types.ts';
import type { TargetHookContract, TargetHookEntry } from './hook-contract.ts';
import type { TargetMcpRuntimeContract } from '../services/mcp-runtime.ts';

export type { TargetHookEntry, TargetHookWrapper } from './hook-contract.ts';

export interface TargetArtifactWrite {
  readonly content: string;
  readonly kind: 'write';
  readonly relativePath: string;
  /** Absolute authored inputs that selected this generated artifact. */
  readonly sourceInputs: readonly string[];
}

export interface TargetArtifactCopy {
  readonly bytes: number;
  readonly kind: 'copy';
  readonly relativePath: string;
  readonly source: string;
  /** Absolute authored inputs for this copied artifact. */
  readonly sourceInputs: readonly string[];
}

export type TargetArtifactEntry = TargetArtifactWrite | TargetArtifactCopy;

export interface TargetArtifactPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries?: readonly TargetHookEntry[];
}

export interface TargetConfigExtension {
  readonly key: string;
}

export interface TargetSchemaDescriptor {
  readonly name: string;
  readonly revision: string;
  readonly sha256: string;
}

export interface TargetAdapterMetadata {
  readonly adapterRevision: string;
  readonly capabilityRevision: string;
  readonly capabilitySha256: string;
  readonly observedVersion: string;
  readonly schemas: readonly TargetSchemaDescriptor[];
}

export interface TargetArtifactDocumentIssue {
  readonly instancePath: string;
  readonly message: string;
}

export type TargetArtifactDocumentValidator = (
  document: unknown,
) => readonly TargetArtifactDocumentIssue[];

export interface TargetArtifactSchemaContract {
  readonly name: string;
  readonly validate: TargetArtifactDocumentValidator;
}

export interface TargetArtifactDocumentContract {
  readonly path: string;
  readonly required: boolean;
  readonly schema: string;
}

export interface TargetArtifactValidationContract {
  readonly documents: readonly TargetArtifactDocumentContract[];
  readonly schemas: readonly TargetArtifactSchemaContract[];
}

/** A direct-file namespace emitted by a target's compiler plan. */
export interface TargetArtifactOutputLayout {
  readonly allowedSuffixes: readonly string[];
  readonly directory: string;
}

const noArtifactDocumentIssues: readonly TargetArtifactDocumentIssue[] = Object.freeze([]);
const invalidMcpDocumentIssues: readonly TargetArtifactDocumentIssue[] = Object.freeze([Object.freeze({
  instancePath: '',
  message: 'MCP document must be a detached finite JSON value.',
})]);

/**
 * Target-owned compiler namespaces, separate from target-native schema documents.
 * Every field is an emitted-layout fact rather than a target-name convention.
 */
export interface TargetArtifactLayout {
  readonly hookWrappers?: TargetArtifactOutputLayout;
  readonly mcpApps?: TargetArtifactOutputLayout;
  readonly mcpEntries?: TargetArtifactOutputLayout;
  readonly scripts?: TargetArtifactOutputLayout;
  readonly skills?: string;
}

interface JsonSchemaValidator {
  (document: unknown): boolean;
  readonly errors?: readonly { readonly instancePath: string; readonly message?: string }[] | null;
}

/** Converts the checked-in AJV validator result into the artifact contract's stable issue shape. */
export const validateJsonSchemaDocument = (
  validator: JsonSchemaValidator,
): TargetArtifactDocumentValidator => (document) => {
  if (validator(document)) return Object.freeze([]);
  return Object.freeze((validator.errors ?? []).map((error) => Object.freeze({
    instancePath: error.instancePath,
    message: error.message ?? 'schema validation failed',
  })));
};

const escapeJsonPointerSegment = (value: string): string => value
  .replaceAll('~', '~0')
  .replaceAll('/', '~1');

const legacySseMcpIssues = (document: unknown): readonly TargetArtifactDocumentIssue[] => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return noArtifactDocumentIssues;
  const servers = (document as { readonly mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return noArtifactDocumentIssues;
  return Object.freeze(Object.entries(servers)
    .filter(([, server]) =>
      server !== null &&
      typeof server === 'object' &&
      !Array.isArray(server) &&
      (server as { readonly type?: unknown }).type === 'sse')
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([name]) => Object.freeze({
      instancePath: `/mcpServers/${escapeJsonPointerSegment(name)}/type`,
      message: 'legacy SSE MCP transport is not supported',
    })));
};

/** Adds Agent Bundle's modern-only MCP transport policy to a pinned schema validator. */
export const validateModernMcpDocument = (
  validateSchema: TargetArtifactDocumentValidator,
): TargetArtifactDocumentValidator => (document) => {
  let snapshot: unknown;
  try {
    snapshot = snapshotStrictJsonValue(document);
  } catch {
    return invalidMcpDocumentIssues;
  }
  const legacyIssues = legacySseMcpIssues(snapshot);
  if (legacyIssues.length > 0) return legacyIssues;
  return validateSchema(snapshot);
};

export interface TargetAdapter {
  /** Validates target-native JSON documents against schemas pinned in metadata. */
  readonly artifactValidation?: TargetArtifactValidationContract;
  /** Declares compiler-owned artifact layouts beyond target-native documents. */
  readonly artifactLayout?: TargetArtifactLayout;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly configExtension?: TargetConfigExtension;
  readonly hookContract?: TargetHookContract;
  readonly metadata: TargetAdapterMetadata;
  readonly mcpRuntime?: TargetMcpRuntimeContract;
  readonly name: string;
  nativeHookSource?(config: Readonly<AgentBundleConfig>): string | undefined;
  plan(model: NormalizedPlugin): TargetArtifactPlan;
  validateModel(model: NormalizedPlugin): Diagnostic[];
}
