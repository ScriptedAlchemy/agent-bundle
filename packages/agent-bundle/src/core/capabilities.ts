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
