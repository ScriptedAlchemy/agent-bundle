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
