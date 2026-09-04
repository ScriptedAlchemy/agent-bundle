import type { CanonicalHookEvent } from '../core/types.ts';
import type { JsonObject, JsonValue } from '../dev/types.ts';

/**
 * The typed contract of a config-declared hook handler (`hooks.<event>.handler`,
 * #488): the event payload the generated wrapper hands the default export and
 * the result it validates before projecting it into host-native output.
 *
 * Both sides are derived from one table per handler event so that the types
 * and the wrappers' runtime `validateResult` cannot drift: the table is the
 * *portable* contract — a result field it admits is accepted by every host
 * wrapper (`Claude`, `Codex`, `Universal`, and `cursor`) *and* projected into
 * that host's native output — and `tests/hook-handler-contract.test.ts` runs
 * the generated wrappers against it. Host-specific behaviour is not part of
 * the type, because a handler typed here must run unchanged on every host it
 * targets: Cursor admits a denying `agentStart`; Claude and Codex accept
 * `additionalContext` on `beforeTool` and `agentStart` (Cursor validates but
 * has no channel for it there); Claude carries `additionalContext` on
 * `agentStop`. The wrappers keep their runtime validation for untyped and
 * prebuilt handlers.
 */

/**
 * The canonical events a config hook (`hooks.<event>.handler`) can be declared
 * for: the events every production host maps to a native plain hook.
 * `workspaceOpen` is a `CanonicalHookEvent` but no host maps it as a plain
 * hook — it is served by an event route — so it has no handler contract.
 */
export const hookHandlerEventNames = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
  'agentStart',
  'agentStop',
] as const satisfies readonly CanonicalHookEvent[];

export type HookHandlerEventName = (typeof hookHandlerEventNames)[number];

/** What a hook result may carry for one handler event, on every host. */
export interface HookResultRule {
  /** `additionalContext` is accepted and projected into the agent's context on every host. */
  readonly additionalContext: boolean;
  /**
   * `{ outcome: 'deny', reason }` is a legal result (a denial always needs a
   * non-empty `reason`). Cursor consumes an `agentStop` denial only for a
   * subagent that completed (`nativeInput.status === "completed"`); denying an
   * errored or aborted one fails the hook there, so a handler targeting Cursor
   * checks `context.nativeInput.status` first.
   */
  readonly deny: boolean;
  /** A continuing result may replace the pending call's input with `updatedInput`. */
  readonly updatedInput: boolean;
}

/**
 * The per-event result contract the generated wrappers enforce, as the
 * portable intersection across hosts. No event admits `outcome: 'stop'`;
 * `reason` is legal only beside `outcome: 'deny'`; `updatedInput` is never
 * legal while denying.
 */
export const hookResultContract = {
  afterTool: { additionalContext: true, deny: false, updatedInput: false },
  // Claude and Codex accept `additionalContext` here; Cursor's subagentStart has no context channel.
  agentStart: { additionalContext: false, deny: false, updatedInput: false },
  // Claude carries `additionalContext` on SubagentStop; Codex and Cursor reject it. See HookResultRule.deny for Cursor's status rule.
  agentStop: { additionalContext: false, deny: true, updatedInput: false },
  // Claude and Codex project `additionalContext` on PreToolUse; Cursor's preToolUse output carries only a permission or an input rewrite.
  beforeTool: { additionalContext: false, deny: true, updatedInput: true },
  sessionStart: { additionalContext: true, deny: false, updatedInput: false },
  stop: { additionalContext: false, deny: true, updatedInput: false },
} as const satisfies Readonly<Record<HookHandlerEventName, HookResultRule>>;

export type HookResultContract = typeof hookResultContract;

type WithAdditionalContext<E extends HookHandlerEventName> = HookResultContract[E]['additionalContext'] extends true
  ? { readonly additionalContext?: string }
  : { readonly additionalContext?: never };

type WithUpdatedInput<E extends HookHandlerEventName> = HookResultContract[E]['updatedInput'] extends true
  ? { readonly updatedInput?: JsonObject }
  : { readonly updatedInput?: never };

/** A continuing result: `outcome` may be omitted, and `reason` is never legal here. */
export type HookContinueResult<E extends HookHandlerEventName> = {
  readonly outcome?: 'continue';
  readonly reason?: never;
} & WithAdditionalContext<E> & WithUpdatedInput<E>;

/** A denying result, for the events whose hosts honour a denial; `updatedInput` is never legal while denying. */
export type HookDenyResult<E extends HookHandlerEventName> = HookResultContract[E]['deny'] extends true
  ? {
      readonly outcome: 'deny';
      /** Non-empty: the wrapper rejects a denial without one. */
      readonly reason: string;
      readonly updatedInput?: never;
    } & WithAdditionalContext<E>
  : never;

/**
 * The result a handler for event `E` may return. Returning nothing
 * (`void`) continues; the generated wrapper still validates every returned
 * object at hook time, so JavaScript and prebuilt handlers keep the same
 * runtime contract.
 */
export type HookResult<E extends HookHandlerEventName> = HookContinueResult<E> | HookDenyResult<E>;

/**
 * The payload fields every handler event carries. Fields are required
 * only when every host's wrapper guarantees them; `sessionId` is the one
 * identity every host names. `transcriptPath` is `null` on Codex when no
 * rollout exists yet.
 */
