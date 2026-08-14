import type { Diagnostic } from '../core/diagnostics.ts';
import type { CanonicalHookEvent, NormalizedHook, NormalizedPlugin } from '../core/types.ts';

export interface TargetArtifactWrite {
  readonly content: string;
  readonly kind: 'write';
  readonly relativePath: string;
}

export interface TargetArtifactCopy {
  readonly bytes: number;
  readonly kind: 'copy';
  readonly relativePath: string;
  readonly source: string;
}

export type TargetArtifactEntry = TargetArtifactWrite | TargetArtifactCopy;

export interface TargetHookEntry {
  readonly event: CanonicalHookEvent;
  readonly hook: NormalizedHook;
  readonly relativePath: string;
  readonly target: string;
}

export interface TargetArtifactPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
}

export interface TargetAdapter {
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly name: string;
  plan(model: NormalizedPlugin): TargetArtifactPlan;
  validateModel(model: NormalizedPlugin): Diagnostic[];
}
