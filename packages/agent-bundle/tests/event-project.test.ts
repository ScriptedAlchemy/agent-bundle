import { Agent } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  createCanonicalEventProps,
  projectEventDocument,
  renderStandaloneEventRoute,
} from '../src/events/project.ts';

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
});
