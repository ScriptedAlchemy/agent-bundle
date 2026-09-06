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
export {
  eventFamilyAllowsPreflightDeny,
  validateEventPreflightResult,
} from '../events/preflight.ts';
export type {
  EventPreflight,
  EventPreflightContext,
  EventPreflightResult,
} from '../events/preflight.ts';

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
 * host-specific fields the payload does not model; `preflight` is strict JSON
 * returned by the route's gate with an execute outcome.
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
export interface AgentEventRouteProps<
  E extends CanonicalAgentEvent = CanonicalAgentEvent,
  Preflight extends JsonValue = JsonValue,
> {
  readonly canonical: AgentEventCanonicalIdentity<E>;
  readonly native: AgentEventNativePayload;
  readonly preflight?: Preflight;
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

/**
 * An observed request axis as a provider receives it: the same shape as every
 * `agent()` identity axis, provenance included. Declared here so config-only
 * consumers need no `@agent-bundle/runtime` import; structurally the runtime's
 * `Observed<T>`.
 */
export type AgentProviderObserved<Value> =
  | { readonly source: 'native' | 'receipt' | 'derived'; readonly state: 'available'; readonly value: Value }
  | { readonly reason: string; readonly state: 'unavailable' };

/** Structurally the runtime's `AgentHostIdentity`: the host the request came through. */
export interface AgentProviderHostIdentity {
  readonly name: string;
}

/** Structurally the runtime's `AgentSessionIdentity`: the host session the request belongs to. */
export interface AgentProviderSessionIdentity {
  readonly sessionId: string;
}

/** Structurally the runtime's `AgentWorkspaceIdentity`: the workspace root the request runs in. */
export interface AgentProviderWorkspaceIdentity {
  readonly root: string;
}

/**
 * The plugin code root and framework state root a generated scope resolved
 * (#468), as `(await agent()).plugin` observes it: `root` is the code root —
 * the expanded `AGENT_BUNDLE_PLUGIN_ROOT` (`source: 'native'`) or the shell's
 * fallback (`'derived'`) — and `stateRoot` is the framework state root
 * (`AGENT_BUNDLE_STATE_ROOT`, else `~/.agent-bundle/state/<plugin>-<digest>`
 * or `$XDG_STATE_HOME/agent-bundle/<plugin>-<digest>` for an installed
 * artifact; `<root>/state` for the npm package bin and the test harnesses),
 * where the SQLite kernel, the notice ledger, and the lineage journal live.
 * Structurally identical to the runtime's `AgentPluginIdentity`.
 */
export interface AgentProviderPluginRoot {
  readonly root: string;
  readonly stateRoot: string;
}

/** The observed plugin root a provider receives; the same shape as every `agent()` identity axis. */
export type AgentProviderObservedPluginRoot = AgentProviderObserved<AgentProviderPluginRoot>;

/** Structurally the runtime's `AgentLineageSubagent`. */
export interface AgentProviderLineageSubagent {
  readonly id: string;
  readonly isParallelWorker?: boolean;
  readonly toolCallId?: string;
  readonly type?: string;
}

export type AgentProviderLineageResolution = 'native' | 'registry' | 'confirmed' | 'transcript' | 'inferred';

/** Structurally the runtime's `AgentLineagePeer` (#457): one other live conversation in the registry's tree. */
export interface AgentProviderLineagePeer {
  readonly conversation: string;
  readonly depth: number;
  readonly parent?: string;
  readonly resolution: AgentProviderLineageResolution;
  readonly startedAt: string;
  readonly subagent?: AgentProviderLineageSubagent;
}

/** Structurally the runtime's `AgentLineageTree` (#457). */
export interface AgentProviderLineageTree {
  readonly children: readonly AgentProviderLineagePeer[];
  readonly roots: readonly AgentProviderLineagePeer[];
  readonly siblings: readonly AgentProviderLineagePeer[];
}

/**
 * Structurally the runtime's `AgentLineage`: the request's own chain plus,
 * when the warm runtime's registry placed it, the live `tree` around it.
 */
export interface AgentProviderLineage {
  readonly conversation: string;
  readonly depth: number;
  readonly generation?: string;
  readonly parent?: string;
  readonly resolution: AgentProviderLineageResolution;
  readonly root: string;
  readonly subagent?: AgentProviderLineageSubagent;
  readonly tree?: AgentProviderLineageTree;
}

/** The snapshot a provider's `state.read()` resolves; structurally the runtime's `AgentStateSnapshot`. */
export interface AgentProviderStateSnapshot<TState = unknown> {
  readonly revision: number;
  readonly state: TState;
}

/**
 * The read-only view of the project's mounted state handle a provider receives
 * (#459): the runtime's `AgentStateHandle` narrowed to `lifetime` and `read`
 * by construction, so a provider can derive a view of shared state but never
 * dispatch. Absent for stateless projects and for surfaces that mount none.
 */
export interface AgentProviderStateHandle<TState = unknown> {
  readonly lifetime: 'request' | 'process' | 'workspace-durable' | 'external';
  read(options?: { readonly revision?: number; readonly signal?: AbortSignal }): Promise<AgentProviderStateSnapshot<TState>>;
}

export type AgentProviderNoticeState = 'pending' | 'attempted' | 'expired' | 'unavailable' | 'withdrawn' | 'acknowledged';

/**
 * Structurally the runtime's `AgentRecipient`: the conjunction of identity
 * axes a notice is addressed to. `conversation` and `root` are lineage ids.
 */
export interface AgentProviderNoticeRecipient {
  readonly actor?: { readonly id: string };
  readonly conversation?: string;
  readonly host?: AgentProviderHostIdentity;
  readonly root?: string;
  readonly session?: AgentProviderSessionIdentity;
  readonly workspace?: AgentProviderWorkspaceIdentity;
}

/** Structurally the runtime's `AgentNoticePublisher`: the identity `publish()` recorded (#460). */
export interface AgentProviderNoticePublisher {
  readonly actor?: { readonly id: string };
  readonly conversation?: string;
  readonly host?: AgentProviderHostIdentity;
  readonly session?: AgentProviderSessionIdentity;
  readonly workspace?: AgentProviderWorkspaceIdentity;
}

/** Structurally the runtime's `AgentNoticeAttemptReceipt`. */
export interface AgentProviderNoticeAttempt {
  readonly attemptedAt: string;
  readonly channel: 'next-event';
  readonly invocationId: string;
}

/** Structurally the runtime's `AgentNoticeWithholding`: a route's refusal to disclose the notice. */
export interface AgentProviderNoticeWithholding {
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly reason: 'route-unavailable' | 'sensitivity-exceeds-route';
}

/**
 * One notice as a provider reads it from `inbox()` or `published()`: every
 * field of the runtime's `AgentNotice`, spelled structurally. `content` is the
 * persisted Agent Document snapshot (the runtime's `AgentDocumentSnapshot`);
 * it is `unknown` here because the Agent Document types ship with the runtime,
 * so a provider that needs the authored text narrows it with the runtime's
 * types — a route reads the same notice through `(await agent()).notices`.
 */
export interface AgentProviderNotice {
  readonly acknowledgement?: { readonly acknowledgedAt: string; readonly invocationId: string };
  readonly attempts: readonly AgentProviderNoticeAttempt[];
  readonly availability?: { readonly channel: 'mcp-resource-updated'; readonly count: number; readonly firstAt: string; readonly lastAt: string };
  readonly availabilityReservation?: { readonly at: string; readonly key: string };
  readonly content: unknown;
  readonly createdAt: string;
  readonly dedupeKey?: string;
  readonly expiredAt?: string;
  readonly expiresAt?: string;
  readonly exposure?: { readonly channel: 'mcp-inbox'; readonly count: number; readonly firstAt: string; readonly lastAt: string; readonly lastInvocationId: string };
  readonly id: string;
  readonly nextAttemptAt?: string;
  readonly priority: 'low' | 'normal' | 'high';
  readonly publisher?: AgentProviderNoticePublisher;
  readonly recipient: AgentProviderNoticeRecipient;
  readonly retryBudget?: number;
  readonly sensitivity?: 'public' | 'internal' | 'secret';
  readonly state: AgentProviderNoticeState;
  readonly unavailableAt?: string;
  readonly unavailableReason?: 'delivery-authorization-unavailable';
  readonly withdrawnAt?: string;
  readonly withheld?: Readonly<Partial<Record<string, AgentProviderNoticeWithholding>>>;
}

/**
 * The read-only view of the request's notice handle a provider receives
 * (#459): the runtime's `AgentNoticesHandle` narrowed by construction to
 * `inbox` — pending notices addressed to this request's principal, as the
 * `mcp-inbox` route discloses them — and `published` — what became of the
 * notices this principal published, in every state (#460). Never `publish`,
 * `acknowledge`, or the admission-bound `read`. Absent when the project mounts
 * no notice ledger.
 */
export interface AgentProviderNoticesHandle {
  inbox(): Promise<readonly AgentProviderNotice[]>;
  published(): Promise<readonly AgentProviderNotice[]>;
}

/**
 * Request-scoped inputs supplied to a conventional context provider factory.
 * Beyond the surface-specific `invocation` and the request `signal`, a
 * factory observes the request's identity axes (`host`, `session`,
 * `workspace`, `plugin`) and `lineage` exactly as the route will read them
 * from `await agent()` — the same `Observed` values, provenance included — plus
 * read-only views of the mounted state and notice handles (#459). Providers
 * run after the request's handles exist and before the route, outside the
 * request's async context: `agent()` throws `outside-invocation` there, and
 * nothing on this context can dispatch state or publish a notice.
 */
export interface AgentProviderContext {
  readonly host: AgentProviderObserved<AgentProviderHostIdentity>;
  readonly invocation: AgentProviderInvocation;
  readonly lineage: AgentProviderObserved<AgentProviderLineage>;
  /** Present only for projects with a mounted notice ledger. */
  readonly notices?: AgentProviderNoticesHandle;
  /** The resolved plugin root, exactly what the route will read as `(await agent()).plugin`. */
  readonly plugin: AgentProviderObservedPluginRoot;
  readonly session: AgentProviderObserved<AgentProviderSessionIdentity>;
  readonly signal: AbortSignal;
  /** Present only for projects that declare `src/state.ts`. */
  readonly state?: AgentProviderStateHandle;
  readonly workspace: AgentProviderObserved<AgentProviderWorkspaceIdentity>;
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
  /**
   * Conventional provider keys this route resolves. Omit to preserve the
   * compatibility behavior of resolving all providers; use `[]` for none.
   */
  readonly providers?: readonly string[];
  /** Capability rows every projected host must support; mutually exclusive with `targets`. */
  readonly requires?: readonly string[];
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

/**
 * How a tool may be called as an MCP task (the `2025-11-25` Tasks utility,
 * `Tool.execution.taskSupport`). `forbidden` — the wire default when the
 * field is absent — means every call is an ordinary request. `optional` lets
 * a client that asks for task-augmented execution receive a `CreateTaskResult`
 * at once and poll `tasks/get` / `tasks/result` for the final `CallToolResult`
 * while the render continues; a client that does not ask sees no change.
 * `required` refuses an ordinary call with JSON-RPC `-32601`. The compiler
 * validates the value (`AB4836`); the generated server advertises it in
 * `tools/list` and declares the `tasks` capability only when at least one
 * tool opted in.
 */
export type ToolTaskSupport = 'forbidden' | 'optional' | 'required';

/** The `Tool.execution` block a tool route declares statically in `config.execution`. */
export interface ToolExecutionConfig {
  readonly taskSupport?: ToolTaskSupport;
}

export interface ToolConfig {
  readonly _meta?: RouteMeta;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly description?: string;
  /** Task-augmented execution of this tool (`execution.taskSupport`); see {@link ToolTaskSupport}. */
  readonly execution?: ToolExecutionConfig;
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

/** A literal a CLI projection may declare as `flags.<key>.default`: what the argv grammar itself can spell. */
export type CliProjectionFlagDefault =
  | boolean
  | number
  | string
  | readonly (boolean | number | string)[];

/**
 * How a CLI projection spells one canonical input key on argv. Every field
 * is optional; an absent flag entry keeps the default policy (the kebab-cased
 * key as `--option`, the schema's `.describe()` and `.default()`).
 */
export interface CliProjectionFlagConfig {
  /** Extra long-form spellings (kebab-case, no leading dashes) accepted beside `name`. */
  readonly aliases?: readonly string[];
  /**
   * A CLI-only default the shell fills in before the canonical `inputSchema`
   * reads the input; on a canonical-required key it is legal only when the
   * module exports `mapInput`, and the key is listed as relaxed.
   */
  readonly default?: CliProjectionFlagDefault;
  /** Help text; overrides the schema's `.describe()`. */
  readonly description?: string;
  /** The CLI spelling (kebab-case, no leading dashes); default: the kebab-cased key. */
  readonly name?: string;
  /**
   * Relax a canonical-required key so the option may be omitted on argv;
   * legal only when the module exports `mapInput`, which must then supply
   * the key before the canonical schema validates.
   */
  readonly required?: false;
}

/**
 * The keys of a schema's input object, as `keyof z.input<Schema>` reads them:
 * a zod schema declares `_input`; a schema declaring only `_output` (the
 * structural {@link RouteSchema}) falls back to its output keys.
 */
export type RouteSchemaInputKey<Schema> = Schema extends { readonly _input: infer Input }
  ? keyof Input & string
  : Schema extends RouteSchema<infer Output>
    ? keyof Output & string
    : string;

/**
 * The `config` export of a tool's CLI surface projection module,
 * `src/mcp/<server>/tools/<tool>.cli.{ts,tsx}` (#596). The module is never a
 * route: it projects the sibling tool route onto one idiomatic command whose
 * identity stays the tool's. Every field must stay inside the static
 * route-config grammar; `flags` and `positionals` name canonical keys of the
 * tool's `inputSchema`, so declare it as
 * `satisfies CliProjectionConfig<typeof inputSchema>` with
 * `import type { inputSchema } from './<tool>.js'`. The module may also export
 * a synchronous `mapInput(input)` the shell applies to the parsed argv before
 * the canonical schema validates.
 */
export interface CliProjectionConfig<Schema = RouteSchema<Readonly<Record<string, unknown>>>> {
  /** Alternative command names at the same nesting level (the `src/cli` alias rules apply). */
  readonly aliases?: readonly string[];
  /** Command path segments; default `[<tool>]`. Each must be a safe identity segment. */
  readonly command?: readonly string[];
  /** Require `--yes` before running; default: `!(annotations.readOnlyHint === true)` of the tool. */
  readonly confirm?: boolean;
  /** Help text; default: the tool's `config.description`. */
  readonly description?: string;
  /** Exit-code policy; default: the tool's `config.exitCode`, else `'zero'`. */
  readonly exitCode?: 'result' | 'zero';
  /** Per canonical key: the CLI spelling, aliases, description, default, and relaxed requirement. */
  readonly flags?: Partial<Readonly<Record<RouteSchemaInputKey<Schema>, CliProjectionFlagConfig>>>;
  /** Canonical keys consumed as bare arguments, in order (the `src/cli` positional rules apply). */
  readonly positionals?: readonly RouteSchemaInputKey<Schema>[];
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
