import type { RequestProvenanceAxis } from '../../../agent-bundle/src/contracts/request-provenance.ts';
import type {
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplaySource,
} from './lifecycle-client.ts';

export type LifecycleSourceMode = 'fixture' | 'observed';

export interface LifecycleDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface LifecycleResultDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source: 'projection' | 'render stream';
}

export interface LifecycleOption {
  readonly binding: Readonly<{
    readonly manifestDigest: string;
    readonly routeId: string;
    readonly target: string;
  }>;
  readonly event: string;
  readonly fixture?: Readonly<{
    readonly label: string;
    readonly native: Readonly<Record<string, unknown>>;
  }>;
  readonly hostContractRevision: string;
  readonly key: string;
  readonly label: string;
  readonly nativeEvent: string;
  readonly routePath: string;
}

const row = (label: string, value: string): LifecycleDetailRow => Object.freeze({ label, value });

const observedRow = <Value>(
  label: string,
  axis: RequestProvenanceAxis<Value>,
  display: (value: Value) => string,
): LifecycleDetailRow => row(
  label,
  axis.state === 'available'
    ? `${display(axis.value)} · ${axis.source}`
    : `Unavailable · ${axis.reason}`,
);

const optionalRow = (label: string, value: string | undefined): LifecycleDetailRow =>
  row(label, value ?? 'Unavailable · not-provided');

export const lifecycleOptionKeyFor = (routeId: string, target: string): string => `${target}/${routeId}`;

export const lifecycleOptionsFor = (list: LifecycleListResponse): readonly LifecycleOption[] => Object.freeze(
  list.lifecycles
    .flatMap((lifecycle) => lifecycle.targets.map((target): LifecycleOption => Object.freeze({
      binding: Object.freeze({
        manifestDigest: list.manifestDigest,
        routeId: lifecycle.routeId,
        target: target.target,
      }),
      event: lifecycle.event,
      ...(target.fixture === undefined ? {} : {
        fixture: Object.freeze({
          label: target.fixture.label,
          native: target.fixture.native,
        }),
      }),
      hostContractRevision: target.hostContractRevision,
      key: lifecycleOptionKeyFor(lifecycle.routeId, target.target),
      label: `${lifecycle.event} · ${target.target}`,
      nativeEvent: target.nativeEvent,
      routePath: lifecycle.routePath,
    })))
    .sort((left, right) => left.key.localeCompare(right.key)),
);

export const lifecycleReplaySourceFor = (
  mode: LifecycleSourceMode,
  fixtureEdited: boolean,
): LifecycleReplaySource => mode === 'fixture' && !fixtureEdited ? 'fixture' : 'observed';

export const canonicalRowsFor = (replay: LifecycleReplay): readonly LifecycleDetailRow[] => Object.freeze([
  row('Canonical event', replay.canonical.event),
  row('Idempotency key', replay.canonical.idempotencyKey),
  row('Observed at', replay.canonical.observedAt),
  row('Sequence', String(replay.canonical.sequence)),
  row('Host', replay.canonical.provenance.host),
  row('Native event', replay.canonical.provenance.nativeEvent),
  row('Host contract revision', replay.canonical.provenance.hostContractRevision),
]);

const payloadValueText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
};

/**
 * The canonical payload the route received (#466): one row per mapped field,
 * showing the value beside the host key it was read from, so the evidence
 * panel makes the mapped-versus-missing distinction visible. An empty payload
 * is one row saying so rather than an absent section.
 */
export const payloadRowsFor = (replay: LifecycleReplay): readonly LifecycleDetailRow[] => {
  const entries = Object.entries(replay.canonical.payload)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return Object.freeze([row('Payload', 'No canonical field mapped from this envelope')]);
  return Object.freeze(entries.map(([field, mapped]) =>
    row(field, `${payloadValueText(mapped.value)} · ${mapped.nativeKey}`)));
};

export const requestRowsFor = (replay: LifecycleReplay): readonly LifecycleDetailRow[] => Object.freeze([
  row('Invocation kind', replay.requestContext.invocation.kind),
  optionalRow('Operation ID', replay.requestContext.invocation.operationId),
  optionalRow('Surface', replay.requestContext.invocation.surface),
  optionalRow('Host contract revision', replay.requestContext.invocation.hostContractRevision),
  observedRow('Host', replay.requestContext.host, ({ name }) => name),
  observedRow('Session', replay.requestContext.session, ({ sessionId }) => sessionId),
  observedRow('Actor', replay.requestContext.actor, ({ id }) => id),
  observedRow('Workspace', replay.requestContext.workspace, ({ root }) => root),
  observedRow('Lineage', replay.requestContext.lineage, ({ conversation, depth, resolution }) =>
    `${conversation} · depth ${String(depth)} · ${resolution}`),
]);

export interface LifecycleLineageNode {
  readonly id: string;
  readonly role: 'root' | 'ancestor' | 'current';
}

/**
 * The root-to-current chain a replayed request sits on. A single receipt can
 * name at most its root, its parent, and itself; the warm runtime holds the
 * rest of the tree.
 */
export const lineageChainFor = (replay: LifecycleReplay): readonly LifecycleLineageNode[] => {
  const lineage = replay.requestContext.lineage;
  if (lineage.state !== 'available') return Object.freeze([]);
  const { conversation, parent, root } = lineage.value;
  const chain: LifecycleLineageNode[] = [{ id: root, role: conversation === root ? 'current' : 'root' }];
  if (parent !== undefined && parent !== root && parent !== conversation) chain.push({ id: parent, role: 'ancestor' });
  if (conversation !== root) chain.push({ id: conversation, role: 'current' });
  return Object.freeze(chain.map((node) => Object.freeze(node)));
};

export const resultDiagnosticsFor = (replay: LifecycleReplay): readonly LifecycleResultDiagnostic[] => Object.freeze([
  ...(replay.projectionDiagnostic === undefined ? [] : [Object.freeze({
    code: replay.projectionDiagnostic.code,
    message: replay.projectionDiagnostic.message,
    source: 'projection' as const,
  })]),
  ...replay.events.flatMap((event) => event.type === 'error'
    ? [Object.freeze({
        code: event.error.code,
        message: event.error.message,
        source: 'render stream' as const,
      })]
    : []),
]);
