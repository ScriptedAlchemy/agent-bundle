/**
 * The canonical host-neutral component model (#100). Every project component
 * the compiler accounts for belongs to exactly one kind, and every kind that
 * needs a host surface names the capability row a target adapter must publish
 * for it, so `inspect` can explain each host's judgment in the host's words.
 *
 * `agent` is part of the canonical model but stays G5-deferred (#107 rev 3,
 * PR #220): no compiler path produces an `agent` component until a later
 * evidence-backed increment admits it. The row name is still published so the
 * deferral reads as a dated host judgment rather than a missing kind. `cli` is
 * the routed CLI bin (#387), hosted where the target's `cli` row allows.
 */
export type AgentComponentKind =
  | 'agent'
  | 'cli'
  | 'command'
  | 'event-route'
  | 'hook'
  | 'lsp'
  | 'mcp-app'
  | 'mcp-server'
  | 'native-diagnostics'
  | 'native-extension'
  | 'rule'
  | 'script'
  | 'skill';

/**
 * How a kind is judged against a target: `capability` names one fixed
 * capability row; `per-component` kinds (event routes) carry their own row per
 * component (`event:<canonical event>`); `none` kinds (scripts) need no host
 * surface at all.
 */
export type AgentComponentKindCapability =
  | { readonly capability: string; readonly mode: 'fixed' }
  | { readonly mode: 'none' }
  | { readonly mode: 'per-component' };

/** A Record over the union so a new kind cannot be added without judging it here. */
const componentKindCapabilities: Readonly<Record<AgentComponentKind, AgentComponentKindCapability>> = Object.freeze({
  agent: Object.freeze({ capability: 'agents', mode: 'fixed' as const }),
  cli: Object.freeze({ capability: 'cli', mode: 'fixed' as const }),
  command: Object.freeze({ capability: 'commands', mode: 'fixed' as const }),
  'event-route': Object.freeze({ mode: 'per-component' as const }),
  hook: Object.freeze({ capability: 'hooks', mode: 'fixed' as const }),
  lsp: Object.freeze({ capability: 'lsp', mode: 'fixed' as const }),
  'mcp-app': Object.freeze({ capability: 'mcp', mode: 'fixed' as const }),
  'mcp-server': Object.freeze({ capability: 'mcp', mode: 'fixed' as const }),
  'native-diagnostics': Object.freeze({ capability: 'nativeDiagnostics', mode: 'fixed' as const }),
  'native-extension': Object.freeze({ capability: 'nativeExtension', mode: 'fixed' as const }),
  rule: Object.freeze({ capability: 'rules', mode: 'fixed' as const }),
  script: Object.freeze({ mode: 'none' as const }),
  skill: Object.freeze({ capability: 'skills', mode: 'fixed' as const }),
});

/** Every canonical kind, sorted for stable inspection output. */
export const agentComponentKinds: readonly AgentComponentKind[] = Object.freeze(
  (Object.keys(componentKindCapabilities) as AgentComponentKind[]).sort((left, right) => left.localeCompare(right)),
);

export const componentKindCapability = (kind: AgentComponentKind): AgentComponentKindCapability =>
  componentKindCapabilities[kind];

/** The fixed capability row a kind needs, or undefined for per-component and capability-free kinds. */
export const componentKindCapabilityName = (kind: AgentComponentKind): string | undefined => {
  const judgment = componentKindCapabilities[kind];
  switch (judgment.mode) {
    case 'fixed':
      return judgment.capability;
    case 'none':
    case 'per-component':
      return undefined;
    default: {
      const exhaustive: never = judgment;
      throw new TypeError(`Unknown component kind capability mode ${JSON.stringify(exhaustive)}.`);
    }
  }
};
