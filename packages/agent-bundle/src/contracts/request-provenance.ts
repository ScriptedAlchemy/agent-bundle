export type RequestProvenanceSource = 'native' | 'receipt' | 'derived';

export type RequestProvenanceUnavailableReason =
  | 'not-provided'
  | 'unsupported-surface'
  | 'host-omitted'
  | 'unauthenticated';

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

/**
 * Credential-free request identity projected onto a Workbench wire response.
 * Every observable axis is explicit; unknown values remain typed unavailable.
 */
export interface RequestContextProvenance {
  readonly actor: RequestProvenanceAxis<Readonly<{ readonly id: string }>>;
  readonly host: RequestProvenanceAxis<Readonly<{ readonly name: string }>>;
  readonly invocation: RequestInvocationProvenance;
  readonly session: RequestProvenanceAxis<Readonly<{ readonly sessionId: string }>>;
  readonly workspace: RequestProvenanceAxis<Readonly<{ readonly root: string }>>;
}
