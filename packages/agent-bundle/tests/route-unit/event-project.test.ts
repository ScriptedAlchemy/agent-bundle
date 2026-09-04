import { readFile } from 'node:fs/promises';

import { Agent, type JsonValue } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { createElement, Suspense } from 'react';

import {
  createCanonicalEventProps,
  projectEventDocument,
  validateNativeEventEnvelope,
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

it('projects the Cursor subagent lifecycle through its documented permission and followup_message channels only', async () => {
  // https://cursor.com/docs/hooks#subagentstart / #subagentstop (retrieved 2026-09-02).
  const startNative = {
    conversation_id: 'conv-456',
    cursor_version: '1.7.2',
    hook_event_name: 'subagentStart',
    is_parallel_worker: false,
    parent_conversation_id: 'conv-456',
    subagent_id: 'abc-123',
    subagent_model: 'claude-sonnet-4-20250514',
    subagent_type: 'explore',
    task: 'Explore the authentication flow',
    tool_call_id: 'tc-789',
    workspace_roots: ['/workspace'],
  };
  const startProps = createCanonicalEventProps('agent/start', startNative, 'cursor', 'subagentStart', '2026-08-28', new AbortController().signal);
  const startInput = {
    input: { canonical: startProps.canonical, native: startProps.native },
    kind: 'event-route',
    routeId: 'event:agent/start',
  } as const;

  const denied = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Explore subagents are disabled here.' } }),
  }, startInput);
  expect(projectEventDocument(denied.document, 'agent/start', 'cursor', 'subagentStart')).toEqual({
    permission: 'deny',
    user_message: 'Explore subagents are disabled here.',
  });
  const allowed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, startInput);
  expect(projectEventDocument(allowed.document, 'agent/start', 'cursor', 'subagentStart')).toBeUndefined();
  const startContext = await renderRoute({
    default: async () => createElement(Agent.Result, null, createElement(Agent.Context, null, 'Read the test conventions first.')),
  }, startInput);
  expect(() => projectEventDocument(startContext.document, 'agent/start', 'cursor', 'subagentStart'))
    .toThrow(/Cursor subagentStart has no additional-context channel/u);
  const startReplaced = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { updatedInput: { task: 'Different task' } } }),
  }, startInput);
  expect(() => projectEventDocument(startReplaced.document, 'agent/start', 'cursor', 'subagentStart'))
    .toThrow(/agent\/start cannot replace native input/u);

  const stopNative = {
    agent_transcript_path: '/workspace/subagents/abc-123.txt',
    conversation_id: 'conv-456',
    description: 'Exploring auth flow',
    duration_ms: 45_000,
    hook_event_name: 'subagentStop',
    loop_count: 0,
    message_count: 12,
    modified_files: ['src/auth.ts'],
    status: 'completed',
    subagent_type: 'explore',
    summary: 'Found the login handler.',
    task: 'Explore the authentication flow',
    tool_call_count: 8,
  };
  const stopProps = createCanonicalEventProps('agent/stop', stopNative, 'cursor', 'subagentStop', '2026-08-28', new AbortController().signal);
  const stopInput = {
    input: { canonical: stopProps.canonical, native: stopProps.native },
    kind: 'event-route',
    routeId: 'event:agent/stop',
  } as const;

  const continued = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Run one more focused pass.' } }),
  }, stopInput);
  expect(projectEventDocument(continued.document, 'agent/stop', 'cursor', 'subagentStop', stopNative)).toEqual({
    followup_message: 'Run one more focused pass.',
  });
  // Cursor consumes followup_message only when status is "completed"; a
  // continuation requested for an errored or aborted subagent fails closed
  // instead of emitting output Cursor would silently ignore.
  for (const status of ['error', 'aborted']) {
    expect(() => projectEventDocument(continued.document, 'agent/stop', 'cursor', 'subagentStop', { ...stopNative, status }))
      .toThrow(new RegExp(`consumes followup_message only when status is "completed"; this subagent reported "${status}"`, 'u'));
  }
  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, stopInput);
  expect(projectEventDocument(observed.document, 'agent/stop', 'cursor', 'subagentStop', stopNative)).toBeUndefined();
  expect(projectEventDocument(observed.document, 'agent/stop', 'cursor', 'subagentStop', { ...stopNative, status: 'error' })).toBeUndefined();
  // A reason without a deny outcome is invalid on both published Cursor
  // handler paths; the route path must not swallow it.
  const reasonWithoutDeny = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'continue', reason: 'Looks fine.' } }),
  }, stopInput);
  expect(() => projectEventDocument(reasonWithoutDeny.document, 'agent/stop', 'cursor', 'subagentStop', stopNative))
    .toThrow(/agent\/stop reason is only valid when outcome is deny/u);
  const stopContext = await renderRoute({
    default: async () => createElement(Agent.Result, null, createElement(Agent.Context, null, 'Check the final result.')),
  }, stopInput);
  expect(() => projectEventDocument(stopContext.document, 'agent/stop', 'cursor', 'subagentStop'))
    .toThrow(/Cursor subagentStop has no additional-context channel/u);
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

  const rejectedValues: readonly JsonValue[] = [
    { outcome: 'deny', reason: 'Do not open.' },
    { updatedInput: { workspace_roots: ['/replacement'] } },
  ];
  for (const value of rejectedValues) {
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

it('projects prompt/submit through only the native channels each host supports', async () => {
  const props = createCanonicalEventProps(
    'prompt/submit',
    {
      cwd: '/workspace',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Review this change.',
      session_id: 'session-1',
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'UserPromptSubmit',
    '2.1.250',
    new AbortController().signal,
  );
  const deniedWithContext = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Prompt rejected.' } },
      createElement(Agent.Context, null, 'Repository policy context.'),
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:prompt/submit',
  });

  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(deniedWithContext.document, 'prompt/submit', target, 'UserPromptSubmit')).toEqual({
      decision: 'block',
      hookSpecificOutput: {
        additionalContext: 'Repository policy context.',
        hookEventName: 'UserPromptSubmit',
      },
      reason: 'Prompt rejected.',
    });
  }
  expect(() => projectEventDocument(
    deniedWithContext.document,
    'prompt/submit',
    'cursor',
    'beforeSubmitPrompt',
  )).toThrow(/Cursor beforeSubmitPrompt has no additional-context channel/u);

  const denied = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Prompt rejected.' } },
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:prompt/submit',
  });
  expect(projectEventDocument(denied.document, 'prompt/submit', 'cursor', 'beforeSubmitPrompt')).toEqual({
    continue: false,
    user_message: 'Prompt rejected.',
  });

  const replaced = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { updatedInput: { prompt: 'Replacement prompt.' } } },
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:prompt/submit',
  });
  expect(() => projectEventDocument(replaced.document, 'prompt/submit', 'claude', 'UserPromptSubmit'))
    .toThrow(/prompt\/submit cannot replace native input/u);
});

