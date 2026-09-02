import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import type {
  AgentEventCanonicalIdentity,
  CanonicalAgentEvent,
} from '../routes/public.ts';

export interface LifecycleBinding {
  readonly manifestDigest: string;
  readonly routeId: string;
  readonly target: string;
}

export interface LifecycleDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly target?: string;
}

export interface LifecycleReplayDiagnostic extends LifecycleDiagnostic {
  readonly event: CanonicalAgentEvent;
  readonly target: string;
}

export interface LifecycleTarget {
  readonly fixture?: Readonly<{
    readonly label: string;
    readonly native: Readonly<Record<string, unknown>>;
  }>;
  readonly hostContractRevision: string;
  readonly nativeEvent: string;
  readonly target: string;
}

export interface Lifecycle {
  readonly diagnostics: readonly LifecycleDiagnostic[];
  readonly event: CanonicalAgentEvent;
  readonly routeId: string;
  readonly routePath: string;
  readonly targets: readonly LifecycleTarget[];
}

export interface LifecycleListResponse {
  readonly lifecycles: readonly Lifecycle[];
  readonly manifestDigest: string;
}

export type LifecycleReplaySource = 'fixture' | 'observed';

export interface LifecycleReplayRequest {
  readonly binding: LifecycleBinding;
  readonly native: Readonly<Record<string, unknown>>;
  readonly source: LifecycleReplaySource;
}

export interface LifecycleReplay {
  readonly binding: LifecycleBinding;
  readonly canonical: AgentEventCanonicalIdentity;
  readonly document?: AgentDocument;
  readonly events: readonly AgentRenderEvent[];
  readonly nativeInput: Readonly<Record<string, unknown>>;
  readonly nativeResponse?: Readonly<Record<string, unknown>>;
  readonly projectionDiagnostic?: Readonly<{ readonly code: string; readonly message: string }>;
  readonly requestContext: Readonly<{
    readonly hostContractRevision: string;
    readonly invocationKind: 'event';
    readonly nativeEvent: string;
    readonly routeId: string;
    readonly target: string;
  }>;
  readonly source: LifecycleReplaySource;
}

export interface LifecycleReplayDiagnosticResult {
  readonly diagnostics: readonly LifecycleReplayDiagnostic[];
}
