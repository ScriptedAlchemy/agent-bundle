import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  validateNativeEventEnvelope,
} from '../src/events/project.ts';
import { canonicalAgentEvents } from '../src/routes/public.ts';

it('validates every adapter-advertised native event starter', () => {
  const registry = createDefaultRegistry();
  for (const target of ['claude', 'codex', 'cursor']) {
    const contract = registry.hookContract(target);
    expect(contract).toBeDefined();
    for (const canonicalEvent of canonicalAgentEvents) {
      const nativeEvent = contract?.eventRouteNames?.[canonicalEvent];
      if (nativeEvent === undefined) continue;
      const starter = contract?.nativeEventStarter?.(canonicalEvent);
      expect(starter, `${target}:${canonicalEvent}`).toBeDefined();
      expect(validateNativeEventEnvelope(starter, { canonicalEvent, nativeEvent, target })).toBe(starter);
    }
  }
});

it('validates native event envelopes with the generated wrapper error contract', () => {
  const options = {
    canonicalEvent: 'tool/after' as const,
    nativeEvent: 'PostToolUse',
    target: 'claude',
  };
  const valid = {
    cwd: '/tmp/lifecycle-replay',
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_input: {},
    tool_name: 'Write',
    tool_response: {},
    tool_use_id: 'tool-1',
    transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
  };

  expect(validateNativeEventEnvelope(valid, options)).toBe(valid);
  expect(() => validateNativeEventEnvelope({ ...valid, tool_response: 'not-an-object' }, options))
    .toThrow('Agent Bundle event route error: native tool_response must be an object or an array');
  // Claude Code 2.1.257 delivers MCP tool results as a content-block array (2026-09-03 capture).
  expect(validateNativeEventEnvelope({ ...valid, tool_response: [{ text: 'ok', type: 'text' }] }, options))
    .toMatchObject({ tool_response: [{ text: 'ok', type: 'text' }] });
  expect(() => validateNativeEventEnvelope({ ...valid, hook_event_name: 'BeforeToolUse' }, options))
    .toThrow('Agent Bundle event route error: native hook_event_name must equal PostToolUse');
  expect(() => validateNativeEventEnvelope([], options))
    .toThrow('Agent Bundle event route error: stdin JSON value must be an object');
});

it('accepts any JSON tool_input/tool_response for Codex tool events per the pinned generated schemas', () => {
  const options = { canonicalEvent: 'tool/after' as const, nativeEvent: 'PostToolUse', target: 'codex' };
  const base = {
    cwd: '/tmp/lifecycle-replay',
    hook_event_name: 'PostToolUse',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    session_id: 'session-1',
    tool_name: 'Write',
    tool_use_id: 'tool-1',
    transcript_path: null,
    turn_id: 'turn-1',
  };

  for (const value of ['text', 7, true, null, [1, 2], { ok: true }]) {
    const native = { ...base, tool_input: value, tool_response: value };
    expect(validateNativeEventEnvelope(native, options)).toBe(native);
  }
  expect(() => validateNativeEventEnvelope({ ...base, tool_input: {} }, options))
    .toThrow('Agent Bundle event route error: native tool_response is required');
  expect(() => validateNativeEventEnvelope({ ...base, tool_response: {} }, options))
    .toThrow('Agent Bundle event route error: native tool_input is required');
  expect(() => validateNativeEventEnvelope(
    { ...base, hook_event_name: 'PreToolUse', tool_input: 'text' },
    { canonicalEvent: 'tool/before', nativeEvent: 'PreToolUse', target: 'codex' },
  )).not.toThrow();
});