it('projects session/end as observation-only on every host', async () => {
  const props = createCanonicalEventProps(
    'session/end',
    {
      cwd: '/workspace',
      hook_event_name: 'SessionEnd',
      reason: 'other',
      session_id: 'session-1',
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'SessionEnd',
    '2.1.250',
    new AbortController().signal,
  );
  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:session/end',
  });
  for (const target of ['claude', 'codex', 'cursor']) {
    expect(projectEventDocument(observed.document, 'session/end', target, target === 'cursor' ? 'sessionEnd' : 'SessionEnd'))
      .toBeUndefined();
  }

  const context = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Persist this context.'),
    ),
  }, {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:session/end',
  });
  expect(() => projectEventDocument(context.document, 'session/end', 'claude', 'SessionEnd'))
    .toThrow(/session\/end is observation-only.*no context\/output channel/u);
});

it('projects tool/failure context only through Claude PostToolUseFailure', async () => {
  const props = createCanonicalEventProps(
    'tool/failure',
    {
      cwd: '/workspace',
      error: 'Exit code 9\nfailure',
      hook_event_name: 'PostToolUseFailure',
      session_id: 'session-1',
      tool_input: { command: 'exit 9' },
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'PostToolUseFailure',
    '2.1.250',
    new AbortController().signal,
  );
  const routeInput = {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:tool/failure',
  } as const;
  const context = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Inspect the failed command output.'),
    ),
  }, routeInput);
  expect(projectEventDocument(context.document, 'tool/failure', 'claude', 'PostToolUseFailure')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'Inspect the failed command output.',
      hookEventName: 'PostToolUseFailure',
    },
  });
  expect(() => projectEventDocument(context.document, 'tool/failure', 'cursor', 'postToolUseFailure'))
    .toThrow(/Cursor postToolUseFailure has no context\/output channel/u);

  const denied = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Undo the failure.' } },
    ),
  }, routeInput);
  expect(() => projectEventDocument(denied.document, 'tool/failure', 'claude', 'PostToolUseFailure'))
    .toThrow(/tool\/failure cannot deny or replace native input/u);
});

