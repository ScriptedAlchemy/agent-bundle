export type RequestProvenanceSource = 'native' | 'receipt' | 'derived';

export type RequestProvenanceUnavailableReason =
  | 'not-provided'
  | 'unsupported-surface'
  | 'host-omitted'
  | 'unauthenticated'
  | 'no-subagent-events'
  | 'id-not-resolvable'
  | 'cloud-agent-no-user-hooks'
  | 'no-shared-runtime';

export type RequestProvenanceAxis<Value> =
  | Readonly<{
      readonly source: RequestProvenanceSource;
      readonly state: 'available';
      readonly value: Value;
    }>
  | Readonly<{
      readonly reason: RequestProvenanceUnavailableReason;
      readonly state: 'unavailable';
    }>;

export interface RequestInvocationProvenance {
  readonly hostContractRevision?: string;
  readonly kind: 'tool' | 'event' | 'cli' | 'script' | 'workbench';
  readonly operationId?: string;
  readonly surface?: string;
}

/** The conversation tree position a request carried (`request.lineage`), on the wire. */
export interface RequestLineageProvenance {
  readonly conversation: string;
  readonly depth: number;
  readonly generation?: string;
  readonly parent?: string;
  readonly resolution: 'native' | 'registry' | 'inferred';
  readonly root: string;
  readonly subagent?: Readonly<{
    readonly id: string;
    readonly isParallelWorker?: boolean;
    readonly toolCallId?: string;
    readonly type?: string;
  }>;
}

/**
 * Credential-free request identity projected onto a Workbench wire response.
 * Every observable axis is explicit; unknown values remain typed unavailable.
 */
export interface RequestContextProvenance {
  readonly actor: RequestProvenanceAxis<Readonly<{ readonly id: string }>>;
  readonly host: RequestProvenanceAxis<Readonly<{ readonly name: string }>>;
  readonly invocation: RequestInvocationProvenance;
  readonly lineage: RequestProvenanceAxis<RequestLineageProvenance>;
  readonly session: RequestProvenanceAxis<Readonly<{ readonly sessionId: string }>>;
  readonly workspace: RequestProvenanceAxis<Readonly<{ readonly root: string }>>;
}
