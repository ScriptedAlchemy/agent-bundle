import type { JsonValue } from '../core/strict-json.ts';

/** The structural schema surface route props infer without coupling to one schema library. */
export interface RouteSchema<Output = unknown> {
  readonly _output: Output;
}

export type RouteSchemaOutput<Schema> = Schema extends RouteSchema<infer Output> ? Output : never;

/** The event-route families admitted by the recorded #97 v1/G10 decision. */
export const canonicalAgentEvents = Object.freeze([
  'session/start',
  'tool/before',
  'tool/after',
  'stop',
  'agent/start',
  'agent/stop',
  'workspace/open',
] as const);

export type CanonicalAgentEvent = (typeof canonicalAgentEvents)[number];

export interface AgentEventProvenance {
  readonly host: string;
  readonly hostContractRevision: string;
  readonly nativeEvent: string;
  readonly source: 'native';
}

/** Cross-host identity supplied to an event route without fabricated host fields. */
export interface AgentEventCanonicalIdentity {
  readonly event: CanonicalAgentEvent;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly provenance: AgentEventProvenance;
  readonly sequence: number;
}

/** Complete host envelope after the adapter's schema and byte-bound validation. */
export type AgentEventNativePayload = Readonly<Record<string, unknown>>;

/**
 * Props received by an event route's async default Server Component.
 *
 * Read transport-owned request identity with `await agent()` from
 * `@agent-bundle/runtime`. The invocation, host, session, actor, and workspace
 * axes are `Observed`, including typed unavailable reasons when the host
 * cannot know an axis. Business payload fields cannot override them.
 * Generated event scopes currently expose actor as unavailable.
 */
export interface AgentEventRouteProps {
  readonly canonical: AgentEventCanonicalIdentity;
  readonly native: AgentEventNativePayload;
  readonly signal: AbortSignal;
}

type AgentProviderInvocation =
  | {
    readonly kind: 'tool';
    readonly props: { readonly input: JsonValue; readonly operationId: string };
  }
  | {
    readonly kind: 'event';
    readonly props: { readonly event: string; readonly payload: JsonValue };
  }
  | {
    readonly kind: 'cli';
    readonly props: { readonly args: readonly string[]; readonly command: string };
  }
  | {
    readonly kind: 'script';
    readonly props: { readonly input?: JsonValue; readonly name: string };
  }
  | {
    readonly kind: 'workbench';
    readonly props: { readonly input?: JsonValue; readonly view: string };
  };

/** Request-scoped inputs supplied to a conventional context provider factory. */
export interface AgentProviderContext {
  readonly invocation: AgentProviderInvocation;
  readonly signal: AbortSignal;
}

/** Default export contract for one `src/providers/<name>.{ts,tsx}` module. */
export type AgentProviderFactory = (context: AgentProviderContext) => unknown | Promise<unknown>;

export type AgentEventDelivery = 'immediate';
export type AgentEventRuntimeMode = 'shared' | 'standalone';
export type AgentEventFallbackMode = 'none' | 'standalone';

/** Statically extractable event-route configuration. */
export interface AgentEventRouteConfig {
  readonly delivery?: readonly AgentEventDelivery[];
  readonly fallback?: AgentEventFallbackMode;
  readonly runtime?: AgentEventRuntimeMode;
  readonly targets?: readonly string[];
  /** Route budget within the adapter's stricter native-host deadline. */
  readonly timeoutMs?: number;
  /** Canonical tool selectors for tool/before and tool/after routes. */
  readonly tools?: readonly string[];
}

/**
 * Props received by every executable MCP route's async default Server Component.
 *
 * Read transport-owned invocation, host, session, actor, and workspace axes
 * with `await agent()` from `@agent-bundle/runtime`. Every identity axis is
 * `Observed`; unavailable axes carry a typed reason, and `input` cannot
 * override request identity.
 */
export interface ToolRouteProps<InputSchema extends RouteSchema> {
  readonly input: RouteSchemaOutput<InputSchema>;
  readonly signal: AbortSignal;
}

export interface ToolConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly description?: string;
  /** Project a validated result's integer `exitCode` when this tool is exposed through the generated CLI. */
  readonly exitCode?: 'result';
  readonly title?: string;
}

export interface ResourceConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly uri: string;
}

export interface PromptConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly title?: string;
}

export interface AppRouteConfig {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly resourceUri: string;
  readonly targets?: readonly string[];
  readonly template?: string;
}

/**
 * Static metadata of one `src/cli/**` command route (#102 stage 2). Every
 * field must stay inside the static route-config grammar; the command path
 * itself comes from the file path, never from config.
 */
export interface CliRouteConfig {
  /** Alternative command names at the same nesting level. */
  readonly aliases?: readonly string[];
  readonly description?: string;
  /**
   * Exit-code policy: omit for 0-on-success, or `'result'` to read the
   * validated result's integer `exitCode` property (0-255).
   */
  readonly exitCode?: 'result';
  /**
   * The `inputSchema` keys consumed as bare arguments, in order. All but the
   * last must be scalar; a trailing `z.array(...)` key is variadic. Keys not
   * named here become `--options`.
   */
  readonly positionals?: readonly string[];
}

/**
 * Props received by every routed CLI command's async default function.
 *
 * Read transport-owned invocation, host, session, actor, and workspace axes
 * with `await agent()` from `@agent-bundle/runtime`. Every identity axis is
 * `Observed`; unavailable axes carry a typed reason, and parsed command input
 * cannot override request identity.
 */
export interface CliRouteProps<InputSchema extends RouteSchema> {
  readonly input: RouteSchemaOutput<InputSchema>;
  readonly signal: AbortSignal;
}