it('validates Cursor workspaceOpen without inventing an agent session', () => {
  const options = {
    canonicalEvent: 'workspace/open' as const,
    nativeEvent: 'workspaceOpen',
    target: 'cursor',
  };
  const documented = {
    cursor_version: '1.7.2',
    hook_event_name: 'workspaceOpen',
    user_email: null,
    workspace_roots: ['/abs/path'],
  };

  expect(validateNativeEventEnvelope(documented, options)).toBe(documented);
  for (const workspaceRoots of [undefined, [], [''], ['/abs/path', 7]]) {
    expect(() => validateNativeEventEnvelope({
      ...documented,
      workspace_roots: workspaceRoots,
    }, options)).toThrow(/native workspace_roots must be a nonempty array of nonempty strings/u);
  }
  expect(() => validateNativeEventEnvelope({ ...documented, cursor_version: '' }, options))
    .toThrow(/native cursor_version must be a nonempty string/u);
  expect(() => validateNativeEventEnvelope({ ...documented, user_email: 7 }, options))
    .toThrow(/native user_email must be a string or null/u);

  expect(() => validateNativeEventEnvelope({
    ...documented,
    hook_event_name: 'sessionStart',
  }, {
    canonicalEvent: 'session/start',
    nativeEvent: 'sessionStart',
    target: 'cursor',
  })).toThrow(/native session_id or conversation_id must be a string/u);
});

it('validates the documented Cursor subagentStart and subagentStop envelopes fail closed', () => {
  // https://cursor.com/docs/hooks#subagentstart / #subagentstop (retrieved 2026-09-02).
  const start = {
    conversation_id: 'conv-456',
    git_branch: 'feature/auth',
    hook_event_name: 'subagentStart',
    is_parallel_worker: false,
    parent_conversation_id: 'conv-456',
    subagent_id: 'abc-123',
    subagent_model: 'claude-sonnet-4-20250514',
    subagent_type: 'generalPurpose',
    task: 'Explore the authentication flow',
    tool_call_id: 'tc-789',
  };
  const startOptions = { canonicalEvent: 'agent/start' as const, nativeEvent: 'subagentStart', target: 'cursor' };
  expect(validateNativeEventEnvelope(start, startOptions)).toBe(start);
  expect(() => validateNativeEventEnvelope({ ...start, subagent_type: '' }, startOptions))
    .toThrow(/native subagent_type must be a nonempty string/u);
  expect(() => validateNativeEventEnvelope({ ...start, subagent_id: undefined }, startOptions))
    .toThrow(/native subagent_id must be a nonempty string/u);
  expect(() => validateNativeEventEnvelope({ ...start, is_parallel_worker: 'no' }, startOptions))
    .toThrow(/native is_parallel_worker must be a boolean/u);
  // Only git_branch is documented "(optional)"; every other field must be present.
  const { git_branch: _gitBranch, ...withoutGitBranch } = start;
  expect(validateNativeEventEnvelope(withoutGitBranch, startOptions)).toBe(withoutGitBranch);
  for (const [field, message] of [
    ['parent_conversation_id', 'native parent_conversation_id must be a nonempty string'],
    ['tool_call_id', 'native tool_call_id must be a nonempty string'],
    ['subagent_model', 'native subagent_model must be a string'],
    ['is_parallel_worker', 'native is_parallel_worker must be a boolean'],
    ['task', 'native task must be a string'],
  ] as const) {
    const { [field]: _omitted, ...missing } = start;
    expect(() => validateNativeEventEnvelope(missing, startOptions)).toThrow(message);
  }
  // Claude's agent_id/agent_type spelling is not the Cursor envelope.
  expect(() => validateNativeEventEnvelope({
    agent_id: 'abc-123',
    agent_type: 'generalPurpose',
    conversation_id: 'conv-456',
    hook_event_name: 'subagentStart',
  }, startOptions)).toThrow(/native subagent_id must be a nonempty string/u);

  const stop = {
    agent_transcript_path: '/path/to/subagent/transcript.txt',
    conversation_id: 'conv-456',
    description: 'Exploring auth flow',
    duration_ms: 45_000,
    hook_event_name: 'subagentStop',
    loop_count: 0,
    message_count: 12,
    modified_files: ['src/auth.ts'],
    status: 'completed',
    subagent_type: 'generalPurpose',
    summary: 'Found the login handler.',
    task: 'Explore the authentication flow',
    tool_call_count: 8,
  };
  const stopOptions = { canonicalEvent: 'agent/stop' as const, nativeEvent: 'subagentStop', target: 'cursor' };
  expect(validateNativeEventEnvelope(stop, stopOptions)).toBe(stop);
  expect(validateNativeEventEnvelope({ ...stop, agent_transcript_path: null }, stopOptions)).toBeDefined();
  expect(() => validateNativeEventEnvelope({ ...stop, status: 'cancelled' }, stopOptions))
    .toThrow(/native status is invalid/u);
  expect(() => validateNativeEventEnvelope({ ...stop, loop_count: '0' }, stopOptions))
    .toThrow(/native loop_count must be a number/u);
  expect(() => validateNativeEventEnvelope({ ...stop, modified_files: 'src/auth.ts' }, stopOptions))
    .toThrow(/native modified_files must be an array of strings/u);
  expect(() => validateNativeEventEnvelope({ ...stop, agent_transcript_path: 7 }, stopOptions))
    .toThrow(/native agent_transcript_path must be a string or null/u);
  // The documented subagentStop input marks no field optional.
  for (const [field, message] of [
    ['task', 'native task must be a string'],
    ['description', 'native description must be a string'],
    ['summary', 'native summary must be a string'],
    ['duration_ms', 'native duration_ms must be a number'],
    ['message_count', 'native message_count must be a number'],
    ['tool_call_count', 'native tool_call_count must be a number'],
    ['modified_files', 'native modified_files must be an array of strings'],
    ['agent_transcript_path', 'native agent_transcript_path must be a string or null'],
  ] as const) {
    const { [field]: _omitted, ...missing } = stop;
    expect(() => validateNativeEventEnvelope(missing, stopOptions)).toThrow(message);
  }
});

