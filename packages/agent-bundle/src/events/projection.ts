import { createHash } from 'node:crypto';

import type { AgentDocument, AgentDocumentNode } from '@agent-bundle/runtime';
import { z } from 'zod';

import { deepFreeze } from '../core/freeze.ts';
import type {
  AgentEventCanonicalIdentity,
  AgentEventRouteProps,
  CanonicalAgentEvent,
} from '../routes/public.ts';

/**
 * The route result vocabulary. `continue` (or no value at all) is the
 * pass-through answer: the route has no opinion, so no decision reaches the
 * host and its normal permission flow applies. `allow` and `ask` are explicit
 * `tool/before` and `model-switch/before` decisions (`allow` also answers
 * `permission/request`); `deny` blocks. Only an explicit decision is ever
 * projected as one (#461).
 */
const resultValueSchema = z.object({
  outcome: z.enum(['continue', 'allow', 'ask', 'deny']).optional(),
  reason: z.string().min(1).optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
}).strict();

let eventSequence = 0;

const snapshotNative = (native: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.freeze(structuredClone(native));

export interface NativeEventEnvelopeValidation {
  readonly canonicalEvent: CanonicalAgentEvent;
  readonly nativeEvent: string;
  readonly target: string;
}

const nativeEventError = (message: string): never => {
  throw new Error(`Agent Bundle event route error: ${message}`);
};

const requireNativeString = (input: Readonly<Record<string, unknown>>, field: string): void => {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    nativeEventError(`native ${field} must be a nonempty string`);
  }
};

const requireNativeStringValue = (input: Readonly<Record<string, unknown>>, field: string): void => {
  if (typeof input[field] !== 'string') {
    nativeEventError(`native ${field} must be a string`);
  }
};

const requireNativeNumber = (input: Readonly<Record<string, unknown>>, field: string): void => {
  if (typeof input[field] !== 'number') {
    nativeEventError(`native ${field} must be a number`);
  }
};

const requireNativeBoolean = (input: Readonly<Record<string, unknown>>, field: string): void => {
  if (typeof input[field] !== 'boolean') {
    nativeEventError(`native ${field} must be a boolean`);
  }
};

const requireCompactTrigger = (native: Readonly<Record<string, unknown>>): void => {
  if (native.trigger !== 'manual' && native.trigger !== 'auto') {
    nativeEventError('native trigger must equal manual or auto');
  }
};

const requirePermissionMode = (native: Readonly<Record<string, unknown>>): void => {
  requireNativeString(native, 'permission_mode');
  if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(String(native.permission_mode))) {
    nativeEventError('native permission_mode is invalid');
  }
};

const isCursorPromptAttachment = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const attachment = value as Readonly<Record<string, unknown>>;
  return (
    (attachment.type === 'file' || attachment.type === 'rule')
    && typeof attachment.file_path === 'string'
    && attachment.file_path.trim() !== ''
  );
};

/**
 * Validates the host envelope shared by generated event wrappers and semantic
 * lifecycle replay. The process-edge stdin byte limit remains wrapper-owned.
 */
