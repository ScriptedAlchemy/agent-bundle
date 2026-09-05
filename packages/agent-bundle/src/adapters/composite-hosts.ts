/**
 * The built-in hosts that compose into one plugin root (#555), and the
 * identity such a root takes. A leaf module: `config/validate.ts` judges a
 * target set's composability before any adapter is planned, and
 * `adapters/composite.ts` builds the root from the same names.
 */
export const compositeHostNames = Object.freeze(['claude', 'codex', 'cursor', 'portable'] as const);
export type CompositeHost = (typeof compositeHostNames)[number];

const hostOrder: Readonly<Record<CompositeHost, number>> = Object.freeze({ claude: 0, codex: 1, cursor: 2, portable: 3 });

export const isCompositeHost = (name: string): name is CompositeHost =>
  (compositeHostNames as readonly string[]).includes(name);

/** The selected host projections, deduplicated, in the composite's canonical order. */
export const sortedCompositeHosts = (names: readonly string[]): readonly CompositeHost[] =>
  Object.freeze([...new Set(names.filter(isCompositeHost))].sort((left, right) => hostOrder[left] - hostOrder[right]));

/**
 * The identity a composite root's generated code shares between its hook
 * wrappers and MCP entries (the event endpoint name). Never a host name, so it
 * cannot be mistaken for a projection; a single-host root uses the host name.
 */
export const compositeTargetName = (names: readonly string[]): string => {
  const hosts = sortedCompositeHosts(names);
  return hosts.length === 1 ? hosts[0]! : hosts.join('+');
};