it('validates prompt/submit and session/end host envelopes fail closed', () => {
  const promptEnvelopes = [
    {
      native: {
        cwd: '/workspace',
        hook_event_name: 'UserPromptSubmit',
        permission_mode: 'default',
        prompt: 'Review this change.',
        session_id: 'session-1',
        transcript_path: '/workspace/transcript.jsonl',
      },
      target: 'claude',
    },
    {
      native: {
        cwd: '/workspace',
        hook_event_name: 'UserPromptSubmit',
        model: 'gpt-5.6-sol',
        permission_mode: 'default',
        prompt: 'Review this change.',
        session_id: 'session-1',
        transcript_path: null,
        turn_id: 'turn-1',
      },
      target: 'codex',
    },
    {
      native: {
        attachments: [],
        conversation_id: 'session-1',
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Review this change.',
      },
      target: 'cursor',
    },
  ] as const;
  for (const { native, target } of promptEnvelopes) {
    expect(validateNativeEventEnvelope(native, {
      canonicalEvent: 'prompt/submit',
      nativeEvent: target === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit',
      target,
    })).toBe(native);
  }
  expect(() => validateNativeEventEnvelope({
    ...promptEnvelopes[1].native,
    permission_mode: 'invalid',
  }, {
    canonicalEvent: 'prompt/submit',
    nativeEvent: 'UserPromptSubmit',
    target: 'codex',
  })).toThrow(/native permission_mode is invalid/u);
  expect(() => validateNativeEventEnvelope({
    ...promptEnvelopes[2].native,
    attachments: [{ file_path: '', type: 'file' }],
  }, {
    canonicalEvent: 'prompt/submit',
    nativeEvent: 'beforeSubmitPrompt',
    target: 'cursor',
  })).toThrow(/native attachments.*file_path/u);

  const sessionEnd = {
    cwd: '/workspace',
    hook_event_name: 'SessionEnd',
    reason: 'other',
    session_id: 'session-1',
    transcript_path: null,
  };
  expect(validateNativeEventEnvelope(sessionEnd, {
    canonicalEvent: 'session/end',
    nativeEvent: 'SessionEnd',
    target: 'codex',
  })).toBe(sessionEnd);
  expect(() => validateNativeEventEnvelope({ ...sessionEnd, reason: 'clear' }, {
    canonicalEvent: 'session/end',
    nativeEvent: 'SessionEnd',
    target: 'codex',
  })).toThrow(/native reason must equal other/u);
});

