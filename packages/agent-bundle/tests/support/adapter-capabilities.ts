import { supportedCapability } from '../../src/adapters/capability-state.ts';
import type { CapabilityEvidence, CapabilityState } from '../../src/core/capabilities.ts';

const evidence: CapabilityEvidence = Object.freeze({
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  target: 'test',
});

export const supportedCapabilities = (
  ...names: readonly string[]
): Readonly<Record<string, CapabilityState>> => Object.freeze(Object.fromEntries(
  names.map((name) => [name, supportedCapability(evidence)]),
));