it('projects compact/before only through Claude blocking control', async () => {
  const props = createCanonicalEventProps(
    'compact/before',
    {
      custom_instructions: null,
      cwd: '/workspace',
      hook_event_name: 'PreCompact',
      session_id: 'session-1',
      transcript_path: '/workspace/transcript.jsonl',
      trigger: 'manual',
    },
    'claude',
    'PreCompact',
    '2.1.250',
    new AbortController().signal,
  );
  const routeInput = {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:compact/before',
  } as const;
  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, routeInput);
  for (const target of ['claude', 'codex', 'cursor']) {
    expect(projectEventDocument(observed.document, 'compact/before', target, target === 'cursor' ? 'preCompact' : 'PreCompact'))
      .toBeUndefined();
  }

  const denied = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Preserve the current context.' } },
    ),
  }, routeInput);
  expect(projectEventDocument(denied.document, 'compact/before', 'claude', 'PreCompact')).toEqual({
    decision: 'block',
    reason: 'Preserve the current context.',
  });
  expect(() => projectEventDocument(denied.document, 'compact/before', 'codex', 'PreCompact'))
    .toThrow(/Codex PreCompact common-control runtime semantics are unproven/u);
  expect(() => projectEventDocument(denied.document, 'compact/before', 'cursor', 'preCompact'))
    .toThrow(/Cursor preCompact is observational/u);

  const context = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Compaction notice.'),
    ),
  }, routeInput);
  expect(() => projectEventDocument(context.document, 'compact/before', 'cursor', 'preCompact'))
    .toThrow(/user_message is user-facing.*cannot be represented by Agent.Context/u);
});

it('projects compact/after as observation-only on supported hosts', async () => {
  const props = createCanonicalEventProps(
    'compact/after',
    {
      compact_summary: 'Summary of the compacted conversation.',
      cwd: '/workspace',
      hook_event_name: 'PostCompact',
      session_id: 'session-1',
      transcript_path: '/workspace/transcript.jsonl',
      trigger: 'manual',
    },
    'claude',
    'PostCompact',
    '2.1.250',
    new AbortController().signal,
  );
  const routeInput = {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:compact/after',
  } as const;
  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, routeInput);
  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(observed.document, 'compact/after', target, 'PostCompact')).toBeUndefined();
  }

  const rejectedValues: readonly JsonValue[] = [
    { outcome: 'deny', reason: 'Restore the previous context.' },
    { updatedInput: { compact_summary: 'Replacement.' } },
  ];
  for (const value of rejectedValues) {
    const rejected = await renderRoute({
      default: async () => createElement(Agent.Result, { value }),
    }, routeInput);
    expect(() => projectEventDocument(rejected.document, 'compact/after', 'claude', 'PostCompact'))
      .toThrow(/compact\/after is observation-only/u);
  }
});

it('projects permission/request decisions through the pinned PermissionRequest output contract', async () => {
  const props = createCanonicalEventProps(
    'permission/request',
    {
      cwd: '/workspace',
      hook_event_name: 'PermissionRequest',
      permission_mode: 'default',
      session_id: 'session-1',
      tool_input: { command: 'rm -rf build' },
      tool_name: 'Bash',
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'PermissionRequest',
    '2.1.250',
    new AbortController().signal,
  );
  const routeInput = {
    input: { canonical: props.canonical, native: props.native },
    kind: 'event-route',
    routeId: 'event:permission/request',
  } as const;

  const denied = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: 'Destructive command requires review.' } },
    ),
  }, routeInput);
  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(denied.document, 'permission/request', target, 'PermissionRequest')).toEqual({
      hookSpecificOutput: {
        decision: {
          behavior: 'deny',
          message: 'Destructive command requires review.',
        },
        hookEventName: 'PermissionRequest',
      },
    });
  }

  // Only an explicit allow answers on the user's behalf; `continue` and an
  // empty result leave the prompt to the user (#461).
  const allowed = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'allow' } }),
  }, routeInput);
  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(allowed.document, 'permission/request', target, 'PermissionRequest')).toEqual({
      hookSpecificOutput: {
        decision: { behavior: 'allow' },
        hookEventName: 'PermissionRequest',
      },
    });
  }

  const continued = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'continue' } }),
  }, routeInput);
  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, routeInput);
  for (const target of ['claude', 'codex']) {
    expect(projectEventDocument(continued.document, 'permission/request', target, 'PermissionRequest')).toBeUndefined();
    expect(projectEventDocument(observed.document, 'permission/request', target, 'PermissionRequest')).toBeUndefined();
  }

  const asked = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'ask' } }),
  }, routeInput);
  expect(() => projectEventDocument(asked.document, 'permission/request', 'claude', 'PermissionRequest'))
    .toThrow(/permission\/request does not accept outcome "ask"/u);

  const rewritten = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { updatedInput: { command: 'rm -r build' } } }),
  }, routeInput);
  expect(() => projectEventDocument(rewritten.document, 'permission/request', 'claude', 'PermissionRequest'))
    .toThrow(/input rewrite is reserved upstream and fails closed/u);

  const contextual = await renderRoute({
    default: async () => createElement(
      Agent.Result,
      null,
      createElement(Agent.Context, null, 'Context is not part of this contract.'),
    ),
  }, routeInput);
  expect(() => projectEventDocument(contextual.document, 'permission/request', 'claude', 'PermissionRequest'))
    .toThrow(/no additional-context channel/u);
});

