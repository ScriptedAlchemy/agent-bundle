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
