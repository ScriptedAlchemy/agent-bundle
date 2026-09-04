import { CapabilityStateError, unknownCapabilityStateError } from '../core/capabilities.ts';
import type { CapabilityEvidence, CapabilityState } from '../core/capabilities.ts';
import { featureCapabilityName } from '../core/components.ts';
import {
  NOTICE_DELIVERY_ROUTES,
  NOTICE_SENSITIVITIES,
  type NoticeDeliveryAdvertisement,
  type NoticeDeliveryRoute,
  type NoticeDeliveryRouteState,
  type NoticeSensitivity,
} from './notice-delivery.ts';
import type { TargetAdapterMetadata } from './types.ts';

export { featureCapabilityName } from '../core/components.ts';

/** Builds immutable evidence from a target's pinned capability-table metadata. */
export const capabilityEvidence = (
  target: string,
  metadata: TargetAdapterMetadata,
): CapabilityEvidence => Object.freeze({
  observedVersion: metadata.observedVersion,
  target,
});

export const supportedCapability = (evidence: CapabilityEvidence): CapabilityState => Object.freeze({
  evidence,
  state: 'supported',
});

/**
 * The capability that admits the compiled routed CLI (`src/cli/**`) into a
 * target's host artifact as `bin/<plugin-name>.mjs` (#387). It asks nothing of
 * the host beyond what `scripts/` and `mcp/` entries already rely on — the
 * artifact root is installed as a plain directory Node can execute from — so a
 * target publishes it whenever its plugin root is such a directory. An adapter
 * that publishes no row reads as an honest `unavailable`, and the bin is
 * omitted from that target with an inspect entry naming the reason.
 */
export const cliBinCapability = 'cli';

export const unavailableCapability = (reason: string): CapabilityState => Object.freeze({
  reason,
  state: 'unavailable',
});

export interface EventRouteCapabilityTableEntry {
  readonly nativeEvent?: string;
  /**
   * The host's spelling of each canonical payload field for this family (#466):
   * the native key, or `{ nativeKey, decode }` when a transformation applies.
   * Mirrors `agentEventPayloadNativeKeys` in `routes/events.ts` (the runtime
   * table) so the generated events reference documents the mapping per host;
   * `tests/event-payload.test.ts` holds the two equal.
   */
  readonly payload?: Readonly<Record<string, string | { readonly decode?: string; readonly nativeKey: string }>>;
  readonly reason?: string;
  /** JSON imports widen literals; unsupported table states fail closed below. */
  readonly state: string;
}

/**
 * Converts a pinned host table's semantic-event rows into the shared
 * capability-state namespace consumed by route validation and inspect.
 */
export const eventRouteCapabilitiesFrom = (
  routes: Readonly<Record<string, EventRouteCapabilityTableEntry>>,
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => Object.freeze(Object.fromEntries(
  Object.entries(routes).sort(([left], [right]) => left.localeCompare(right)).map(([event, capability]) => {
    switch (capability.state) {
      case 'supported':
        return [`event:${event}`, supportedCapability(evidence)];
      case 'unavailable':
        return [
          `event:${event}`,
          unavailableCapability(capability.reason ?? `The pinned ${evidence.target} contract does not support ${event}.`),
        ];
      default:
        throw new TypeError(`Unsupported event-route capability state ${JSON.stringify(capability.state)} for ${event}.`);
    }
  }),
));

export const supportedEventRouteNamesFrom = (
  routes: Readonly<Record<string, EventRouteCapabilityTableEntry>>,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(routes)
    .filter(([, capability]) => capability.state === 'supported' && typeof capability.nativeEvent === 'string')
    .map(([event, capability]) => [event, capability.nativeEvent!]),
));

/** A pinned capability-table row: JSON imports widen the state literal, so unknown states fail closed. */
export interface CapabilityTableRow {
  readonly reason?: string;
  readonly state: string;
}

export interface NoticeDeliveryCapabilityTableEntry {
  readonly reason?: string;
  /** The most sensitive notice class the route carries in full; JSON widens the literal. */
  readonly sensitivity?: string;
  /** Dated evidence for `sensitivity`; required whenever a ceiling is named. */
  readonly sensitivityEvidence?: string;
  /** JSON imports widen literals; unknown table states fail closed below. */
  readonly state: string;
}

