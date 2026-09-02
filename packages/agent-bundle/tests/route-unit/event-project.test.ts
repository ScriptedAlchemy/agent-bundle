import { Agent } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { createElement, Suspense } from 'react';

import {
  createCanonicalEventProps,
  projectEventDocument,
} from '../../src/events/project.ts';
import { renderRoute } from '../../src/test/render.ts';

it('renders standalone event projection fixtures through real Flight', async () => {
  const NestedContext = async () => createElement(Agent.Context, null, 'standalone');
  const Route = async () => createElement(
    Agent.Result,
    null,
    createElement(
      Suspense,
      { fallback: createElement(Agent.Context, null, 'loading') },
      createElement(NestedContext),
    ),
  );
  const props = createCanonicalEventProps(
    'tool/after',
    { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    'claude',
    'PostToolUse',
    '2.1.250',
    new AbortController().signal,
  );
  const rendered = await renderRoute({ default: Route }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:tool/after',
  });

  expect(projectEventDocument(rendered.document, 'tool/after', 'claude', 'PostToolUse')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'standalone',
      hookEventName: 'PostToolUse',
    },
  });
});

it('projects subagent-start context without fabricating a blocking effect', async () => {
  const props = createCanonicalEventProps(
    'agent/start',
    { agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: 'SubagentStart', session_id: 'parent-1' },
    'codex',
    'SubagentStart',
    '0.147.0',
    new AbortController().signal,
  );
  const rendered = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Review the repository test conventions first.'),
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:agent/start',
  });

  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(rendered.document, 'agent/start', target, 'SubagentStart')).toEqual({
      hookSpecificOutput: {
        additionalContext: 'Review the repository test conventions first.',
        hookEventName: 'SubagentStart',
      },
    });
  }

  const blocked = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Do not start.' } }),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:agent/start',
  });
  expect(() => projectEventDocument(blocked.document, 'agent/start', 'codex', 'SubagentStart'))
    .toThrow(/agent\/start cannot block subagent creation/u);
});

it('projects subagent-stop continuation only through supported host contracts', async () => {
  const props = createCanonicalEventProps(
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
  );
  const blocked = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Run one more focused pass.' } },
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:agent/stop',
  });

  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(blocked.document, 'agent/stop', target, 'SubagentStop')).toEqual({
      decision: 'block',
      reason: 'Run one more focused pass.',
    });
  }

  const feedbackProps = createCanonicalEventProps(
    'agent/stop',
    { agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: 'SubagentStop', session_id: 'session-1' },
    'claude',
    'SubagentStop',
    '2.1.250',
    new AbortController().signal,
  );
  const feedback = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Check the final result.'),
    ),
  }, {
    input: { canonical: feedbackProps.canonical, native: feedbackProps.native },
    kind: 'event-route',
    routeId: 'event:agent/stop',
  });
  expect(projectEventDocument(feedback.document, 'agent/stop', 'claude', 'SubagentStop')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'Check the final result.',
      hookEventName: 'SubagentStop',
    },
  });
  expect(() => projectEventDocument(feedback.document, 'agent/stop', 'codex', 'SubagentStop'))
    .toThrow(/not supported by the Codex SubagentStop output schema/u);
  expect(() => projectEventDocument(feedback.document, 'agent/stop', 'plugin', 'SubagentStop'))
    .toThrow(/must resolve the invoking host/u);
});

it('projects workspace/open as a fire-and-forget observation only', async () => {
  const props = createCanonicalEventProps(
    'workspace/open',
    {
      cursor_version: '1.7.2',
      hook_event_name: 'workspaceOpen',
      user_email: null,
      workspace_roots: ['/workspace'],
    },
    'cursor',
    'workspaceOpen',
    '2026-08-28',
    new AbortController().signal,
  );
  const routeInput = {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:workspace/open',
  } as const;
  const observation = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, routeInput);
  expect(projectEventDocument(observation.document, 'workspace/open', 'cursor', 'workspaceOpen')).toBeUndefined();

  for (const value of [
    { outcome: 'deny', reason: 'Do not open.' },
    { updatedInput: { workspace_roots: ['/replacement'] } },
  ]) {
    const rejected = await renderRoute({
      default: async () => createElement(Agent.Result, { value }),
    }, routeInput);
    expect(() => projectEventDocument(rejected.document, 'workspace/open', 'cursor', 'workspaceOpen'))
      .toThrow(/workspace\/open is observation-only on every supported host/u);
  }

  const context = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Inject this context.'),
    ),
  }, routeInput);
  expect(() => projectEventDocument(context.document, 'workspace/open', 'cursor', 'workspaceOpen'))
    .toThrow(/Cursor's workspaceOpen has no context\/output channel.*pluginPaths.*deliberately not modeled/u);
});
