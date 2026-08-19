import { CodedError } from '../core/errors.ts';
import type { DevLogSink } from '../dev/dev-log-service.ts';

export type PlaygroundJsonPrimitive = boolean | null | number | string;
export type PlaygroundJsonArray = readonly PlaygroundJsonValue[];
export interface PlaygroundJsonObject {
  readonly [key: string]: PlaygroundJsonValue;
}
export type PlaygroundJsonValue = PlaygroundJsonPrimitive | PlaygroundJsonArray | PlaygroundJsonObject;

export type PlaygroundTraceSource =
  | 'build'
  | 'diagnostics'
  | 'hook'
  | 'host-preflight'
  | 'mcp'
  | 'project'
  | 'response'
  | 'script'
  | 'skill-evidence'
  | 'workspace-change';

export interface PlaygroundEpochIdentity {
  readonly digest: string;
  readonly id: string;
}

export interface PlaygroundFixtureIdentity {
  readonly digest: string;
  readonly id: string;
}

export interface PlaygroundTask {
  readonly id: string;
  readonly text: string;
}

export interface PlaygroundTarget {
  readonly digest?: string;
  readonly name: string;
}

export interface PlaygroundInvocation {
  readonly intent: PlaygroundJsonObject;
  readonly kind: string;
}

export interface PlaygroundSessionIdentity {
  readonly epoch: PlaygroundEpochIdentity;
  readonly fixture: PlaygroundFixtureIdentity;
  readonly invocation: PlaygroundInvocation;
  readonly target: PlaygroundTarget;
  readonly task: PlaygroundTask;
}

export interface PlaygroundSessionInput extends PlaygroundSessionIdentity {
  readonly sessionId?: string;
}

export interface PlaygroundDurableOutcome {
  readonly response?: string;
  readonly status: string;
  readonly workspace?: PlaygroundJsonObject;
}

export interface PlaygroundEventInput {
  readonly kind: string;
  readonly raw: PlaygroundJsonValue;
  readonly source: PlaygroundTraceSource;
  readonly summary: string;
}

export interface PlaygroundTraceEvent extends PlaygroundEventInput {
  readonly rawEventRef: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface PlaygroundCleanupFailure {
  readonly message: string;
  readonly operation: 'admission' | 'subscriber';
}

export interface PlaygroundSession {
  readonly cleanupFailures: readonly PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly id: string;
  readonly identity: PlaygroundSessionIdentity;
  readonly outcome?: PlaygroundDurableOutcome;
  readonly state: 'closed' | 'finalized' | 'open';
}

export interface PlaygroundReplayCursor {
  readonly afterSequence: number;
}

export interface PlaygroundReplay {
  readonly cursor: PlaygroundReplayCursor;
  readonly events: readonly PlaygroundTraceEvent[];
  readonly session: PlaygroundSession;
}

export interface PlaygroundExport {
  readonly events: readonly PlaygroundTraceEvent[];
  readonly session: PlaygroundSession;
}

export interface PlaygroundSelectedAssertion {
  readonly evidence: PlaygroundJsonValue;
  readonly expectation: PlaygroundJsonValue;
  readonly id: string;
  readonly kind: string;
}

/** A deliberately narrow payload that converts unchanged into authored eval DSL. */
export interface DraftEvalCase {
  readonly assertions: readonly PlaygroundSelectedAssertion[];
  readonly epoch: PlaygroundEpochIdentity;
  readonly fixture: PlaygroundFixtureIdentity;
  readonly invocation: PlaygroundInvocation;
  readonly outcome: PlaygroundDurableOutcome;
  readonly target: PlaygroundTarget;
  readonly task: PlaygroundTask;
}

export interface PlaygroundSubscription {
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface PlaygroundSubscribeOptions {
  readonly afterSequence?: number;
  readonly onEvent: (event: PlaygroundTraceEvent) => void | Promise<void>;
}

export interface PlaygroundServiceOptions {
  /** Emits only durable append metadata after the event file fsync succeeds. */
  readonly logger?: DevLogSink;
  readonly maxSubscriberQueue?: number;
  readonly now?: () => Date;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storageRoot: string;
}

export type PlaygroundServiceErrorCode =
  | 'PLAYGROUND_CURSOR_AHEAD'
  | 'PLAYGROUND_CURSOR_INVALID'
  | 'PLAYGROUND_CREDENTIAL_REJECTED'
  | 'PLAYGROUND_OUTCOME_REQUIRED'
  | 'PLAYGROUND_PROJECT_MISMATCH'
  | 'PLAYGROUND_ROOT_INVALID'
  | 'PLAYGROUND_SERVICE_CLOSED'
  | 'PLAYGROUND_SESSION_CONFLICT'
  | 'PLAYGROUND_SESSION_FINALIZED'
  | 'PLAYGROUND_SESSION_ID_INVALID'
  | 'PLAYGROUND_SESSION_NOT_FOUND'
  | 'PLAYGROUND_SESSION_OWNED'
  | 'PLAYGROUND_STORE_CORRUPT'
  | 'PLAYGROUND_VALUE_INVALID';

export class PlaygroundServiceError extends CodedError<PlaygroundServiceErrorCode> {
  constructor(code: PlaygroundServiceErrorCode, message: string) {
    super('PlaygroundServiceError', code, message);
  }
}

export const playgroundServiceError = (
  code: PlaygroundServiceErrorCode,
  message: string,
): PlaygroundServiceError => new PlaygroundServiceError(code, message);