it('validates failure and compaction envelopes without flattening host differences', () => {
  const claudeFailure = {
    cwd: '/workspace',
    duration_ms: 134,
    error: 'Exit code 9\nfailure',
    hook_event_name: 'PostToolUseFailure',
    is_interrupt: false,
    session_id: 'session-1',
    tool_input: { command: 'exit 9' },
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    transcript_path: '/workspace/transcript.jsonl',
  };
  expect(validateNativeEventEnvelope(claudeFailure, {
    canonicalEvent: 'tool/failure',
    nativeEvent: 'PostToolUseFailure',
    target: 'claude',
  })).toBe(claudeFailure);

  const cursorFailure = {
    conversation_id: 'session-1',
    cwd: '/workspace',
    duration: 5,
    error_message: 'Denied by policy.',
    failure_type: 'permission_denied',
    hook_event_name: 'postToolUseFailure',
    is_interrupt: false,
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Shell',
    tool_use_id: 'tool-1',
  };
  expect(validateNativeEventEnvelope(cursorFailure, {
    canonicalEvent: 'tool/failure',
    nativeEvent: 'postToolUseFailure',
    target: 'cursor',
  })).toBe(cursorFailure);
  expect(() => validateNativeEventEnvelope({ ...cursorFailure, failure_type: 'denied' }, {
    canonicalEvent: 'tool/failure',
    nativeEvent: 'postToolUseFailure',
    target: 'cursor',
  })).toThrow(/native failure_type is invalid/u);

  const claudeBefore = {
    custom_instructions: null,
    cwd: '/workspace',
    hook_event_name: 'PreCompact',
    session_id: 'session-1',
    transcript_path: '/workspace/transcript.jsonl',
    trigger: 'manual',
  };
  expect(validateNativeEventEnvelope(claudeBefore, {
    canonicalEvent: 'compact/before',
    nativeEvent: 'PreCompact',
    target: 'claude',
  })).toBe(claudeBefore);

  const codexAfter = {
    cwd: '/workspace',
    hook_event_name: 'PostCompact',
    model: 'gpt-5.6-sol',
    session_id: 'session-1',
    transcript_path: null,
    trigger: 'auto',
    turn_id: 'turn-1',
  };
  expect(validateNativeEventEnvelope(codexAfter, {
    canonicalEvent: 'compact/after',
    nativeEvent: 'PostCompact',
    target: 'codex',
  })).toBe(codexAfter);

  const cursorBefore = {
    context_tokens: 120_000,
    context_usage_percent: 85,
    context_window_size: 128_000,
    conversation_id: 'session-1',
    hook_event_name: 'preCompact',
    is_first_compaction: true,
    message_count: 45,
    messages_to_compact: 30,
    trigger: 'auto',
  };
  expect(validateNativeEventEnvelope(cursorBefore, {
    canonicalEvent: 'compact/before',
    nativeEvent: 'preCompact',
    target: 'cursor',
  })).toBe(cursorBefore);
  expect(() => validateNativeEventEnvelope({ ...cursorBefore, context_tokens: '120000' }, {
    canonicalEvent: 'compact/before',
    nativeEvent: 'preCompact',
    target: 'cursor',
  })).toThrow(/native context_tokens must be a number/u);

  expect(() => validateNativeEventEnvelope({
    cwd: '/workspace',
    hook_event_name: 'PostCompact',
    session_id: 'session-1',
    transcript_path: '/workspace/transcript.jsonl',
    trigger: 'manual',
  }, {
    canonicalEvent: 'compact/after',
    nativeEvent: 'PostCompact',
    target: 'claude',
  })).toThrow(/native compact_summary must be a string/u);
});