export const validateNativeEventEnvelope = (
  input: unknown,
  validation: NativeEventEnvelopeValidation,
): Readonly<Record<string, unknown>> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return nativeEventError('stdin JSON value must be an object');
  }
  const native = input as Readonly<Record<string, unknown>>;
  const { canonicalEvent, nativeEvent, target } = validation;
  if (native.hook_event_name !== nativeEvent) {
    return nativeEventError(`native hook_event_name must equal ${nativeEvent}`);
  }
  if (target === 'cursor') {
    if (canonicalEvent === 'workspace/open') {
      if (
        !Array.isArray(native.workspace_roots)
        || native.workspace_roots.length === 0
        || !native.workspace_roots.every((root) => typeof root === 'string' && root.trim() !== '')
      ) {
        return nativeEventError('native workspace_roots must be a nonempty array of nonempty strings');
      }
      requireNativeString(native, 'cursor_version');
      // Cursor also sends the signed-in user's email on this envelope. The
      // framework does not read, validate, or surface operator identity; the
      // field passes through untouched inside the native payload.
      return native;
    }
    if (typeof native.session_id !== 'string' && typeof native.conversation_id !== 'string') {
      return nativeEventError('native session_id or conversation_id must be a string');
    }
    if (canonicalEvent === 'session/end') {
      if (!['completed', 'aborted', 'error', 'window_close', 'user_close'].includes(String(native.reason))) {
        return nativeEventError('native reason is invalid');
      }
      if (typeof native.duration_ms !== 'number') {
        return nativeEventError('native duration_ms must be a number');
      }
      if (typeof native.is_background_agent !== 'boolean') {
        return nativeEventError('native is_background_agent must be a boolean');
      }
      requireNativeString(native, 'final_status');
      if (Object.hasOwn(native, 'error_message') && typeof native.error_message !== 'string') {
        return nativeEventError('native error_message must be a string');
      }
      return native;
    }
    if (canonicalEvent === 'prompt/submit') {
      requireNativeStringValue(native, 'prompt');
      if (
        !Array.isArray(native.attachments)
        || !native.attachments.every(isCursorPromptAttachment)
      ) {
        return nativeEventError('native attachments must be an array of file/rule objects with nonempty file_path');
      }
      return native;
    }
    if (canonicalEvent === 'tool/failure') {
      requireNativeString(native, 'tool_name');
      if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
        return nativeEventError('native tool_input must be an object');
      }
      requireNativeString(native, 'tool_use_id');
      requireNativeString(native, 'cwd');
      requireNativeStringValue(native, 'error_message');
      if (!['timeout', 'error', 'permission_denied'].includes(String(native.failure_type))) {
        return nativeEventError('native failure_type is invalid');
      }
      requireNativeNumber(native, 'duration');
      requireNativeBoolean(native, 'is_interrupt');
      return native;
    }
    if (canonicalEvent === 'compact/before') {
      requireCompactTrigger(native);
      for (const field of [
        'context_usage_percent',
        'context_tokens',
        'context_window_size',
        'message_count',
        'messages_to_compact',
      ]) {
        requireNativeNumber(native, field);
      }
      requireNativeBoolean(native, 'is_first_compaction');
      return native;
    }
    if (canonicalEvent === 'tool/before' || canonicalEvent === 'tool/after') {
      requireNativeString(native, 'tool_name');
      if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
        return nativeEventError('native tool_input must be an object');
      }
      requireNativeString(native, 'tool_use_id');
      if (canonicalEvent === 'tool/after') requireNativeString(native, 'tool_output');
    }
    if (canonicalEvent === 'stop' && typeof native.loop_count !== 'number') {
      return nativeEventError('native loop_count must be a number');
    }
    if (canonicalEvent === 'agent/start') {
      // https://cursor.com/docs/hooks#subagentstart (retrieved 2026-09-02).
      // Only git_branch is documented "(optional)"; every other field is required.
      requireNativeString(native, 'subagent_id');
      requireNativeString(native, 'subagent_type');
      requireNativeStringValue(native, 'task');
      requireNativeString(native, 'parent_conversation_id');
      requireNativeString(native, 'tool_call_id');
      requireNativeStringValue(native, 'subagent_model');
      requireNativeBoolean(native, 'is_parallel_worker');
      if (Object.hasOwn(native, 'git_branch')) requireNativeStringValue(native, 'git_branch');
    }
    if (canonicalEvent === 'agent/stop') {
      // https://cursor.com/docs/hooks#subagentstop (retrieved 2026-09-02).
      requireNativeString(native, 'subagent_type');
      if (!['completed', 'error', 'aborted'].includes(String(native.status))) {
        return nativeEventError('native status is invalid');
      }
      // The documented subagentStop input marks no field optional;
      // agent_transcript_path is `string | null`.
      for (const field of ['task', 'description', 'summary']) {
        requireNativeStringValue(native, field);
      }
      for (const field of ['duration_ms', 'message_count', 'tool_call_count']) {
        requireNativeNumber(native, field);
      }
      requireNativeNumber(native, 'loop_count');
      if (!Array.isArray(native.modified_files) || !native.modified_files.every((file) => typeof file === 'string')) {
        return nativeEventError('native modified_files must be an array of strings');
      }
      if (
        !Object.hasOwn(native, 'agent_transcript_path')
        || (native.agent_transcript_path !== null && typeof native.agent_transcript_path !== 'string')
      ) {
        return nativeEventError('native agent_transcript_path must be a string or null');
      }
    }
    return native;
  }
  requireNativeString(native, 'session_id');
  if (target === 'codex') {
    if (native.transcript_path !== null && typeof native.transcript_path !== 'string') {
      return nativeEventError('native transcript_path must be a string or null');
    }
  } else {
    requireNativeString(native, 'transcript_path');
  }
  requireNativeString(native, 'cwd');
  if (canonicalEvent === 'session/end') {
    if (target === 'codex') {
      if (native.reason !== 'other') return nativeEventError('native reason must equal other');
    } else if (!['clear', 'resume', 'logout', 'prompt_input_exit', 'other'].includes(String(native.reason))) {
      return nativeEventError('native reason is invalid');
    }
  }
  if (canonicalEvent === 'prompt/submit') {
    requireNativeStringValue(native, 'prompt');
    requirePermissionMode(native);
    if (target === 'codex') {
      requireNativeString(native, 'turn_id');
      requireNativeString(native, 'model');
    }
  }
  if (canonicalEvent === 'tool/failure') {
    requireNativeString(native, 'tool_name');
    if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
      return nativeEventError('native tool_input must be an object');
    }
    requireNativeString(native, 'tool_use_id');
    requireNativeStringValue(native, 'error');
    if (Object.hasOwn(native, 'is_interrupt')) requireNativeBoolean(native, 'is_interrupt');
    if (Object.hasOwn(native, 'duration_ms')) requireNativeNumber(native, 'duration_ms');
  }
  if (canonicalEvent === 'permission/request') {
    requireNativeString(native, 'tool_name');
    if (target === 'codex') {
      // Only the pinned Codex permission-request input schema declares
      // `"tool_input": true` (any JSON value): presence is required but the
      // shape is tool-defined. Claude's PermissionRequest envelope stays
      // object-shaped like its other tool events.
      if (!Object.hasOwn(native, 'tool_input') || native.tool_input === undefined) {
        return nativeEventError('native tool_input is required');
      }
      requirePermissionMode(native);
      requireNativeString(native, 'turn_id');
      requireNativeString(native, 'model');
    } else {
      if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
        return nativeEventError('native tool_input must be an object');
      }
      requirePermissionMode(native);
    }
  }
  if (canonicalEvent === 'permission/denied') {
    requireNativeString(native, 'tool_name');
    if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
      return nativeEventError('native tool_input must be an object');
    }
    if (Object.hasOwn(native, 'permission_decision')) requireNativeString(native, 'permission_decision');
    if (Object.hasOwn(native, 'permission_decision_reason')) {
      requireNativeStringValue(native, 'permission_decision_reason');
    }
  }
  if (canonicalEvent === 'stop/failure') {
    requireNativeStringValue(native, 'error');
    if (Object.hasOwn(native, 'stop_hook_active') && typeof native.stop_hook_active !== 'boolean') {
      return nativeEventError('native stop_hook_active must be a boolean');
    }
  }
  if (canonicalEvent === 'file/change') requireNativeString(native, 'file_path');
  if (canonicalEvent === 'config/change') {
    if (!['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'].includes(String(native.source))) {
      return nativeEventError('native source is invalid');
    }
    if (Object.hasOwn(native, 'file_path')) requireNativeString(native, 'file_path');
  }
  if (canonicalEvent === 'task/create' || canonicalEvent === 'task/complete') {
    requireNativeString(native, 'task_id');
    requireNativeString(native, 'task_subject');
    for (const field of ['task_description', 'teammate_name', 'team_name']) {
      if (Object.hasOwn(native, field)) requireNativeString(native, field);
    }
  }
  if (canonicalEvent === 'agent/idle') {
    requireNativeString(native, 'teammate_name');
    requireNativeString(native, 'team_name');
  }
  if (canonicalEvent === 'model-switch/before' || canonicalEvent === 'model-switch/after') {
    // hooks reference "PreModelSwitch input" / "PostModelSwitch input"
    // (uploaded 2026-09-03, v2.1.251+): PostModelSwitch adds the `auto` and
    // `resume` sources for switches Claude Code makes on its own.
    requireNativeString(native, 'from_model');
    requireNativeString(native, 'to_model');
    if (native.requested_model !== null && typeof native.requested_model !== 'string') {
      return nativeEventError('native requested_model must be a string or null');
    }
    const sources = canonicalEvent === 'model-switch/before'
      ? ['command', 'picker', 'sdk']
      : ['command', 'picker', 'sdk', 'auto', 'resume'];
    if (!sources.includes(String(native.source))) {
      return nativeEventError('native source is invalid');
    }
    // The five cost fields describe what re-sending the conversation costs;
    // the reference documents them on every switch, but no live envelope has
    // been captured yet, so they are type-checked when present.
    for (const field of ['context_tokens', 'estimated_cache_write_usd']) {
      if (Object.hasOwn(native, field)) requireNativeNumber(native, field);
    }
    if (Object.hasOwn(native, 'prompt_cache_warm')) requireNativeBoolean(native, 'prompt_cache_warm');
    if (Object.hasOwn(native, 'cache_ttl') && !['5m', '1h'].includes(String(native.cache_ttl))) {
      return nativeEventError('native cache_ttl is invalid');
    }
    if (Object.hasOwn(native, 'pricing') && !['configured', 'catalog', 'default'].includes(String(native.pricing))) {
      return nativeEventError('native pricing is invalid');
    }
  }
  if (canonicalEvent === 'compact/before' || canonicalEvent === 'compact/after') {
    requireCompactTrigger(native);
    if (target === 'codex') {
      requireNativeString(native, 'turn_id');
      requireNativeString(native, 'model');
    } else if (canonicalEvent === 'compact/before') {
      if (native.custom_instructions !== null && typeof native.custom_instructions !== 'string') {
        return nativeEventError('native custom_instructions must be a string or null');
      }
    } else {
      requireNativeStringValue(native, 'compact_summary');
    }
  }
  if (canonicalEvent === 'session/start') requireNativeString(native, 'source');
  if (canonicalEvent === 'tool/before' || canonicalEvent === 'tool/after') {
    requireNativeString(native, 'tool_name');
    // The pinned rust-v0.147.0 pre-tool-use/post-tool-use input schemas declare
    // `"tool_input": true` and `"tool_response": true` (any JSON value), so Codex
    // only guarantees presence; Claude documents both as objects.
    if (target === 'codex') {
      if (!Object.hasOwn(native, 'tool_input') || native.tool_input === undefined) {
        return nativeEventError('native tool_input is required');
      }
    } else if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
      return nativeEventError('native tool_input must be an object');
    }
    requireNativeString(native, 'tool_use_id');
    if (canonicalEvent === 'tool/after') {
      // Codex pins tool_response as any JSON value. Claude documents an object
      // for built-in tools but delivers the tool's text as a plain string for
      // MCP tools (observed on Claude Code 2.1.257,
      // docs/audits/2026-09-03-host-lineage-matrix.md §3), so presence is the
      // only host-independent guarantee.
      if (!Object.hasOwn(native, 'tool_response') || native.tool_response === undefined) {
        return nativeEventError('native tool_response is required');
      }
    }
  }
  if (canonicalEvent === 'agent/start' || canonicalEvent === 'agent/stop') {
    requireNativeString(native, 'agent_id');
    requireNativeString(native, 'agent_type');
    if (target === 'codex') {
      requireNativeString(native, 'turn_id');
      requireNativeString(native, 'model');
      requirePermissionMode(native);
    }
    if (canonicalEvent === 'agent/stop') {
      if (typeof native.stop_hook_active !== 'boolean') {
        return nativeEventError('native stop_hook_active must be a boolean');
      }
      if (native.agent_transcript_path !== null && typeof native.agent_transcript_path !== 'string') {
        return nativeEventError('native agent_transcript_path must be a string or null');
      }
      if (native.last_assistant_message !== null && typeof native.last_assistant_message !== 'string') {
        return nativeEventError('native last_assistant_message must be a string or null');
      }
    }
  }
  if (canonicalEvent === 'stop') {
    if (typeof native.stop_hook_active !== 'boolean') {
      return nativeEventError('native stop_hook_active must be a boolean');
    }
    // The pinned rust-v0.147.0 stop.command.input schema types
    // last_assistant_message as string | null; Claude documents a string.
    if (target === 'codex') {
      if (native.last_assistant_message !== null && typeof native.last_assistant_message !== 'string') {
        return nativeEventError('native last_assistant_message must be a string or null');
      }
    } else {
      requireNativeString(native, 'last_assistant_message');
    }
  }
  return native;
};

