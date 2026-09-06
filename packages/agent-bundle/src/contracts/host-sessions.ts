/**
 * Browser-safe host-session identifiers. The Workbench and the generated
 * hook wrapper share this predicate; S1 owns the rest of this module.
 */
export const isHostSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^hs_[0-9a-z]{16}$/.test(value);
