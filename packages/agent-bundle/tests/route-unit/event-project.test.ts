import { Agent, type JsonValue } from '@agent-bundle/runtime';
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

  const allowed = await renderRoute({
    default: async () => createElement(Agent.Result, { value: { outcome: 'continue' } }),
  }, routeInput);
  expect(projectEventDocument(allowed.document, 'permission/request', 'claude', 'PermissionRequest')).toEqual({
    hookSpecificOutput: {
      decision: { behavior: 'allow' },
      hookEventName: 'PermissionRequest',
    },
  });

  const observed = await renderRoute({
    default: async () => createElement(Agent.Result),
  }, routeInput);
  expect(projectEventDocument(observed.document, 'permission/request', 'codex', 'PermissionRequest')).toBeUndefined();

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