export const createCanonicalEventProps = (
  event: CanonicalAgentEvent,
  nativeInput: Readonly<Record<string, unknown>>,
  target: string,
  nativeEvent: string,
  hostContractRevision: string,
  signal: AbortSignal,
): AgentEventRouteProps => {
  const native = snapshotNative(nativeInput);
  const canonical: AgentEventCanonicalIdentity = Object.freeze({
    event,
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify({ event, native, target }), 'utf8')
      .digest('hex'),
    observedAt: new Date().toISOString(),
    provenance: Object.freeze({
      host: target,
      hostContractRevision,
      nativeEvent,
      source: 'native',
    }),
    sequence: ++eventSequence,
  });
  return Object.freeze({ canonical, native, signal });
};

const appendContext = (node: AgentDocumentNode, contexts: string[]): void => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) appendContext(child, contexts);
      break;
    case 'context':
      contexts.push(node.text);
      break;
    case 'audio':
    case 'error':
    case 'image':
    case 'json':
    case 'markdown':
    case 'progress':
    case 'resource':
    case 'text':
      break;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

/**
 * Projects a rendered event document to the host's native output. Pass the
 * validated native envelope when the host's output contract depends on input
 * state (Cursor consumes `subagentStop.followup_message` only for a completed
 * subagent); the production callers always do.
 */
