import { resolve } from 'node:path';

import type { CanonicalPostToolUse } from '../runtime/contracts.js';

type NativeHookInput = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const readString = (input: NativeHookInput, key: string): string | undefined =>
  typeof input[key] === 'string' ? input[key] : undefined;

const readRequiredString = (input: NativeHookInput, key: string): string => {
  const value = readString(input, key);
  if (value === undefined || value.trim() === '') {
    throw new Error(`Native hook input requires ${key}`);
  }

  return value;
};

const readIdempotencyKey = (host: CanonicalPostToolUse['host'], input: NativeHookInput): string => {
  const toolUseId = readString(input, 'tool_use_id')?.trim();
  if (toolUseId !== undefined && toolUseId !== '') {
    return `${host}:tool:${toolUseId}`;
  }

  const eventId = readString(input, 'event_id')?.trim();
  if (eventId !== undefined && eventId !== '') {
    return `${host}:event:${eventId}`;
  }

  throw new Error('Mutating native hook input requires a nonempty tool_use_id or event_id');
};

const readBaseEvent = (host: CanonicalPostToolUse['host'], input: NativeHookInput) => {
  if (readRequiredString(input, 'hook_event_name') !== 'PostToolUse') {
    throw new Error('Only PostToolUse events are supported');
  }

  return {
    cwd: readRequiredString(input, 'cwd'),
    host,
    idempotencyKey: readIdempotencyKey(host, input),
    sessionId: readRequiredString(input, 'session_id'),
    toolName: readRequiredString(input, 'tool_name'),
  };
};

const resolveNativePath = (cwd: string, path: string): string => {
  if (path.trim() === '') {
    throw new Error('Native hook input requires a file path');
  }

  return resolve(cwd, path);
};

/**
 * The edited file a tool call names. This is the one genuinely host-specific
 * reading left in the hook: Claude's `Write`/`Edit` carry `file_path`, while
 * Codex's `apply_patch` names the file inside its patch header. The tool name
 * and input themselves arrive host-independently on `canonical.payload`.
 */
export const editedPath = (
  host: CanonicalPostToolUse['host'],
  cwd: string,
  toolName: string,
  rawToolInput: unknown,
): string => {
  if (host === 'claude' && toolName !== 'Write' && toolName !== 'Edit') {
    throw new Error('Claude hook supports only Write and Edit');
  }
  if (host === 'codex' && toolName !== 'apply_patch') {
    throw new Error('Codex hook supports only apply_patch');
  }
  const toolInput = asRecord(rawToolInput);
  if (toolInput === undefined) {
    throw new Error('Native hook input requires tool_input');
  }
  if (host === 'claude') {
    return resolveNativePath(cwd, readRequiredString(toolInput, 'file_path'));
  }
  const command = readRequiredString(toolInput, 'command');
  const path = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/m.exec(command)?.[1];
  if (path === undefined) {
    throw new Error('Codex apply_patch command requires a file header');
  }
  return resolveNativePath(cwd, path);
};

export const normalizeClaudeHook = (input: NativeHookInput): CanonicalPostToolUse => {
  const event = readBaseEvent('claude', input);
  return { ...event, path: editedPath('claude', event.cwd, event.toolName, input.tool_input) };
};

export const normalizeCodexHook = (input: NativeHookInput): CanonicalPostToolUse => {
  const event = readBaseEvent('codex', input);
  return { ...event, path: editedPath('codex', event.cwd, event.toolName, input.tool_input) };
};
