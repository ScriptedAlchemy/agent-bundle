import { CodedError } from './errors.ts';

/** Evidence backing a supported or degraded capability judgment. */
export interface CapabilityEvidence {
  readonly capabilityRevision: string;
  readonly capabilitySha256: string;
  readonly observedVersion: string;
  readonly target: string;
}

/** Shared capability-state contract for adapters, routes, and projectors. */
export type CapabilityState =
  | { readonly state: 'supported'; readonly evidence: CapabilityEvidence }
  | { readonly state: 'degraded'; readonly reason: string; readonly evidence?: CapabilityEvidence }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'prohibited'; readonly reason: string };

/** Thrown when a declaration escapes the four-state capability contract. */
export class CapabilityStateError extends CodedError<'ERR_UNKNOWN_CAPABILITY_STATE'> {
  constructor(message: string) {
    super('CapabilityStateError', 'ERR_UNKNOWN_CAPABILITY_STATE', message);
  }
}

/** A Record over the union so a new state cannot be added without listing it here. */
const capabilityStateNameFlags: Readonly<Record<CapabilityState['state'], true>> = Object.freeze({
  degraded: true,
  prohibited: true,
  supported: true,
  unavailable: true,
});

/** The four contract states, sorted for stable diagnostics and error messages. */
export const capabilityStateNames: readonly string[] = Object.freeze(Object.keys(capabilityStateNameFlags).sort());

const isCapabilityStateName = (value: unknown): value is CapabilityState['state'] =>
  typeof value === 'string' && Object.hasOwn(capabilityStateNameFlags, value);

const isCapabilityEvidence = (value: unknown): value is CapabilityEvidence => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof CapabilityEvidence, unknown>>;
  return typeof candidate.capabilityRevision === 'string' &&
    typeof candidate.capabilitySha256 === 'string' &&
    typeof candidate.observedVersion === 'string' &&
    typeof candidate.target === 'string';
};

/**
 * Builds the error for a state outside the contract. The `never` parameter is
 * what makes every caller's `default` branch a compile-time exhaustiveness
 * check: a fifth state stops being assignable to `never` and fails the build.
 */
export const unknownCapabilityStateError = (capability: never): CapabilityStateError => {
  const { state } = capability as { readonly state?: unknown };
  return new CapabilityStateError(
    `Capability state ${JSON.stringify(state) ?? 'undefined'} is outside the ` +
      `${capabilityStateNames.join('/')} contract.`,
  );
};

/**
 * Validates an untyped capability declaration, including the fields each state
 * owns. JavaScript and third-party adapters reach the registry unchecked by the
 * compiler, so this is the boundary that keeps malformed states out.
 */
export const isCapabilityState = (value: unknown): value is CapabilityState => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly evidence?: unknown; readonly reason?: unknown; readonly state?: unknown };
  const { state } = candidate;
  if (!isCapabilityStateName(state)) return false;
  switch (state) {
    case 'supported':
      return isCapabilityEvidence(candidate.evidence);
    case 'degraded':
      return typeof candidate.reason === 'string' &&
        (candidate.evidence === undefined || isCapabilityEvidence(candidate.evidence));
    case 'unavailable':
    case 'prohibited':
      return typeof candidate.reason === 'string';
    default: {
      const exhaustive: never = state;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};
