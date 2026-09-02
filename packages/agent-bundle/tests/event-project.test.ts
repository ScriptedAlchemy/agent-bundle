import { Agent } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { createElement } from 'react';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  createCanonicalEventProps,
  projectEventDocument,
  renderStandaloneEventRoute,
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

it('resolves nested Server Components in explicit standalone event routes', async () => {
  const NestedContext = async () => createElement(Agent.Context, null, 'standalone');
  const Route = async () => createElement(
    Agent.Result,
    null,
    createElement(NestedContext),
  );
  const controller = new AbortController();
  const props = createCanonicalEventProps(
    'tool/after',
    { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    'claude',
    'PostToolUse',
    '2.1.250',
    controller.signal,
  );

  const document = await renderStandaloneEventRoute(Route, props);
  expect(projectEventDocument(document, 'tool/after', 'claude', 'PostToolUse')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'standalone',
      hookEventName: 'PostToolUse',
    },
  });
});

it('projects subagent-start context without fabricating a blocking effect', async () => {
  const document = await renderStandaloneEventRoute(
    async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Review the repository test conventions first.'),
    ),
    createCanonicalEventProps(
      'agent/start',
      { agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: 'SubagentStart', session_id: 'parent-1' },
      'codex',
      'SubagentStart',
      '0.147.0',
      new AbortController().signal,
    ),
  );

  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(document, 'agent/start', target, 'SubagentStart')).toEqual({
      hookSpecificOutput: {
        additionalContext: 'Review the repository test conventions first.',
        hookEventName: 'SubagentStart',
      },
    });
  }

  const blocked = await renderStandaloneEventRoute(
    async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Do not start.' } }),
    createCanonicalEventProps(
      'agent/start',
      { agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: 'SubagentStart', session_id: 'parent-1' },
      'codex',
      'SubagentStart',
      '0.147.0',
      new AbortController().signal,
    ),
  );
  expect(() => projectEventDocument(blocked, 'agent/start', 'codex', 'SubagentStart'))
    .toThrow(/agent\/start cannot block subagent creation/u);
});

it('projects subagent-stop continuation only through supported host contracts', async () => {
  const blocked = await renderStandaloneEventRoute(
    async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Run one more focused pass.' } }),
    createCanonicalEventProps(
      'agent/stop',
      {
        agent_id: 'agent-1',
        agent_transcript_path: '/workspace/subagents/agent-1.jsonl',
        agent_type: 'Explore',
        hook_event_name: 'SubagentStop',
        last_assistant_message: 'Done.',
        session_id: 'parent-1',
        stop_hook_active: false,
      },
      'codex',
      'SubagentStop',
      '0.147.0',
      new AbortController().signal,
    ),
  );

  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(blocked, 'agent/stop', target, 'SubagentStop')).toEqual({
      decision: 'block',
      reason: 'Run one more focused pass.',
    });
  }

  const feedback = await renderStandaloneEventRoute(
    async () => createElement(Agent.Result, null, createElement(Agent.Context, null, 'Check the final result.')),
    createCanonicalEventProps(
      'agent/stop',
      { agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: 'SubagentStop', session_id: 'session-1' },
      'claude',
      'SubagentStop',
      '2.1.250',
      new AbortController().signal,
    ),
  );
  expect(projectEventDocument(feedback, 'agent/stop', 'claude', 'SubagentStop')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'Check the final result.',
      hookEventName: 'SubagentStop',
    },
  });
  expect(() => projectEventDocument(feedback, 'agent/stop', 'codex', 'SubagentStop'))
    .toThrow(/not supported by the Codex SubagentStop output schema/u);
  expect(() => projectEventDocument(feedback, 'agent/stop', 'plugin', 'SubagentStop'))
    .toThrow(/must resolve the invoking host/u);
});
