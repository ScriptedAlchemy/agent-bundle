import { sha256Hex, stableJson } from '../core/digest.ts';
import { CapabilityStateError, unknownCapabilityStateError } from '../core/capabilities.ts';
import type { CapabilityEvidence, CapabilityState } from '../core/capabilities.ts';
import type { TargetAdapterMetadata } from './types.ts';

/** Builds immutable evidence from a target's pinned capability-table metadata. */
export const capabilityEvidence = (
  target: string,
  metadata: TargetAdapterMetadata,
): CapabilityEvidence => Object.freeze({
  capabilityRevision: metadata.capabilityRevision,
  capabilitySha256: metadata.capabilitySha256,
  observedVersion: metadata.observedVersion,
  target,
});

export const supportedCapability = (evidence: CapabilityEvidence): CapabilityState => Object.freeze({
  evidence,
  state: 'supported',
});

export const unavailableCapability = (reason: string): CapabilityState => Object.freeze({
  reason,
  state: 'unavailable',
});

export interface EventRouteCapabilityTableEntry {
  readonly nativeEvent?: string;
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

/** Immutable Boolean view retained for callers that have not migrated yet. */
export const capabilityBooleanView = (
  capabilities: Readonly<Record<string, CapabilityState>>,
): Readonly<Record<string, boolean>> => Object.freeze(Object.fromEntries(
  Object.entries(capabilities).map(([name, capability]) => [name, capabilityIsSupported(capability)]),
));

const evidenceFor = (capability: CapabilityState): CapabilityEvidence | undefined => {
  switch (capability.state) {
    case 'supported':
      return capability.evidence;
    case 'degraded':
      return capability.evidence;
    case 'unavailable':
    case 'prohibited':
      return undefined;
    default: {
      const exhaustive: never = capability;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};

const precedenceFor = (capability: CapabilityState): 0 | 1 | 2 | 3 => {
  switch (capability.state) {
    case 'supported':
      return 0;
    case 'degraded':
      return 1;
    case 'unavailable':
      return 2;
    case 'prohibited':
      return 3;
    default: {
      const exhaustive: never = capability;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};

const reasonFor = (capability: CapabilityState, precedence: 1 | 2 | 3): string | undefined => {
  switch (capability.state) {
    case 'supported':
      return undefined;
    case 'degraded':
      return precedence === 1 ? capability.reason : undefined;
    case 'unavailable':
      return precedence === 2 ? capability.reason : undefined;
    case 'prohibited':
      return precedence === 3 ? capability.reason : undefined;
    default: {
      const exhaustive: never = capability;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};

const mergedReason = (
  left: CapabilityState,
  right: CapabilityState,
  precedence: 1 | 2 | 3,
): string => [...new Set([reasonFor(left, precedence), reasonFor(right, precedence)]
  .filter((reason): reason is string => reason !== undefined))]
  .sort((first, second) => first.localeCompare(second))
  .join('; ');

/** Merges evidence without discarding either pinned table identity. */
export const mergeCapabilityEvidence = (
  left: CapabilityEvidence,
  right: CapabilityEvidence,
): CapabilityEvidence => {
  const evidence = [left, right].sort((first, second) => {
    const targetOrder = first.target.localeCompare(second.target);
    return targetOrder === 0 ? stableJson(first).localeCompare(stableJson(second)) : targetOrder;
  });
  return Object.freeze({
    capabilityRevision: evidence.map((entry) => `${entry.target}@${entry.capabilityRevision}`).join('+'),
    capabilitySha256: sha256Hex(stableJson(evidence)),
    observedVersion: evidence.map((entry) => `${entry.target}@${entry.observedVersion}`).join('+'),
    target: evidence.map((entry) => entry.target).join('+'),
  });
};

/**
 * Intersects two host judgments for a composite adapter. Prohibition dominates,
 * then unavailability, then degradation; two supported states merge evidence.
 */
export const intersectCapabilityStates = (
  left: CapabilityState,
  right: CapabilityState,
): CapabilityState => {
  const leftPrecedence = precedenceFor(left);
  const rightPrecedence = precedenceFor(right);
  const precedence = leftPrecedence > rightPrecedence ? leftPrecedence : rightPrecedence;
  switch (precedence) {
    case 0:
      if (left.state !== 'supported' || right.state !== 'supported') {
        throw new Error('Supported capability intersection lost its evidence invariant.');
      }
      return supportedCapability(mergeCapabilityEvidence(left.evidence, right.evidence));
    case 1: {
      const leftEvidence = evidenceFor(left);
      const rightEvidence = evidenceFor(right);
      const evidence = leftEvidence === undefined || rightEvidence === undefined
        ? undefined
        : mergeCapabilityEvidence(leftEvidence, rightEvidence);
      return Object.freeze({
        ...(evidence === undefined ? {} : { evidence }),
        reason: mergedReason(left, right, precedence),
        state: 'degraded',
      });
    }
    case 2:
      return Object.freeze({ reason: mergedReason(left, right, precedence), state: 'unavailable' });
    case 3:
      return Object.freeze({ reason: mergedReason(left, right, precedence), state: 'prohibited' });
    default: {
      const exhaustive: never = precedence;
      throw new CapabilityStateError(`Capability precedence ${String(exhaustive)} has no intersection rule.`);
    }
  }
};

/**
 * Unions two host judgments for composite emission dispatch: a composite
 * emits a surface if any host side does. Support dominates degradation,
 * unavailability, and prohibition; equally ranked supporting sides merge
 * evidence, while equally ranked non-supported sides merge reasons.
 */
export const unionCapabilityStates = (
  left: CapabilityState,
  right: CapabilityState,
): CapabilityState => {
  const leftPrecedence = precedenceFor(left);
  const rightPrecedence = precedenceFor(right);
  const precedence = leftPrecedence < rightPrecedence ? leftPrecedence : rightPrecedence;
  switch (precedence) {
    case 0:
      if (left.state === 'supported' && right.state === 'supported') {
        return supportedCapability(mergeCapabilityEvidence(left.evidence, right.evidence));
      }
      if (left.state === 'supported') return supportedCapability(left.evidence);
      if (right.state === 'supported') return supportedCapability(right.evidence);
      throw new Error('Supported capability union lost its evidence invariant.');
    case 1: {
      const leftEvidence = left.state === 'degraded' ? left.evidence : undefined;
      const rightEvidence = right.state === 'degraded' ? right.evidence : undefined;
      const evidence = leftEvidence === undefined
        ? rightEvidence
        : rightEvidence === undefined
          ? leftEvidence
          : mergeCapabilityEvidence(leftEvidence, rightEvidence);
      return Object.freeze({
        ...(evidence === undefined ? {} : { evidence }),
        reason: mergedReason(left, right, precedence),
        state: 'degraded',
      });
    }
    case 2:
      return Object.freeze({ reason: mergedReason(left, right, precedence), state: 'unavailable' });
    case 3:
      return Object.freeze({ reason: mergedReason(left, right, precedence), state: 'prohibited' });
    default: {
      const exhaustive: never = precedence;
      throw new CapabilityStateError(`Capability precedence ${String(exhaustive)} has no union rule.`);
    }
  }
};
