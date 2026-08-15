import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  AgentBundleConfig,
  CanonicalHookEvent,
  NormalizedHook,
  NormalizedPlugin,
} from '../core/types.ts';

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

export interface TargetHookWrapper {
  readonly event: CanonicalHookEvent;
  readonly hook: NormalizedHook;
  readonly nativeEvent: string;
  readonly relativePath: string;
  readonly target: string;
}

export interface TargetHookEntry extends TargetHookWrapper {
  readonly virtualSource: string;
}

export interface TargetArtifactPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries?: readonly TargetHookEntry[];
}

export type McpPathTokenRoot = 'pluginData' | 'pluginRoot' | 'workspaceRoot';

export interface McpPathTokenCapabilities {
  readonly args: Readonly<Record<string, McpPathTokenRoot>>;
  readonly cwd: Readonly<Record<string, McpPathTokenRoot>>;
  readonly env: Readonly<Record<string, McpPathTokenRoot>>;
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

export interface TargetAdapter {
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly configExtension?: TargetConfigExtension;
  readonly metadata: TargetAdapterMetadata;
  readonly mcpPathTokens?: McpPathTokenCapabilities;
  readonly name: string;
  nativeHookSource?(config: Readonly<AgentBundleConfig>): string | undefined;
  plan(model: NormalizedPlugin): TargetArtifactPlan;
  validateModel(model: NormalizedPlugin): Diagnostic[];
}