export const projectEventDocument = (
  document: AgentDocument,
  event: CanonicalAgentEvent,
  target: string,
  nativeEvent: string,
  nativeInput?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined => {
  if (target === 'plugin') {
    throw new TypeError('Composite plugin event projection must resolve the invoking host before projecting output.');
  }
  const contexts: string[] = [];
  appendContext(document.root, contexts);
  const additionalContext = contexts.length === 0 ? undefined : contexts.join('');
  const parsedValue = document.value === undefined ? undefined : resultValueSchema.parse(document.value);
  if (
    (parsedValue?.outcome === 'allow' && event !== 'tool/before' && event !== 'permission/request' && event !== 'model-switch/before')
    || (parsedValue?.outcome === 'ask' && event !== 'tool/before' && event !== 'model-switch/before')
  ) {
    throw new TypeError(
      `${event} does not accept outcome "${parsedValue.outcome}": allow is a tool/before, model-switch/before, or permission/request decision and ask is a tool/before or model-switch/before decision; continue leaves the host's own flow untouched.`,
    );
  }
  const requireDenyReason = (): string => {
    if (parsedValue?.outcome !== 'deny') {
      throw new TypeError(`${event} did not request a blocking outcome.`);
    }
    if (parsedValue.reason === undefined) {
      throw new TypeError(`${event} requires a nonempty reason when outcome is deny.`);
    }
    return parsedValue.reason;
  };

  if (event === 'stop') {
    if (parsedValue?.outcome !== 'deny') return undefined;
    return target === 'cursor'
      ? Object.freeze({ followup_message: requireDenyReason() })
      : Object.freeze({ decision: 'block', reason: requireDenyReason() });
  }
  if (event === 'agent/start') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/start cannot replace native input.');
    }
    if (target === 'cursor') {
      // https://cursor.com/docs/hooks#subagentstart (retrieved 2026-09-02):
      // output is { permission: allow | deny, user_message? }; there is no
      // additional-context channel, and `ask` is treated as deny.
      if (additionalContext !== undefined) {
        throw new TypeError('Cursor subagentStart has no additional-context channel.');
      }
      if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
        throw new TypeError('agent/start reason is only valid when outcome is deny.');
      }
      return parsedValue?.outcome === 'deny'
        ? Object.freeze({ permission: 'deny', user_message: requireDenyReason() })
        : undefined;
    }
    if (parsedValue?.outcome === 'deny') {
      throw new TypeError('agent/start cannot block subagent creation on Claude Code or Codex.');
    }
    if (additionalContext === undefined) return undefined;
    return deepFreeze({
      hookSpecificOutput: {
        additionalContext,
        hookEventName: nativeEvent,
      },
    });
  }
  if (event === 'agent/stop') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/stop cannot replace native input.');
    }
    if (target === 'cursor') {
      // https://cursor.com/docs/hooks#subagentstop (retrieved 2026-09-02):
      // output is { followup_message? }, consumed only when status is
      // completed and capped by loop_limit; there is no context channel.
      if (additionalContext !== undefined) {
        throw new TypeError('Cursor subagentStop has no additional-context channel; only followup_message is documented.');
      }
      if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
        throw new TypeError('agent/stop reason is only valid when outcome is deny.');
      }
      if (parsedValue?.outcome !== 'deny') return undefined;
      if (nativeInput !== undefined && nativeInput.status !== 'completed') {
        throw new TypeError(
          `Cursor subagentStop consumes followup_message only when status is "completed"; this subagent reported ${JSON.stringify(nativeInput.status)}, so the continuation would be ignored.`,
        );
      }
      return Object.freeze({ followup_message: requireDenyReason() });
    }
    if (parsedValue?.outcome === 'deny') {
      return Object.freeze({ decision: 'block', reason: requireDenyReason() });
    }
    if (additionalContext === undefined) return undefined;
    if (target === 'codex') {
      throw new TypeError('agent/stop additional context is not supported by the Codex SubagentStop output schema.');
    }
    return deepFreeze({
      hookSpecificOutput: {
        additionalContext,
        hookEventName: nativeEvent,
      },
    });
  }
  if (event === 'session/end') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('session/end is observation-only on every supported host and cannot deny or replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('session/end is observation-only on every supported host and has no context/output channel.');
    }
    return undefined;
  }
  if (event === 'prompt/submit') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('prompt/submit cannot replace native input on any supported host.');
    }
    if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
      throw new TypeError('prompt/submit reason is only valid when outcome is deny.');
    }
    if (target === 'cursor' && additionalContext !== undefined) {
      throw new TypeError('Cursor beforeSubmitPrompt has no additional-context channel.');
    }
    if (target === 'cursor') {
      return parsedValue?.outcome === 'deny'
        ? Object.freeze({ continue: false, user_message: requireDenyReason() })
        : undefined;
    }
    const reason = parsedValue?.outcome === 'deny' ? requireDenyReason() : undefined;
    if (reason === undefined && additionalContext === undefined) return undefined;
    return deepFreeze({
      ...(reason === undefined ? {} : { decision: 'block', reason }),
      ...(additionalContext === undefined
        ? {}
        : {
            hookSpecificOutput: {
              additionalContext,
              hookEventName: nativeEvent,
            },
          }),
    });
  }
  if (event === 'tool/failure') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('tool/failure cannot deny or replace native input; the tool has already failed.');
    }
    if (target !== 'claude' && additionalContext !== undefined) {
      throw new TypeError(
        target === 'cursor'
          ? 'Cursor postToolUseFailure has no context/output channel.'
          : 'tool/failure additional context is supported only by Claude PostToolUseFailure.',
      );
    }
    if (additionalContext === undefined) return undefined;
    return deepFreeze({
      hookSpecificOutput: {
        additionalContext,
        hookEventName: nativeEvent,
      },
    });
  }
  if (event === 'compact/before') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('compact/before cannot replace native input on any supported host.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError(
        target === 'cursor'
          ? 'Cursor preCompact user_message is user-facing and cannot be represented by Agent.Context.'
          : `${target === 'codex' ? 'Codex PreCompact' : 'Claude PreCompact'} has no additional-context channel.`,
      );
    }
    if (target === 'claude') {
      if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
        throw new TypeError('compact/before reason is only valid when outcome is deny on Claude.');
      }
      return parsedValue?.outcome === 'deny'
        ? Object.freeze({ decision: 'block', reason: requireDenyReason() })
        : undefined;
    }
    if (parsedValue?.outcome === 'deny' || parsedValue?.reason !== undefined) {
      throw new TypeError(
        target === 'cursor'
          ? 'Cursor preCompact is observational and cannot block compaction.'
          : 'Codex PreCompact common-control runtime semantics are unproven and are not projected.',
      );
    }
    return undefined;
  }
  if (event === 'compact/after') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('compact/after is observation-only on every supported host and cannot deny or replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('compact/after is observation-only on every supported host and has no context/output channel.');
    }
    return undefined;
  }
  if (event === 'permission/request') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('permission/request input rewrite is reserved upstream and fails closed on both supported hosts; it is not projected.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('permission/request has no additional-context channel in the PermissionRequest output contract.');
    }
    if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
      throw new TypeError('permission/request reason is only valid when outcome is deny.');
    }
    // https://code.claude.com/docs/en/hooks#permissionrequest-decision-control:
    // a hook that returns no decision leaves the prompt to the user, so
    // `continue` (and an empty result) project nothing. Only an explicit
    // `allow` answers on the user's behalf (#461).
    if (parsedValue?.outcome === undefined || parsedValue.outcome === 'continue') return undefined;
    return deepFreeze({
      hookSpecificOutput: {
        decision: {
          behavior: parsedValue.outcome === 'deny' ? 'deny' : 'allow',
          ...(parsedValue.outcome === 'deny' ? { message: requireDenyReason() } : {}),
        },
        hookEventName: nativeEvent,
      },
    });
  }
  if (event === 'permission/denied') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('permission/denied observes an already-denied call and cannot deny or replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('permission/denied retry signalling has no canonical vocabulary yet; no context/output channel is projected.');
    }
    return undefined;
  }
  if (event === 'stop/failure') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('stop/failure observes an API-error turn end and cannot deny or replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('stop/failure has no documented context/output channel.');
    }
    return undefined;
  }
  if (event === 'model-switch/before') {
    // https://code.claude.com/docs/en/hooks#premodelswitch-decision-control
    // (uploaded 2026-09-03): permissionDecision allow | deny | ask with
    // permissionDecisionReason (shown for deny and ask, ignored for allow);
    // no defer, updatedInput, or additionalContext. Precedence across hooks
    // is deny > ask > allow, and `ask` is a refusal outside interactive /model.
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('model-switch/before cannot replace native input; PreModelSwitch accepts no updatedInput.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('model-switch/before has no additional-context channel; PreModelSwitch accepts no additionalContext.');
    }
    if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny' && parsedValue.outcome !== 'ask') {
      throw new TypeError('model-switch/before reason is only valid when outcome is deny or ask.');
    }
    if (parsedValue?.outcome === undefined || parsedValue.outcome === 'continue') return undefined;
    return deepFreeze({
      hookSpecificOutput: {
        hookEventName: nativeEvent,
        permissionDecision: parsedValue.outcome,
        ...(parsedValue.outcome === 'deny'
          ? { permissionDecisionReason: requireDenyReason() }
          : parsedValue.outcome === 'ask' && parsedValue.reason !== undefined
            ? { permissionDecisionReason: parsedValue.reason }
            : {}),
      },
    });
  }
  if (event === 'model-switch/after') {
    // https://code.claude.com/docs/en/hooks#postmodelswitch-decision-control:
    // the model has already changed; only additionalContext reaches Claude,
    // with the next request after the switch.
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('model-switch/after observes a completed model switch and cannot deny or replace native input.');
    }
    if (additionalContext === undefined) return undefined;
    return deepFreeze({
      hookSpecificOutput: {
        additionalContext,
        hookEventName: nativeEvent,
      },
    });
  }
  if (event === 'file/change') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('file/change has no decision control on Claude FileChanged; it is side-effect-only.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('file/change has no documented context/output channel.');
    }
    return undefined;
  }
  if (event === 'config/change' || event === 'task/create') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError(`${event} cannot replace native input.`);
    }
    if (additionalContext !== undefined) {
      throw new TypeError(`${event} has no documented additional-context channel.`);
    }
    if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
      throw new TypeError(`${event} reason is only valid when outcome is deny.`);
    }
    return parsedValue?.outcome === 'deny'
      ? Object.freeze({ decision: 'block', reason: requireDenyReason() })
      : undefined;
  }
  if (event === 'task/complete') {
    if (
      parsedValue?.outcome === 'deny'
      || parsedValue?.reason !== undefined
      || parsedValue?.updatedInput !== undefined
    ) {
      throw new TypeError('task/complete blocking is exit-code-only on Claude TaskCompleted (JSON continue:false redirects to teammate stop and is ignored for TaskUpdate); it is not projected.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('task/complete has no documented context/output channel.');
    }
    return undefined;
  }
  if (event === 'agent/idle') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/idle cannot replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError('agent/idle has no documented additional-context channel.');
    }
    if (parsedValue?.reason !== undefined && parsedValue.outcome !== 'deny') {
      throw new TypeError('agent/idle reason is only valid when outcome is deny.');
    }
    return parsedValue?.outcome === 'deny'
      ? Object.freeze({ continue: false, stopReason: requireDenyReason() })
      : undefined;
  }
  if (event === 'tool/before') {
    // A pass-through result (`continue` or no value) carries no decision: the
    // host keeps its own permission flow, and a rewrite is evaluated by that
    // flow against the rewritten input. Only an explicit allow/ask/deny is
    // projected as one (#461). `reason` has no channel without a decision.
    const decision = parsedValue?.outcome === undefined || parsedValue.outcome === 'continue'
      ? undefined
      : parsedValue.outcome;
    if (parsedValue?.reason !== undefined && decision === undefined) {
      throw new TypeError('tool/before reason is only valid when outcome is allow, ask, or deny.');
    }
    if (target === 'cursor') {
      // https://cursor.com/docs/hooks#pretooluse (retrieved 2026-09-03):
      // output is { permission: allow | deny, user_message?, agent_message?,
      // updated_input? }; "ask" is accepted by the schema but not enforced,
      // and the messages are shown only when denied.
      if (decision === 'ask') {
        throw new TypeError('Cursor preToolUse accepts permission "ask" in its schema but does not enforce it; ask is not projected on Cursor.');
      }
      if (decision === 'deny') {
        return Object.freeze({
          agent_message: parsedValue?.reason,
          permission: 'deny',
          user_message: parsedValue?.reason,
        });
      }
      // Cursor documents updated_input only alongside a permission, so a
      // rewrite without an explicit decision is delivered as allow here; on
      // Claude and Codex the same rewrite carries no decision.
      if (decision === undefined && parsedValue?.updatedInput === undefined) return undefined;
      return Object.freeze({
        permission: 'allow',
        ...(parsedValue?.updatedInput === undefined ? {} : { updated_input: parsedValue.updatedInput }),
      });
    }
    const output = {
      ...(additionalContext === undefined ? {} : { additionalContext }),
      hookEventName: nativeEvent,
      ...(decision === undefined ? {} : { permissionDecision: decision }),
      ...(parsedValue?.reason === undefined ? {} : { permissionDecisionReason: parsedValue.reason }),
      ...(parsedValue?.updatedInput === undefined ? {} : { updatedInput: parsedValue.updatedInput }),
    };
    return Object.keys(output).length === 1 ? undefined : deepFreeze({ hookSpecificOutput: output });
  }
  if (event === 'session/start' || event === 'tool/after') {
    if (additionalContext === undefined) return undefined;
    return target === 'cursor'
      ? Object.freeze({ additional_context: additionalContext })
      : deepFreeze({
          hookSpecificOutput: {
            additionalContext,
            hookEventName: nativeEvent,
          },
        });
  }
  if (event === 'workspace/open') {
    if (parsedValue?.outcome === 'deny' || parsedValue?.updatedInput !== undefined) {
      throw new TypeError('workspace/open is observation-only on every supported host and cannot deny or replace native input.');
    }
    if (additionalContext !== undefined) {
      throw new TypeError(
        'Cursor\'s workspaceOpen has no context/output channel; the native pluginPaths return channel is deliberately not modeled.',
      );
    }
    return undefined;
  }
  return undefined;
};
