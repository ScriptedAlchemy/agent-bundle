import type { JsonValue } from '../core/strict-json.ts';
import type { AgentTerminal } from '../terminal-capability.ts';
import type { AgentEventPayload, CanonicalAgentEvent } from './events.ts';

export {
  agentEventPayloadFieldKinds,
  agentEventPayloadFields,
  agentEventPayloadNativeKeys,
  canonicalAgentEvents,
} from './events.ts';
export type {
  AgentEventPayload,
  AgentEventPayloadField,
  AgentEventPayloadFieldKind,
  AgentEventPayloadFieldName,
  AgentEventPayloadFields,
  AgentEventPayloadFieldTypes,
  AgentEventPayloadHost,
  AgentEventPayloadNativeKey,
  CanonicalAgentEvent,
} from './events.ts';

/** The structural schema surface route props infer without coupling to one schema library. */
export interface RouteSchema<Output = unknown> {
  readonly _output: Output;
}

export type RouteSchemaOutput<Schema> = Schema extends RouteSchema<infer Output> ? Output : never;

export interface AgentEventProvenance {
  readonly host: string;
  readonly hostContractRevision: string;
  readonly nativeEvent: string;
  readonly source: 'native';
}

/**
 * Cross-host identity supplied to an event route without fabricated host
 * fields, plus the canonical `payload` of its family (#466): the fields at
 * least two hosts report — tool name, input, and response, session id,
 * transcript path, stop re-entry, prompt text, agent id and type, … — each
 * carrying the host's own key as provenance, and absent when the host did
 * not send it. `E` narrows `payload` to the family the route handles.
 */
export interface AgentEventCanonicalIdentity<E extends CanonicalAgentEvent = CanonicalAgentEvent> {
  readonly event: E;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly payload: AgentEventPayload<E>;
  readonly provenance: AgentEventProvenance;
  readonly sequence: number;
}

/** Complete host envelope after the adapter's schema and byte-bound validation. */
export type AgentEventNativePayload = Readonly<Record<string, unknown>>;

/**
 * Props received by an event route's async default Server Component.
 * `canonical.payload` is the cross-host reading of the envelope for the
 * route's family; `native` is the frozen host envelope itself, for the
 * host-specific fields the payload does not model.
 *
 * Read transport-owned request context with `await agent()` from
 * `@agent-bundle/runtime`. The invocation, host, session, actor, workspace,
 * and lineage axes are `Observed`, including typed unavailable reasons when
 * the host cannot know an axis. Business payload fields cannot override them.
 * `lineage` answers "who is my parent, what is the root, am I a subagent";
 * `actor` is the HTTP-authenticated client of a streamable MCP transport and
 * is unavailable on hook-driven event scopes. The framework never derives or
 * surfaces the operator's identity from a host payload.
 */