export interface HookEventBase {
  readonly cwd?: string;
  readonly effort?: string;
  readonly hookEventName?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly promptId?: string;
  readonly sessionId: string;
  readonly transcriptPath?: string | null;
  readonly turnId?: string;
}

export interface SessionStartHookEvent extends HookEventBase {
  /** How the session began (`startup`, `resume`, …); absent on Cursor. */
  readonly source?: string;
}

export interface BeforeToolHookEvent extends HookEventBase {
  /** The pending call's input; an object on Claude and Cursor, any JSON value on Codex. */
  readonly toolInput: JsonValue;
  readonly toolName: string;
  readonly toolUseId: string;
}

export interface AfterToolHookEvent extends BeforeToolHookEvent {
  /** The completed call's response; Claude delivers an MCP tool's response as a plain string. */
  readonly toolResponse: JsonValue;
}

export interface StopHookEvent extends HookEventBase {
  readonly lastAssistantMessage?: string | null;
  /** Whether this stop hook is already running for the turn (loop guard). */
  readonly stopHookActive: boolean;
}

export interface AgentStartHookEvent extends HookEventBase {
  readonly agentId: string;
  readonly agentType: string;
  /** The spawning tool call on Cursor. */
  readonly toolUseId?: string;
}

export interface AgentStopHookEvent extends HookEventBase {
  /** Absent on Cursor, whose subagentStop names no agent id. */
  readonly agentId?: string;
  readonly agentTranscriptPath?: string | null;
  readonly agentType: string;
  readonly lastAssistantMessage?: string | null;
  readonly stopHookActive: boolean;
}

/** The per-event payload a config hook handler receives, keyed by handler event. */
export interface HookEventPayloads {
  readonly afterTool: AfterToolHookEvent;
  readonly agentStart: AgentStartHookEvent;
  readonly agentStop: AgentStopHookEvent;
  readonly beforeTool: BeforeToolHookEvent;
  readonly sessionStart: SessionStartHookEvent;
  readonly stop: StopHookEvent;
}

/** The event payload a handler for event `E` receives. */
export type HookEvent<E extends HookHandlerEventName> = HookEventPayloads[E];

/**
 * The payload fields per canonical event, as the wrappers decode them: the
 * runtime twin of {@link HookEventPayloads}, so a test can hold a generated
 * wrapper's decoder to the same field set the types declare. `required`
 * fields are present on every host; `optional` ones are host-dependent.
 */
export const hookEventFields = {
  afterTool: {
    optional: ['cwd', 'effort', 'hookEventName', 'model', 'permissionMode', 'promptId', 'transcriptPath', 'turnId'],
    required: ['sessionId', 'toolInput', 'toolName', 'toolResponse', 'toolUseId'],
  },
  agentStart: {
    optional: ['cwd', 'effort', 'hookEventName', 'model', 'permissionMode', 'promptId', 'toolUseId', 'transcriptPath', 'turnId'],
    required: ['agentId', 'agentType', 'sessionId'],
  },
  agentStop: {
    optional: ['agentId', 'agentTranscriptPath', 'cwd', 'effort', 'hookEventName', 'lastAssistantMessage', 'model', 'permissionMode', 'promptId', 'transcriptPath', 'turnId'],
    required: ['agentType', 'sessionId', 'stopHookActive'],
  },
  beforeTool: {
    optional: ['cwd', 'effort', 'hookEventName', 'model', 'permissionMode', 'promptId', 'transcriptPath', 'turnId'],
    required: ['sessionId', 'toolInput', 'toolName', 'toolUseId'],
  },
  sessionStart: {
    optional: ['cwd', 'effort', 'hookEventName', 'model', 'permissionMode', 'promptId', 'source', 'transcriptPath', 'turnId'],
    required: ['sessionId'],
  },
  stop: {
    optional: ['cwd', 'effort', 'hookEventName', 'lastAssistantMessage', 'model', 'permissionMode', 'promptId', 'transcriptPath', 'turnId'],
    required: ['sessionId', 'stopHookActive'],
  },
} as const satisfies Readonly<Record<HookHandlerEventName, { readonly optional: readonly string[]; readonly required: readonly string[] }>>;

export type HookEventFields = typeof hookEventFields;

/**
 * What the generated wrapper hands a handler beside the decoded event: the
 * host that invoked it, that host's native event name, and the validated
 * native input verbatim, for a handler that needs a host-specific field.
 */
export interface HookHandlerContext {
  readonly nativeEvent: string;
  readonly nativeInput: Readonly<Record<string, unknown>>;
  readonly target: 'claude' | 'codex' | 'cursor';
}

/**
 * A config-declared hook handler module's default export for event `E`. Author it as
 * `export default ((event) => ({ ... })) satisfies HookHandler<'sessionStart'>;`
 * and an illegal result — a denying `sessionStart`, a `reason` beside
 * `continue`, `updatedInput` on a `stop` hook — is rejected by `tsc` instead
 * of by the wrapper at hook time. The wrapper's runtime validation is
 * unchanged, so a JavaScript or prebuilt handler is held to the same contract.
 */
export type HookHandler<E extends HookHandlerEventName> = (
  event: HookEvent<E>,
  context: HookHandlerContext,
) => HookResult<E> | undefined | void | Promise<HookResult<E> | undefined | void>;