it('validates permission and stop-failure envelopes against the pinned host contracts', () => {
  const claudeRequest = {
    cwd: '/workspace',
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    session_id: 'session-1',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Bash',
    transcript_path: '/workspace/transcript.jsonl',
  };
  expect(validateNativeEventEnvelope(claudeRequest, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'claude',
  })).toBe(claudeRequest);
  expect(() => validateNativeEventEnvelope({ ...claudeRequest, permission_mode: 'sometimes' }, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'claude',
  })).toThrow(/permission_mode/u);

  const codexRequest = {
    cwd: '/workspace',
    hook_event_name: 'PermissionRequest',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    session_id: 'session-1',
    tool_input: { command: 'apply_patch' },
    tool_name: 'apply_patch',
    transcript_path: null,
    turn_id: 'turn-1',
  };
  expect(validateNativeEventEnvelope(codexRequest, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'codex',
  })).toBe(codexRequest);
  expect(() => validateNativeEventEnvelope({ ...codexRequest, turn_id: undefined }, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'codex',
  })).toThrow(/turn_id/u);

  // Only the pinned Codex input schema declares `tool_input: true`: Codex
  // admits every JSON shape while Claude's envelope stays object-shaped
  // (#364 review).
  for (const toolInput of [null, [], 'apply_patch', 7, false]) {
    const shaped = { ...codexRequest, tool_input: toolInput };
    expect(validateNativeEventEnvelope(shaped, {
      canonicalEvent: 'permission/request',
      nativeEvent: 'PermissionRequest',
      target: 'codex',
    })).toBe(shaped);
    expect(() => validateNativeEventEnvelope({ ...claudeRequest, tool_input: toolInput }, {
      canonicalEvent: 'permission/request',
      nativeEvent: 'PermissionRequest',
      target: 'claude',
    })).toThrow(/native tool_input must be an object/u);
  }
  expect(() => validateNativeEventEnvelope({ ...codexRequest, tool_input: undefined }, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'codex',
  })).toThrow(/native tool_input is required/u);
  expect(() => validateNativeEventEnvelope({ ...claudeRequest, tool_input: undefined }, {
    canonicalEvent: 'permission/request',
    nativeEvent: 'PermissionRequest',
    target: 'claude',
  })).toThrow(/native tool_input must be an object/u);

  const claudeDenied = {
    cwd: '/workspace',
    hook_event_name: 'PermissionDenied',
    permission_decision: 'deny',
    permission_decision_reason: 'Auto mode denied the command.',
    session_id: 'session-1',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Bash',
    transcript_path: '/workspace/transcript.jsonl',
  };
  expect(validateNativeEventEnvelope(claudeDenied, {
    canonicalEvent: 'permission/denied',
    nativeEvent: 'PermissionDenied',
    target: 'claude',
  })).toBe(claudeDenied);

  const claudeStopFailure = {
    cwd: '/workspace',
    error: 'API Error: 529 overloaded',
    hook_event_name: 'StopFailure',
    session_id: 'session-1',
    stop_hook_active: false,
    transcript_path: '/workspace/transcript.jsonl',
  };
  expect(validateNativeEventEnvelope(claudeStopFailure, {
    canonicalEvent: 'stop/failure',
    nativeEvent: 'StopFailure',
    target: 'claude',
  })).toBe(claudeStopFailure);
  expect(() => validateNativeEventEnvelope({ ...claudeStopFailure, error: 42 }, {
    canonicalEvent: 'stop/failure',
    nativeEvent: 'StopFailure',
    target: 'claude',
  })).toThrow(/error/u);
});