it('admits any-JSON permission/request tool_input only for Codex and keeps Claude object-shaped', async () => {
  const claudeEnvelope = {
    cwd: '/workspace',
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    session_id: 'session-1',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Bash',
    transcript_path: '/workspace/transcript.jsonl',
  };
  const codexEnvelope = {
    ...claudeEnvelope,
    model: 'gpt-5-codex',
    tool_input: 'apply_patch',
    tool_name: 'apply_patch',
    transcript_path: null,
    turn_id: 'turn-1',
  };
  const options = { canonicalEvent: 'permission/request', nativeEvent: 'PermissionRequest' } as const;

  // Codex's pinned input schema declares `tool_input: true`, so a scalar
  // envelope validates and renders through the same route as an object one.
  const codexNative = validateNativeEventEnvelope(codexEnvelope, { ...options, target: 'codex' });
  const codexProps = createCanonicalEventProps(
    'permission/request', codexNative, 'codex', 'PermissionRequest', '0.147.0', new AbortController().signal,
  );
  const denied = await renderRoute({
    default: async ({ native }: { readonly native: Readonly<Record<string, JsonValue>> }) => createElement(
      Agent.Result,
      { value: { outcome: 'deny', reason: `Denied ${String(native.tool_input)}.` } },
    ),
  }, {
    input: { canonical: codexProps.canonical, native: codexProps.native },
    kind: 'event-route',
    routeId: 'event:permission/request',
  });
  expect(projectEventDocument(denied.document, 'permission/request', 'codex', 'PermissionRequest')).toEqual({
    hookSpecificOutput: {
      decision: { behavior: 'deny', message: 'Denied apply_patch.' },
      hookEventName: 'PermissionRequest',
    },
  });

  // Claude's envelope keeps the object-shaped contract of its other tool events.
  for (const toolInput of [null, [], 'rm -rf build', 7]) {
    expect(() => validateNativeEventEnvelope({ ...claudeEnvelope, tool_input: toolInput }, { ...options, target: 'claude' }))
      .toThrow(/native tool_input must be an object/u);
  }
  expect(validateNativeEventEnvelope(claudeEnvelope, { ...options, target: 'claude' })).toBe(claudeEnvelope);
});

it('projects permission/denied and stop/failure as observation-only Claude families', async () => {
  const deniedProps = createCanonicalEventProps(
    'permission/denied',
    {
      cwd: '/workspace',
      hook_event_name: 'PermissionDenied',
      permission_decision: 'deny',
      permission_decision_reason: 'Auto mode denied the command.',
      session_id: 'session-1',
      tool_input: { command: 'rm -rf build' },
      tool_name: 'Bash',
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'PermissionDenied',
    '2.1.250',
    new AbortController().signal,
  );
  const deniedInput = {
    input: { canonical: deniedProps.canonical, native: deniedProps.native },
    kind: 'event-route',
    routeId: 'event:permission/denied',
  } as const;
  const deniedObserved = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, deniedInput);
  expect(projectEventDocument(deniedObserved.document, 'permission/denied', 'claude', 'PermissionDenied')).toBeUndefined();
  const deniedRejected = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Again.' } }),
  }, deniedInput);
  expect(() => projectEventDocument(deniedRejected.document, 'permission/denied', 'claude', 'PermissionDenied'))
    .toThrow(/observes an already-denied call/u);
  const deniedContextual = await renderRoute({
    default: async () => createElement(Agent.Result, null, createElement(Agent.Context, null, 'Retry hint.')),
  }, deniedInput);
  expect(() => projectEventDocument(deniedContextual.document, 'permission/denied', 'claude', 'PermissionDenied'))
    .toThrow(/retry signalling has no canonical vocabulary yet/u);

  const failureProps = createCanonicalEventProps(
    'stop/failure',
    {
      cwd: '/workspace',
      error: 'API Error: 529 overloaded',
      hook_event_name: 'StopFailure',
      session_id: 'session-1',
      stop_hook_active: false,
      transcript_path: '/workspace/transcript.jsonl',
    },
    'claude',
    'StopFailure',
    '2.1.250',
    new AbortController().signal,
  );
  const failureInput = {
    input: { canonical: failureProps.canonical, native: failureProps.native },
    kind: 'event-route',
    routeId: 'event:stop/failure',
  } as const;
  const failureObserved = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, failureInput);
  expect(projectEventDocument(failureObserved.document, 'stop/failure', 'claude', 'StopFailure')).toBeUndefined();
  const failureRejected = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'deny', reason: 'Do not end.' } }),
  }, failureInput);
  expect(() => projectEventDocument(failureRejected.document, 'stop/failure', 'claude', 'StopFailure'))
    .toThrow(/observes an API-error turn end/u);
});