const sensitivityRank: Readonly<Record<NoticeSensitivity, number>> = Object.freeze({ internal: 1, public: 0, secret: 2 });

/** The ceiling a supported row admits; absent means `internal` (the pre-sensitivity contract). */
const routeCeiling = (entry: NoticeDeliveryRouteState): NoticeSensitivity | undefined =>
  entry.state === 'supported' ? entry.sensitivity ?? 'internal' : undefined;

const isNoticeSensitivity = (value: unknown): value is NoticeSensitivity =>
  typeof value === 'string' && (NOTICE_SENSITIVITIES as readonly string[]).includes(value);

/**
 * An `unavailable` notice route must say when the host was surveyed: the
 * reason carries an ISO calendar date (`YYYY-MM-DD`), as every pinned table
 * does, so the advertisement's evidence can be re-checked against a later pin.
 */
const DATED_REASON = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u;

/**
 * Converts one pinned table row into the shared capability-state namespace.
 * `supported` and `degraded` carry the adapter's pinned evidence identity;
 * `unavailable` and `prohibited` carry the table's dated reason.
 */
export const capabilityFromTableRow = (
  row: CapabilityTableRow,
  evidence: CapabilityEvidence,
): CapabilityState => {
  switch (row.state) {
    case 'supported':
      return supportedCapability(evidence);
    case 'degraded':
      return Object.freeze({ evidence, reason: row.reason ?? '', state: 'degraded' });
    case 'unavailable':
      return unavailableCapability(row.reason ?? `The pinned ${evidence.target} contract does not support this surface.`);
    case 'prohibited':
      return Object.freeze({
        reason: row.reason ?? `The pinned ${evidence.target} contract prohibits this surface.`,
        state: 'prohibited',
      });
    default:
      throw new TypeError(`Unsupported ${evidence.target} capability-table state ${JSON.stringify(row.state)}.`);
  }
};

/** Publishes one row per feature from a pinned `{ <feature>: row }` table block. */
export const featureCapabilitiesFrom = (
  kindCapability: string,
  features: Readonly<Record<string, CapabilityTableRow>>,
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => Object.freeze(Object.fromEntries(
  Object.entries(features)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, row]) => [featureCapabilityName(kindCapability, feature), capabilityFromTableRow(row, evidence)]),
));

/**
 * Publishes one row per frontmatter field from a pinned frontmatter block whose
 * single state covers every field (`fields` is a list or an authored→emitted map).
 */
