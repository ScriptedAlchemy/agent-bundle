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
    .toThrow('Agent Bundle event route error: native tool_response must be an object');
  expect(() => validateNativeEventEnvelope({ ...valid, hook_event_name: 'BeforeToolUse' }, options))
    .toThrow('Agent Bundle event route error: native hook_event_name must equal PostToolUse');
  expect(() => validateNativeEventEnvelope([], options))
    .toThrow('Agent Bundle event route error: stdin JSON value must be an object');
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