it('projects the stage-4 Claude-only families with their documented decision channels', async () => {
  const render = async (event: string, native: Record<string, unknown>, nativeEvent: string, value?: JsonValue, context?: string) => {
    const props = createCanonicalEventProps(
      event as never,
      native,
      'claude',
      nativeEvent,
      '2.1.250',
      new AbortController().signal,
    );
    return renderRoute({
      default: async () => createElement(
        Agent.Result,
        value === undefined ? null : { value },
        context === undefined ? undefined : createElement(Agent.Context, null, context),
      ),
    }, {
      input: { canonical: props.canonical, native: props.native },
      kind: 'event-route',
      routeId: `event:${event}`,
    });
  };
  const base = {
    cwd: '/workspace',
    session_id: 'session-1',
    transcript_path: '/workspace/transcript.jsonl',
  };

  // file/change: side-effect only.
  const fileNative = { ...base, file_path: '/workspace/.env', hook_event_name: 'FileChanged' };
  const fileObserved = await render('file/change', fileNative, 'FileChanged');
  expect(projectEventDocument(fileObserved.document, 'file/change', 'claude', 'FileChanged')).toBeUndefined();
  const fileDenied = await render('file/change', fileNative, 'FileChanged', { outcome: 'deny', reason: 'No.' });
  expect(() => projectEventDocument(fileDenied.document, 'file/change', 'claude', 'FileChanged'))
    .toThrow(/no decision control on Claude FileChanged/u);

  // config/change: top-level decision block.
  const configNative = { ...base, hook_event_name: 'ConfigChange', source: 'project_settings' };
  const configDenied = await render('config/change', configNative, 'ConfigChange', { outcome: 'deny', reason: 'Config changes are frozen during release.' });
  expect(projectEventDocument(configDenied.document, 'config/change', 'claude', 'ConfigChange')).toEqual({
    decision: 'block',
    reason: 'Config changes are frozen during release.',
  });

  // task/create: decision block cancels the task.
  const taskNative = { ...base, hook_event_name: 'TaskCreated', task_id: 'task-001', task_subject: 'Subject' };
  const taskDenied = await render('task/create', taskNative, 'TaskCreated', { outcome: 'deny', reason: 'Tasks are frozen.' });
  expect(projectEventDocument(taskDenied.document, 'task/create', 'claude', 'TaskCreated')).toEqual({
    decision: 'block',
    reason: 'Tasks are frozen.',
  });

  // task/complete: exit-code-only blocking is not projected.
  const completeNative = { ...base, hook_event_name: 'TaskCompleted', permission_mode: 'default', task_id: 'task-001', task_subject: 'Subject' };
  const completeObserved = await render('task/complete', completeNative, 'TaskCompleted');
  expect(projectEventDocument(completeObserved.document, 'task/complete', 'claude', 'TaskCompleted')).toBeUndefined();
  const completeDenied = await render('task/complete', completeNative, 'TaskCompleted', { outcome: 'deny', reason: 'Not done.' });
  expect(() => projectEventDocument(completeDenied.document, 'task/complete', 'claude', 'TaskCompleted'))
    .toThrow(/exit-code-only on Claude TaskCompleted/u);

  // agent/idle: continue:false keeps the teammate working.
  const idleNative = { ...base, hook_event_name: 'TeammateIdle', permission_mode: 'default', team_name: 'team', teammate_name: 'researcher' };
  const idleDenied = await render('agent/idle', idleNative, 'TeammateIdle', { outcome: 'deny', reason: 'Backlog remains.' });
  expect(projectEventDocument(idleDenied.document, 'agent/idle', 'claude', 'TeammateIdle')).toEqual({
    continue: false,
    stopReason: 'Backlog remains.',
  });
  const idleObserved = await render('agent/idle', idleNative, 'TeammateIdle');
  expect(projectEventDocument(idleObserved.document, 'agent/idle', 'claude', 'TeammateIdle')).toBeUndefined();
  const idleContextual = await render('agent/idle', idleNative, 'TeammateIdle', undefined, 'Context.');
  expect(() => projectEventDocument(idleContextual.document, 'agent/idle', 'claude', 'TeammateIdle'))
    .toThrow(/no documented additional-context channel/u);
});