export const frontmatterFeatureCapabilitiesFrom = (
  kindCapability: string,
  block: CapabilityTableRow & { readonly fields: readonly string[] | Readonly<Record<string, string>> },
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => {
  const fields = Array.isArray(block.fields) ? block.fields : Object.keys(block.fields);
  return Object.freeze(Object.fromEntries(
    [...fields]
      .sort((left, right) => left.localeCompare(right))
      .map((field) => [featureCapabilityName(kindCapability, field), capabilityFromTableRow(block, evidence)]),
  ));
};

/**
 * Converts a pinned host table's `noticeDelivery` rows into the typed
 * advertisement the notice router consumes (#99 stage 4). Every route in the
 * taxonomy must be present and `unavailable` rows must carry their dated
 * reason; a row the table does not know how to describe fails closed rather
 * than becoming a fabricated channel.
 */
export const noticeDeliveryAdvertisementFrom = (
  target: string,
  rows: Readonly<Record<string, NoticeDeliveryCapabilityTableEntry>>,
): NoticeDeliveryAdvertisement => {
  const entries = NOTICE_DELIVERY_ROUTES.map((route): [NoticeDeliveryRoute, NoticeDeliveryRouteState] => {
    const row = rows[route];
    if (row === undefined) {
      throw new CapabilityStateError(`The pinned ${target} table advertises no notice delivery route ${route}.`);
    }
    switch (row.state) {
      case 'supported': {
        if (row.sensitivity === undefined) return [route, Object.freeze({ state: 'supported' })];
        if (!isNoticeSensitivity(row.sensitivity)) {
          throw new CapabilityStateError(
            `Unsupported notice sensitivity ${JSON.stringify(row.sensitivity)} for ${route} in the pinned ${target} table.`,
          );
        }
        if (typeof row.sensitivityEvidence !== 'string' || !DATED_REASON.test(row.sensitivityEvidence)) {
          throw new CapabilityStateError(
            `The pinned ${target} table names a ${row.sensitivity} sensitivity ceiling for notice delivery route ${route} without dated evidence (an ISO date such as 2026-09-03 naming when the host was surveyed).`,
          );
        }
        return [route, Object.freeze({
          sensitivity: row.sensitivity,
          sensitivityEvidence: row.sensitivityEvidence,
          state: 'supported',
        })];
      }
      case 'unavailable':
        if (typeof row.reason !== 'string' || !DATED_REASON.test(row.reason)) {
          throw new CapabilityStateError(
            `The pinned ${target} table marks notice delivery route ${route} unavailable without a dated reason (an ISO date such as 2026-09-02 naming when the host was surveyed).`,
          );
        }
        return [route, Object.freeze({ reason: row.reason, state: 'unavailable' })];
      default:
        throw new CapabilityStateError(
          `Unsupported notice delivery route state ${JSON.stringify(row.state)} for ${route} in the pinned ${target} table.`,
        );
    }
  });
  return Object.freeze(Object.fromEntries(entries)) as NoticeDeliveryAdvertisement;
};

/**
 * Intersects host advertisements for a composite adapter: a route is
 * supported only where every host supports it, and the dated reasons of the
 * hosts that do not are kept so the composite stays as honest as its parts.
 * A supported route's sensitivity ceiling is the lower of the two, with the
 * evidence of the host that set it; two hosts at the same ceiling keep both
 * pieces of evidence.
 */
export const intersectNoticeDeliveryAdvertisements = (
  left: NoticeDeliveryAdvertisement,
  right: NoticeDeliveryAdvertisement,
): NoticeDeliveryAdvertisement => Object.freeze(Object.fromEntries(
  NOTICE_DELIVERY_ROUTES.map((route): [NoticeDeliveryRoute, NoticeDeliveryRouteState] => {
    const entries = [left[route], right[route]];
    const reasons = entries.flatMap((entry) => (entry.state === 'unavailable' ? [entry.reason] : []));
    if (reasons.length > 0) {
      return [route, Object.freeze({
        reason: [...new Set(reasons)].sort((first, second) => first.localeCompare(second)).join('; '),
        state: 'unavailable',
      })];
    }
    const ceilings = entries.map((entry) => routeCeiling(entry) ?? 'internal');
    const lowest = ceilings.reduce((low, ceiling) => (sensitivityRank[ceiling] < sensitivityRank[low] ? ceiling : low));
    const evidence = [...new Set(entries.flatMap((entry) =>
      entry.state === 'supported' && (entry.sensitivity ?? 'internal') === lowest && entry.sensitivityEvidence !== undefined
        ? [entry.sensitivityEvidence]
        : []))].sort((first, second) => first.localeCompare(second));
    // An `internal` ceiling nobody evidenced is the bare pre-sensitivity row;
    // a named ceiling always travels with the evidence of the host that set it.
    if (evidence.length === 0) {
      return [route, Object.freeze({ state: 'supported' })];
    }
    return [route, Object.freeze({
      sensitivity: lowest,
      sensitivityEvidence: evidence.join('; '),
      state: 'supported',
    })];
  }),
)) as NoticeDeliveryAdvertisement;

export const capabilityStateFromSupport = (
  supported: boolean,
  evidence: CapabilityEvidence,
  unavailableReason: string,
): CapabilityState => supported ? supportedCapability(evidence) : unavailableCapability(unavailableReason);

/** The temporary Boolean compatibility rule: only supported maps to true. */
export const capabilityIsSupported = (capability: CapabilityState | undefined): boolean => {
  if (capability === undefined) return false;
  switch (capability.state) {
    case 'supported':
      return true;
    case 'degraded':
    case 'unavailable':
    case 'prohibited':
      return false;
    default: {
      const exhaustive: never = capability;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};