export interface AgentEventRouteProps<E extends CanonicalAgentEvent = CanonicalAgentEvent> {
  readonly canonical: AgentEventCanonicalIdentity<E>;
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

/** The route kinds a conventional layout wraps; event routes are host protocol responses and stay unwrapped. */
export type AgentLayoutRouteKind = 'tool' | 'resource' | 'prompt' | 'cli' | 'script';

/**
 * Stable identity of the route a layout is wrapping, baked at compile time
 * from the route graph. `name` is the protocol-facing name: the MCP tool,
 * resource, or prompt name, the space-joined CLI command path, or the script
 * name. The layout component's props type, `AgentLayoutProps`, ships from
 * `@agent-bundle/runtime` because it carries React's `ReactNode` children and
 * this package's root declarations stay React-free for config-only consumers.
 */
export interface AgentLayoutRoute {
  readonly id: string;
  readonly kind: AgentLayoutRouteKind;
  readonly name: string;
  /** The owning MCP server id (`mcp:<name>`); MCP route kinds only. */
  readonly serverId?: string;
}

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

/**
 * The MCP Apps `_meta.ui` block a tool, resource, or prompt stamps on its
 * listing so hosts open the referenced App beside the result. Set
 * `resourceUri` to {@link appResourceUri} of the App route instead of
 * repeating the App's `ui://` literal: the compiler resolves the reference
 * to the App's static `config.resourceUri`, so the two can never drift. The
 * block stays open for the rest of the MCP Apps `ui` vocabulary
 * (`prefersBorder`, `csp`, `permissions`, …).
 */
export interface RouteUiMeta {
  readonly [key: string]: unknown;
  readonly resourceUri?: string;
}

/**
 * Listing-level `_meta` of an MCP route. It stays inside the static
 * route-config grammar (see the diagnostics reference), with `ui` typed so
 * `_meta.ui.resourceUri` can reference an App route.
 */
export type RouteMeta = Readonly<Record<string, unknown>> & {
  readonly ui?: RouteUiMeta;
};

/**
 * References an MCP App route's `config.resourceUri` from another route's
 * static `config` (typically `_meta.ui.resourceUri`). The App must belong to
 * the same generated server as the referencing route — a generated server
 * registers only its own Apps. Accepted references:
 *
 * - `'<app>'` — the App route `src/mcp/<server>/apps/<app>.{ts,tsx}` of the
 *   referencing route's server;
 * - `'<server>/<app>'` or `'app:<server>/<app>'` — the same App by route id;
 * - `'./…'` or `'../…'` — the App route module relative to the referencing
 *   module, with or without its `.ts`/`.tsx` extension.
 *
 * The compiler evaluates the call statically while extracting `config` and
 * replaces it with the target App's `resourceUri`; a reference to no App of
 * the same server is `AB4826`. The route module still evaluates at run time (generated entries
 * import it for its default export), where the call returns the reference
 * unchanged — generated servers read the compiled config, never this value.
 */
export const appResourceUri = (reference: string): string => reference;

/**
 * The render budget a rendered route declares statically in `config.render`.
 * Every rendered route runs inside one render session bounded by the runtime's
 * default limits; a long-running route (a build await, a long poll) raises
 * `maxElapsedMs` here instead of clamping its own waits. The compiler
 * validates the value (`AB4835`: a positive integer of milliseconds up to
 * {@link MAX_ROUTE_RENDER_ELAPSED_MS}), and the generated MCP server, the
 * routed CLI, and the route-unit harness apply it to that route's render
 * session — the host's own tool-call deadline still applies on top.
 */
export interface RouteRenderConfig {
  /** Wall-clock budget of one render of this route, in milliseconds; the runtime default is 60 000. */
  readonly maxElapsedMs?: number;
}

/**
 * The ceiling `config.render.maxElapsedMs` may declare: 24 hours. The value
 * stays inside Claude Code's default per-call wall clock (`MCP_TOOL_TIMEOUT`,
 * about 28 hours); Codex (`tool_timeout_sec`, 60 s by default) and any
 * per-server host setting must be raised separately by the operator.
 */
export const MAX_ROUTE_RENDER_ELAPSED_MS = 24 * 60 * 60 * 1000;

export interface ToolConfig {
  readonly _meta?: RouteMeta;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly description?: string;
  /** Project a validated result's integer `exitCode` when this tool is exposed through the generated CLI. */
  readonly exitCode?: 'result';
  /** The render budget of one call; also inherited by the tool's projected CLI command. */
  readonly render?: RouteRenderConfig;
  readonly title?: string;
}

export interface ResourceConfig {
  readonly _meta?: RouteMeta;
  readonly description?: string;
  readonly mimeType?: string;
  /** The render budget of one read. */
  readonly render?: RouteRenderConfig;
  readonly title?: string;
  readonly uri: string;
}

export interface PromptConfig {
  readonly _meta?: RouteMeta;
  readonly description?: string;
  /** The render budget of one get. */
  readonly render?: RouteRenderConfig;
  readonly title?: string;
}

export interface AppRouteConfig {
  readonly _meta?: RouteMeta;
  readonly resourceUri: string;
  readonly targets?: readonly string[];
  /**
   * Optional HTML shell for the compiled App. The path resolves relative to
   * the route module, the way its imports do (`'./dashboard.html'`); the
   * older project-root-relative form is still accepted while only one of the
   * two interpretations names an existing file. When both exist and differ,
   * or neither exists, the build fails with `AB4827` naming both candidates.
   */
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
  /** The render budget of one rendered (`.tsx`) command run; plain commands ignore it. */
  readonly render?: RouteRenderConfig;
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

/**
 * Props received by a rendered script's (`src/scripts/<name>.tsx`) async
 * default Server Component: the argv left after the framework reserved
 * `--json` / `--ndjson`, exactly as the generated executable passes it, and
 * the request abort signal.
 */
export interface ScriptRouteProps {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
}

export type {
  AgentTerminal,
  AgentTerminalColor,
  AgentTerminalStream,
  AgentTerminalStreamKind,
  AgentTerminalSurface,
} from '../terminal-capability.ts';

/**
 * The second argument the generated executable envelope passes to a plain
 * script's or bin's `main(argv, context)` (#511): the process's terminal
 * capability, probed once before `main` runs. A rendered route reads the same
 * shape from `(await agent()).terminal`; a plain script has no request scope,
 * so the envelope hands it the value directly.
 */
export interface ExecutableMainContext {
  readonly terminal: AgentTerminal;
}