it('projects the model-switch families to the PreModelSwitch decision and PostModelSwitch context channels (2.1.260 re-pin)', async () => {
  const render = async (event: string, native: Record<string, unknown>, nativeEvent: string, value?: JsonValue, context?: string) => {
    const props = createCanonicalEventProps(
      event as never,
      native,
      'claude',
      nativeEvent,
      '2.1.260',
      new AbortController().signal,
    );
    return renderRoute({
      default: async () => createElement(
        Agent.Result,
        value === undefined ? null : { value },
        context === undefined ? undefined : createElement(Agent.Context, null, context),
      ),
    }, {
      input: { canonical: props.canonical, native: props.native },
      kind: 'event-route',
      routeId: `event:${event}`,
    });
  };
  // hooks reference "PreModelSwitch input": the documented `/model opus` example.
  const before = JSON.parse(await readFile(new URL('../fixtures/events/claude-pre-model-switch.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const after = JSON.parse(await readFile(new URL('../fixtures/events/claude-post-model-switch.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  // model-switch/before: pass-through projects nothing; allow / ask / deny are the documented permissionDecision values.
  const observed = await render('model-switch/before', before, 'PreModelSwitch');
  expect(projectEventDocument(observed.document, 'model-switch/before', 'claude', 'PreModelSwitch')).toBeUndefined();
  const passThrough = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'continue' });
  expect(projectEventDocument(passThrough.document, 'model-switch/before', 'claude', 'PreModelSwitch')).toBeUndefined();
  const allowed = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'allow' });
  expect(projectEventDocument(allowed.document, 'model-switch/before', 'claude', 'PreModelSwitch')).toEqual({
    hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' },
  });
  const asked = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'ask', reason: 'Switching re-sends about 180k tokens. Continue?' });
  expect(projectEventDocument(asked.document, 'model-switch/before', 'claude', 'PreModelSwitch')).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreModelSwitch',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Switching re-sends about 180k tokens. Continue?',
    },
  });
  const denied = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'deny', reason: 'Opus is not approved for this repository.' });
  expect(projectEventDocument(denied.document, 'model-switch/before', 'claude', 'PreModelSwitch')).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreModelSwitch',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Opus is not approved for this repository.',
    },
  });
  const deniedWithoutReason = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'deny' });
  expect(() => projectEventDocument(deniedWithoutReason.document, 'model-switch/before', 'claude', 'PreModelSwitch'))
    .toThrow(/requires a nonempty reason/u);
  const allowedWithReason = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'allow', reason: 'Fine.' });
  expect(() => projectEventDocument(allowedWithReason.document, 'model-switch/before', 'claude', 'PreModelSwitch'))
    .toThrow(/reason is only valid when outcome is deny or ask/u);
  const rewritten = await render('model-switch/before', before, 'PreModelSwitch', { outcome: 'allow', updatedInput: { to_model: 'claude-sonnet-5' } });
  expect(() => projectEventDocument(rewritten.document, 'model-switch/before', 'claude', 'PreModelSwitch'))
    .toThrow(/accepts no updatedInput/u);
  const contextual = await render('model-switch/before', before, 'PreModelSwitch', undefined, 'Context.');
  expect(() => projectEventDocument(contextual.document, 'model-switch/before', 'claude', 'PreModelSwitch'))
    .toThrow(/accepts no additionalContext/u);

  // model-switch/after: observation plus additionalContext; the switch already happened.
  const afterObserved = await render('model-switch/after', after, 'PostModelSwitch');
  expect(projectEventDocument(afterObserved.document, 'model-switch/after', 'claude', 'PostModelSwitch')).toBeUndefined();
  const afterContext = await render('model-switch/after', after, 'PostModelSwitch', undefined, 'On Opus, delegate implementation to subagents.');
  expect(projectEventDocument(afterContext.document, 'model-switch/after', 'claude', 'PostModelSwitch')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'On Opus, delegate implementation to subagents.',
      hookEventName: 'PostModelSwitch',
    },
  });
  const afterDenied = await render('model-switch/after', after, 'PostModelSwitch', { outcome: 'deny', reason: 'No.' });
  expect(() => projectEventDocument(afterDenied.document, 'model-switch/after', 'claude', 'PostModelSwitch'))
    .toThrow(/observes a completed model switch/u);
  const afterAllowed = await render('model-switch/after', after, 'PostModelSwitch', { outcome: 'allow' });
  expect(() => projectEventDocument(afterAllowed.document, 'model-switch/after', 'claude', 'PostModelSwitch'))
    .toThrow(/does not accept outcome "allow"/u);

  // Envelope validation follows the documented input: PostModelSwitch alone adds the auto and resume sources.
  const validation = { canonicalEvent: 'model-switch/before' as const, nativeEvent: 'PreModelSwitch', target: 'claude' };
  expect(() => validateNativeEventEnvelope({ ...before, source: 'auto' }, validation)).toThrow(/native source is invalid/u);
  expect(() => validateNativeEventEnvelope({ ...before, requested_model: 7 }, validation)).toThrow(/requested_model must be a string or null/u);
  expect(() => validateNativeEventEnvelope({ ...before, cache_ttl: '2h' }, validation)).toThrow(/cache_ttl is invalid/u);
  expect(() => validateNativeEventEnvelope({ ...before, pricing: 'free' }, validation)).toThrow(/pricing is invalid/u);
  expect(() => validateNativeEventEnvelope({ ...before, to_model: '' }, validation)).toThrow(/to_model must be a nonempty string/u);
  expect(validateNativeEventEnvelope(
    { ...after, source: 'resume', requested_model: 'claude-opus-5' },
    { canonicalEvent: 'model-switch/after', nativeEvent: 'PostModelSwitch', target: 'claude' },
  )).toMatchObject({ source: 'resume' });
});

