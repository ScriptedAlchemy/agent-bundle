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
      requireNativeString(native, 'permission_mode');
      if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(String(native.permission_mode))) {
        return nativeEventError('native permission_mode is invalid');
      }
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
    requireNativeString(native, 'last_assistant_message');
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
