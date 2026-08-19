import type { Readable } from 'node:stream';

import type { TargetRegistry } from '../adapters/registry.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { EvalCaseAggregate } from '../eval/aggregate.ts';
import type { CodexCommandRunner } from '../eval/codex-harness.ts';
import type {
  EvalRunEvent,
  EvalRunRecord,
  EvalTrialRecord,
} from '../eval/run-store.ts';
import type { EvalAssertionKind, EvalInvocation } from '../eval/types.ts';
import type { NativeClaudeProcessRunner } from '../host-contracts/native-claude-contract.ts';
import type { DevLogSink } from './dev-log-service.ts';

export interface EvalAssertionSummary {
  readonly id: string;
  readonly kind: EvalAssertionKind;
  /** The Skill an activation assertion references; absent for blanket and non-Skill assertions. */
  readonly skill?: string;
}

export interface EvalCaseSummary {
  readonly assertions: readonly EvalAssertionSummary[];
  readonly digest: string;
  readonly hosts: readonly string[];
  readonly id: string;
  readonly invocation: EvalInvocation;
  readonly prompt: string;
  readonly trials: number;
}

export interface EvalSuiteSummary {
  readonly cases: readonly EvalCaseSummary[];
  readonly digest: string;
  readonly name: string;
  /** Project-relative so no caller, browser included, learns an absolute location. */
  readonly sourcePath: string;
}

export interface EvalSuiteListing {
  readonly diagnostics: readonly Diagnostic[];
  readonly suites: readonly EvalSuiteSummary[];
}

export interface EvalRunSelection {
  readonly caseIds?: readonly string[];
  readonly suites?: readonly string[];
}

export interface EvalRunRequest extends EvalRunSelection {
  /** An already-built artifact root. Only the API and CLI may name one; the browser never does. */
  readonly artifact?: string;
  readonly harness?: string;
  readonly signal?: AbortSignal;
  readonly trials?: number;
}

export interface EvalRunResult {
  readonly aggregates: readonly EvalCaseAggregate[];
  readonly diagnostics: readonly Diagnostic[];
  readonly run: EvalRunRecord;
  readonly trials: readonly EvalTrialRecord[];
}

/** A durable run identity returned before its background trials settle. */
export interface EvalRunAdmission {
  readonly run: EvalRunRecord;
}

/** A durable event replay never includes an incomplete append record. */
export interface EvalRunEventsReplay {
  readonly cursor: Readonly<{ readonly afterSequence: number }>;
  readonly events: readonly EvalRunEvent[];
  /** True when the event file ends with an incomplete record that was not replayed. */
  readonly incompleteTrailingRecord?: true;
}

/** A run-pinned raw-evidence descriptor. Call close when its response stream ends. */
export interface EvalArtifactReader {
  readonly digest: string;
  readonly filename: string;
  readonly ref: string;
  readonly size: number;
  close(): Promise<void>;
  read(start?: number, end?: number): Readable;
}

/** A replay snapshot followed by durable, ordered events published after its cursor. */
export interface EvalEventSubscription {
  readonly replay: EvalRunEventsReplay;
  activate(listener: (event: EvalRunEvent) => void): void;
  close(): void;
}

export interface EvalServiceOptions {
  readonly configPath?: string;
  readonly mode?: string;
  /** Optional non-throwing producer-wide diagnostics sink. */
  readonly logger?: DevLogSink;
  /** Native CLI injection is deliberately limited to test runners and their child environment. */
  readonly native?: EvalServiceNativeOptions;
  /** Injectable only to make run identity deterministic in tests. */
  readonly now?: () => Date;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly targets?: readonly string[];
}

export interface EvalServiceNativeOptions {
  readonly claudeRun?: NativeClaudeProcessRunner;
  readonly codexRun?: CodexCommandRunner;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}
