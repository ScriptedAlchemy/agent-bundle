import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import type {
  AgentEventCanonicalIdentity,
  CanonicalAgentEvent,
} from '../../routes/public.ts';
import type { RequestContextProvenance } from '../../contracts/request-provenance.ts';

export interface LifecycleRenderChildRequest {
  readonly event: CanonicalAgentEvent;
  readonly hostContractRevision: string;
  readonly nativeEvent: string;
  readonly nativeInput: Readonly<Record<string, unknown>>;
  readonly requestContext: RequestContextProvenance;
  readonly routeId: string;
  readonly routeSource: string;
  readonly target: string;
}

export interface LifecycleRenderChildResult {
  readonly canonical: AgentEventCanonicalIdentity;
  readonly document: AgentDocument;
  readonly events: readonly AgentRenderEvent[];
}

export type LifecycleRenderChildResponse =
  | Readonly<{
    readonly result: LifecycleRenderChildResult;
    readonly type: 'result';
  }>
  | Readonly<{
    readonly error: Readonly<{
      readonly message: string;
      readonly name: string;
    }>;
    readonly type: 'error';
  }>;
