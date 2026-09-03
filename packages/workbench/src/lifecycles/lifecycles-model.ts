import { deeplyFrozenHookValue } from '../hooks/hook-client.ts';
import type { RequestProvenanceAxis } from '../../../agent-bundle/src/contracts/request-provenance.ts';
import type {
  LifecycleDiagnostic,
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayResult,
  LifecycleReplaySource,
} from './lifecycle-client.ts';

export type LifecycleListState = 'error' | 'loading' | 'ready';
export type LifecyclesViewState = 'diagnostics' | 'empty' | 'list-error' | 'loading' | 'ready' | 'replayed';
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

export interface LifecyclesViewOptions {
  readonly list: LifecycleListResponse | undefined;
  readonly listState: LifecycleListState;
  readonly result: LifecycleReplayResult | undefined;
  readonly selectedKey: string | undefined;
}

export interface LifecyclesView {
  readonly canonicalRows: readonly LifecycleDetailRow[];
  readonly listDiagnostics: readonly LifecycleDiagnostic[];
  readonly options: readonly LifecycleOption[];
  readonly replay: LifecycleReplay | undefined;
  readonly replayDiagnostics: readonly LifecycleDiagnostic[];
  readonly requestRows: readonly LifecycleDetailRow[];
  readonly resultDiagnostics: readonly LifecycleResultDiagnostic[];
  readonly selected: LifecycleOption | undefined;
  readonly state: LifecyclesViewState;
  readonly summary: string;
}

const noRows: readonly LifecycleDetailRow[] = Object.freeze([]);
const noDiagnostics: readonly LifecycleDiagnostic[] = Object.freeze([]);
const noResultDiagnostics: readonly LifecycleResultDiagnostic[] = Object.freeze([]);

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

const summaryFor = (state: LifecyclesViewState, replay: LifecycleReplay | undefined): string => {
  switch (state) {
    case 'loading':
      return 'Loading semantic lifecycles from the current compiled manifest.';
    case 'list-error':
      return 'Semantic lifecycles could not be loaded from the current compiled manifest.';
    case 'empty':
      return 'The current compiled manifest exposes no semantic event lifecycles.';
    case 'diagnostics':
      return 'The lifecycle replay returned diagnostics instead of executing a route.';
    case 'replayed':
      return replay === undefined
        ? 'The deterministic lifecycle replay completed.'
        : `Replayed ${replay.canonical.event} for ${replay.binding.target} from ${replay.source} input.`;
    case 'ready':
      return 'Choose a compiled event route and host target, then run a deterministic replay.';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

/** Pure projection for lifecycle selection, diagnostics, and correlated replay evidence. */
export const lifecyclesViewFor = (options: LifecyclesViewOptions): LifecyclesView => {
  const detached = deeplyFrozenHookValue(options) as LifecyclesViewOptions;
  const list = detached.list;
  const lifecycleOptions = list === undefined ? Object.freeze([]) : lifecycleOptionsFor(list);
  const selected = detached.selectedKey === undefined
    ? lifecycleOptions[0]
    : lifecycleOptions.find((option) => option.key === detached.selectedKey);
  const result = detached.result;
  const replay = result !== undefined && 'replay' in result ? result.replay : undefined;
  const replayDiagnostics = result !== undefined && 'diagnostics' in result ? result.diagnostics : noDiagnostics;
  const listDiagnostics = list === undefined
    ? noDiagnostics
    : Object.freeze(list.lifecycles.flatMap((lifecycle) => lifecycle.diagnostics));
  const state: LifecyclesViewState = detached.listState === 'loading'
    ? 'loading'
    : detached.listState === 'error'
      ? 'list-error'
      : lifecycleOptions.length === 0
        ? 'empty'
        : replay !== undefined
          ? 'replayed'
          : replayDiagnostics.length > 0
            ? 'diagnostics'
            : 'ready';
  return Object.freeze({
    canonicalRows: replay === undefined ? noRows : canonicalRowsFor(replay),
    listDiagnostics,
    options: lifecycleOptions,
    replay,
    replayDiagnostics,
    requestRows: replay === undefined ? noRows : requestRowsFor(replay),
    resultDiagnostics: replay === undefined ? noResultDiagnostics : resultDiagnosticsFor(replay),
    selected,
    state,
    summary: summaryFor(state, replay),
  });
};
