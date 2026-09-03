import { createHash } from 'node:crypto';

import type { AgentDocument, AgentDocumentNode } from '@agent-bundle/runtime';
import { z } from 'zod';

import { deepFreeze } from '../core/freeze.ts';
import type {
  AgentEventCanonicalIdentity,
  AgentEventRouteProps,
  CanonicalAgentEvent,
} from '../routes/public.ts';

const resultValueSchema = z.object({
  outcome: z.enum(['continue', 'deny']).optional(),
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
      if (
        Object.hasOwn(native, 'user_email')
        && native.user_email !== null
        && typeof native.user_email !== 'string'
      ) {
        return nativeEventError('native user_email must be a string or null');
      }
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
    // The pinned permission-request input schema declares `"tool_input": true`
    // (any JSON value), so presence is required but shape is tool-defined.
    if (!Object.hasOwn(native, 'tool_input') || native.tool_input === undefined) {
      return nativeEventError('native tool_input is required');
    }
    requirePermissionMode(native);
    if (target === 'codex') {
      requireNativeString(native, 'turn_id');
      requireNativeString(native, 'model');
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
    if (typeof native.tool_input !== 'object' || native.tool_input === null || Array.isArray(native.tool_input)) {
      return nativeEventError('native tool_input must be an object');
    }
    requireNativeString(native, 'tool_use_id');
    if (
      canonicalEvent === 'tool/after'
      && (typeof native.tool_response !== 'object' || native.tool_response === null || Array.isArray(native.tool_response))
    ) {
      return nativeEventError('native tool_response must be an object');
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

export const projectEventDocument = (
  document: AgentDocument,
  event: CanonicalAgentEvent,
  target: string,
  nativeEvent: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (target === 'plugin') {
    throw new TypeError('Composite plugin event projection must resolve the invoking host before projecting output.');
  }
  const contexts: string[] = [];
  appendContext(document.root, contexts);
  const additionalContext = contexts.length === 0 ? undefined : contexts.join('');
  const parsedValue = document.value === undefined ? undefined : resultValueSchema.parse(document.value);
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
    if (parsedValue?.outcome === 'deny') {
      throw new TypeError('agent/start cannot block subagent creation on any supported host.');
    }
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/start cannot replace native input.');
    }
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
  if (event === 'agent/stop') {
    if (parsedValue?.updatedInput !== undefined) {
      throw new TypeError('agent/stop cannot replace native input.');
    }
    if (parsedValue?.outcome === 'deny') {
      if (target === 'cursor') {
        throw new TypeError('agent/stop cannot block subagent completion on cursor.');
      }
      return Object.freeze({ decision: 'block', reason: requireDenyReason() });
    }
    if (additionalContext === undefined) return undefined;
    if (target === 'codex') {
      throw new TypeError('agent/stop additional context is not supported by the Codex SubagentStop output schema.');
    }
    return target === 'cursor'
      ? Object.freeze({ additional_context: additionalContext })
      : deepFreeze({
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
    if (parsedValue?.outcome === undefined) return undefined;
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
    if (target === 'cursor') {
      if (parsedValue?.outcome === 'deny') {
        return Object.freeze({
          agent_message: parsedValue.reason,
          permission: 'deny',
          user_message: parsedValue.reason,
        });
      }
      return parsedValue?.updatedInput === undefined
        ? undefined
        : Object.freeze({ permission: 'allow', updated_input: parsedValue.updatedInput });
    }
    const output = {
      ...(additionalContext === undefined ? {} : { additionalContext }),
      hookEventName: nativeEvent,
      permissionDecision: parsedValue?.outcome === 'deny' ? 'deny' : 'allow',
      ...(parsedValue?.reason === undefined ? {} : { permissionDecisionReason: parsedValue.reason }),
      ...(parsedValue?.updatedInput === undefined ? {} : { updatedInput: parsedValue.updatedInput }),
    };
    return deepFreeze({ hookSpecificOutput: output });
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