it('projects tool/before pass-through as no decision and only explicit allow/ask/deny as one (#461)', async () => {
  // Native envelopes are the captured host-test PreToolUse/preToolUse
  // records in fixtures/host-lineage (Claude 2.1.257, Codex 0.147.0,
  // Cursor 3.18.25), trimmed to the validated fields.
  const claudeNative = {
    cwd: '/tmp/host-test/claude-workspace',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    session_id: '7f7a50ca-3609-4612-8db1-a34c8985088a',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Bash',
    tool_use_id: 'toolu_01Nj8kitmmxAGYiCXF5NA9ZB',
    transcript_path: '/tmp/host-test/claude-home/.claude/projects/-tmp-host-test-claude-workspace/7f7a50ca.jsonl',
  };
  const codexNative = {
    cwd: '/tmp/host-test/codex-workspace',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.6-sol',
    permission_mode: 'default',
    session_id: '01a06660-110e-7290-8d1c-8ef1b2b68fc2',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Bash',
    tool_use_id: 'exec-95e92c51-9373-4a8e-9cc1-5f2bf32efee1',
    transcript_path: null,
    turn_id: '01a06660-1179-7bd2-bb02-d4cac726b2a0',
  };
  const cursorNative = {
    conversation_id: 'b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c',
    cursor_version: '3.18.25',
    cwd: '/tmp/host-test/cursor-workspace',
    hook_event_name: 'preToolUse',
    session_id: 'b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c',
    tool_input: { command: 'rm -rf build' },
    tool_name: 'Shell',
    tool_use_id: 'call-130a53a3-5718-473b-8101-a9c73231b7be-0',
  };
  const hosts = [
    { native: claudeNative, nativeEvent: 'PreToolUse', revision: '2.1.250', target: 'claude' },
    { native: codexNative, nativeEvent: 'PreToolUse', revision: '0.147.0', target: 'codex' },
    { native: cursorNative, nativeEvent: 'preToolUse', revision: '2026-08-28', target: 'cursor' },
  ] as const;
  const render = async (host: (typeof hosts)[number], value?: JsonValue, context?: string) => {
    const native = validateNativeEventEnvelope(host.native, { canonicalEvent: 'tool/before', nativeEvent: host.nativeEvent, target: host.target });
    const props = createCanonicalEventProps('tool/before', native, host.target, host.nativeEvent, host.revision, new AbortController().signal);
    const rendered = await renderRoute({
      default: async () => createElement(
        Agent.Result,
        value === undefined ? null : { value },
        context === undefined ? null : createElement(Agent.Context, null, context),
      ),
    }, {
      input: { canonical: props.canonical, native: props.native },
      kind: 'event-route',
      routeId: 'event:tool/before',
    });
    return projectEventDocument(rendered.document, 'tool/before', host.target, host.nativeEvent, native);
  };
  const rewrite = { command: 'rm -r build' };

  for (const host of hosts) {
    // Pass-through: an empty result, `continue`, and an unrelated value all
    // leave the host's own permission flow untouched — nothing is written.
    expect(await render(host)).toBeUndefined();
    expect(await render(host, { outcome: 'continue' })).toBeUndefined();
    // A reason has no channel without a decision.
    await expect(render(host, { outcome: 'continue', reason: 'Looks fine.' })).rejects
      .toThrow(/tool\/before reason is only valid when outcome is allow, ask, or deny/u);
  }

  for (const host of hosts.filter((candidate) => candidate.target !== 'cursor')) {
    // Context alone rides the context channel with no permissionDecision.
    expect(await render(host, undefined, 'Build tree is dirty.')).toEqual({
      hookSpecificOutput: { additionalContext: 'Build tree is dirty.', hookEventName: 'PreToolUse' },
    });
    expect(await render(host, { outcome: 'continue' }, 'Build tree is dirty.')).toEqual({
      hookSpecificOutput: { additionalContext: 'Build tree is dirty.', hookEventName: 'PreToolUse' },
    });
    // A rewrite without a decision is evaluated by the host's permission
    // rules against the rewritten input; it does not imply approval.
    expect(await render(host, { outcome: 'continue', updatedInput: rewrite })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewrite },
    });
    // Explicit decisions project exactly the host field.
    expect(await render(host, { outcome: 'allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(await render(host, { outcome: 'allow', reason: 'Trusted build script.', updatedInput: rewrite }, 'Rewritten.')).toEqual({
      hookSpecificOutput: {
        additionalContext: 'Rewritten.',
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Trusted build script.',
        updatedInput: rewrite,
      },
    });
    expect(await render(host, { outcome: 'ask', reason: 'Confirm the rewritten command.', updatedInput: rewrite })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Confirm the rewritten command.',
        updatedInput: rewrite,
      },
    });
    expect(await render(host, { outcome: 'deny', reason: 'Destructive command blocked.' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Destructive command blocked.',
      },
    });
  }

  // Cursor: https://cursor.com/docs/hooks#pretooluse documents permission
  // allow|deny with updated_input; "ask" is accepted by the schema but not
  // enforced, so it fails closed instead of being silently downgraded.
  const cursor = hosts[2];
  expect(await render(cursor, { outcome: 'allow' })).toEqual({ permission: 'allow' });
  expect(await render(cursor, { outcome: 'allow', updatedInput: rewrite })).toEqual({ permission: 'allow', updated_input: rewrite });
  expect(await render(cursor, { outcome: 'continue', updatedInput: rewrite })).toEqual({ permission: 'allow', updated_input: rewrite });
  expect(await render(cursor, { outcome: 'deny', reason: 'Destructive command blocked.' })).toEqual({
    agent_message: 'Destructive command blocked.',
    permission: 'deny',
    user_message: 'Destructive command blocked.',
  });
  await expect(render(cursor, { outcome: 'ask', reason: 'Confirm.' })).rejects
    .toThrow(/Cursor preToolUse accepts permission "ask" in its schema but does not enforce it/u);

  // allow and ask are tool/before decisions; every other family rejects them
  // instead of treating them as continue.
  const stopProps = createCanonicalEventProps(
    'stop',
    { cwd: '/workspace', hook_event_name: 'Stop', session_id: 'session-1', stop_hook_active: false, transcript_path: '/workspace/transcript.jsonl' },
    'claude',
    'Stop',
    '2.1.250',
    new AbortController().signal,
  );
  for (const outcome of ['allow', 'ask']) {
    const rendered = await renderRoute({
      default: async () => createElement(Agent.Result, { value: { outcome } }),
    }, { input: { canonical: stopProps.canonical, native: stopProps.native }, kind: 'event-route', routeId: 'event:stop' });
    expect(() => projectEventDocument(rendered.document, 'stop', 'claude', 'Stop'))
      .toThrow(new RegExp(`stop does not accept outcome "${outcome}"`, 'u'));
  }
});
