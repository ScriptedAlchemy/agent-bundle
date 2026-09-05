import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.260.json' with { type: 'json' };
import { claudeAdapter } from '../src/adapters/claude.ts';
import type { NormalizedHook, NormalizedHookEvent, NormalizedPlugin } from '../src/core/types.ts';
import { validateNativeEventEnvelope } from '../src/events/projection.ts';
import type { CanonicalAgentEvent } from '../src/routes/public.ts';

const configPath = '/workspace/agent-bundle.config.ts';

/**
 * Every event route the pinned Claude capability table supports, paired with
 * the hook identity `normalizeProject` assigns it and a native envelope of the
 * shape Claude Code writes to the wrapper's stdin. Fixture-backed rows reuse
 * the documented envelopes under `fixtures/events/`; the four inline rows are
 * the events Claude Code fires on every session (the maintainer's live
 * session below reproduced exactly these).
 */
const claudeEventRoutes: readonly {
  readonly hookEvent: NormalizedHookEvent;
  readonly native: string | Readonly<Record<string, unknown>>;
  readonly route: CanonicalAgentEvent;
}[] = [
  { hookEvent: 'agentIdle', native: 'claude-teammate-idle.json', route: 'agent/idle' },
  { hookEvent: 'agentStart', native: 'claude-subagent-start.json', route: 'agent/start' },
  { hookEvent: 'agentStop', native: 'claude-subagent-stop.json', route: 'agent/stop' },
  { hookEvent: 'compactAfter', native: 'claude-post-compact.json', route: 'compact/after' },
  { hookEvent: 'compactBefore', native: 'claude-pre-compact.json', route: 'compact/before' },
  { hookEvent: 'configChange', native: 'claude-config-change.json', route: 'config/change' },
  { hookEvent: 'fileChange', native: 'claude-file-changed.json', route: 'file/change' },
  { hookEvent: 'modelSwitchAfter', native: 'claude-post-model-switch.json', route: 'model-switch/after' },
  { hookEvent: 'modelSwitchBefore', native: 'claude-pre-model-switch.json', route: 'model-switch/before' },
  { hookEvent: 'permissionDenied', native: 'claude-permission-denied.json', route: 'permission/denied' },
  { hookEvent: 'permissionRequest', native: 'claude-permission-request.json', route: 'permission/request' },
  { hookEvent: 'promptSubmit', native: 'claude-user-prompt-submit.json', route: 'prompt/submit' },
  { hookEvent: 'sessionEnd', native: 'claude-session-end.json', route: 'session/end' },
  {
    hookEvent: 'sessionStart',
    native: {
      cwd: '/workspace',
      hook_event_name: 'SessionStart',
      session_id: 'session-claude-1',
      source: 'startup',
      transcript_path: '/workspace/.claude/projects/session.jsonl',
    },
    route: 'session/start',
  },
  {
    hookEvent: 'stop',
    native: {
      cwd: '/workspace',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done.',
      permission_mode: 'default',
      session_id: 'session-claude-1',
      stop_hook_active: false,
      transcript_path: '/workspace/.claude/projects/session.jsonl',
    },
    route: 'stop',
  },
  { hookEvent: 'stopFailure', native: 'claude-stop-failure.json', route: 'stop/failure' },
  { hookEvent: 'taskComplete', native: 'claude-task-completed.json', route: 'task/complete' },
  { hookEvent: 'taskCreate', native: 'claude-task-created.json', route: 'task/create' },
  {
    hookEvent: 'afterTool',
    native: {
      cwd: '/workspace',
      hook_event_name: 'PostToolUse',
      permission_mode: 'bypassPermissions',
      session_id: 'session-claude-1',
      tool_input: { command: 'git status --short', description: 'Show the working tree' },
      tool_name: 'Bash',
      tool_response: { interrupted: false, isImage: false, stderr: '', stdout: ' M README.md\n' },
      tool_use_id: 'toolu_01LvwxiKhvU7wJ1Hf2MUJ2hu',
      transcript_path: '/workspace/.claude/projects/session.jsonl',
    },
    route: 'tool/after',
  },
  {
    hookEvent: 'beforeTool',
    native: {
      cwd: '/workspace',
      hook_event_name: 'PreToolUse',
      permission_mode: 'bypassPermissions',
      session_id: 'session-claude-1',
      tool_input: { command: 'git status --short', description: 'Show the working tree' },
      tool_name: 'Bash',
      tool_use_id: 'toolu_01Taws9XLqrL8XQk4BsTkjps',
      transcript_path: '/workspace/.claude/projects/session.jsonl',
    },
    route: 'tool/before',
  },
  { hookEvent: 'toolFailure', native: 'claude-post-tool-use-failure.json', route: 'tool/failure' },
];

const pinnedClaudeRoutes: Readonly<Record<string, { readonly nativeEvent?: string; readonly state: string }>> =
  claudeCapabilityTable.hooks.eventRoutes;

const supportedClaudeRoutes = Object.entries(pinnedClaudeRoutes)
  .filter(([, capability]) => capability.state === 'supported')
  .map(([route]) => route)
  .sort();

const routeHook = (
  route: CanonicalAgentEvent,
  hookEvent: NormalizedHookEvent,
  targets: readonly string[],
): NormalizedHook => {
  const name = `event-route-${route.replace('/', '-')}`;
  return {
    event: hookEvent,
    eventRoute: { event: route, fallback: 'none', runtime: 'shared' },
    id: `hook:${name}`,
    name,
    provenance: { kind: 'conventional', sourcePath: `/workspace/src/events/${route}.tsx` },
    source: `/workspace/src/events/${route}.tsx`,
    targets,
    tools: [],
  };
};

const model = (target: string, hooks: readonly NormalizedHook[]): NormalizedPlugin => ({
  extensions: {},
  hooks,
  mcpServers: [],
  metadata: {
    description: 'Claude hook_event_name regression.',
    id: 'plugin:hook-event-name',
    name: 'hook-event-name',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: `target:${target}`,
    name: target,
    provenance: { kind: 'config', sourcePath: configPath },
  }],
});

const nativeEnvelope = async (
  native: string | Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> =>
  typeof native === 'string'
    ? JSON.parse(await readFile(new URL(`./fixtures/events/${native}`, import.meta.url), 'utf8')) as Record<string, unknown>
    : native;

const writes = (plan: { readonly entries: readonly { readonly kind: string; readonly relativePath: string; readonly content?: string }[] }) =>
  Object.fromEntries(plan.entries.flatMap((entry) => entry.kind === 'write' ? [[entry.relativePath, entry.content!]] : []));

it('covers every event route the pinned Claude capability table supports', () => {
  expect(claudeEventRoutes.map((entry) => entry.route).sort()).toEqual(supportedClaudeRoutes);
});

it('bakes the pinned Claude hook_event_name into every Claude event-route wrapper and accepts the native envelope', async () => {
  const hooks = claudeEventRoutes.map((entry) => routeHook(entry.route, entry.hookEvent, ['claude']));
  const plan = claudeAdapter.plan(model('claude', hooks));
  expect(plan.diagnostics).toEqual([]);

  const document = JSON.parse(writes(plan)['hooks/hooks.json']!) as { readonly hooks: Record<string, unknown> };
  for (const entry of claudeEventRoutes) {
    const expectedNativeEvent = pinnedClaudeRoutes[entry.route]?.nativeEvent;
    expect(expectedNativeEvent, entry.route).toEqual(expect.any(String));
    const wrapper = (plan.hookEntries ?? []).find((candidate) => candidate.hook.eventRoute?.event === entry.route);
    expect(wrapper, entry.route).toBeDefined();
    // The document key, the baked constant, and the runtime comparison all
    // carry Claude's PascalCase spelling; the wrapper compares the envelope's
    // hook_event_name against exactly that constant.
    expect(Object.keys(document.hooks), entry.route).toContain(expectedNativeEvent);
    expect(wrapper!.nativeEvent, entry.route).toBe(expectedNativeEvent);
    expect(wrapper!.virtualSource, entry.route).toContain(`const nativeEvent = ${JSON.stringify(expectedNativeEvent)};`);
    expect(wrapper!.virtualSource, entry.route).toContain('const target = "claude";');
    expect(wrapper!.virtualSource, entry.route).toContain('validateNativeEventEnvelope(parsed, { canonicalEvent, nativeEvent, target })');

    const native = await nativeEnvelope(entry.native);
    expect(native.hook_event_name, entry.route).toBe(expectedNativeEvent);
    expect(
      validateNativeEventEnvelope(native, { canonicalEvent: entry.route, nativeEvent: wrapper!.nativeEvent, target: 'claude' }),
      entry.route,
    ).toEqual(native);
  }
});

it('accepts the live PostToolUse:Bash envelope under the Claude wrapper and names a Cursor wrapper as the only source of the observed error', async () => {
  // Regression for the maintainer's Claude Code 2.1.257 session (2026-09-03
  // 20:47:53Z): every `PostToolUse:Bash` hook failed with
  // "Agent Bundle event route error: native hook_event_name must equal
  // postToolUse". Claude sends PascalCase; only a wrapper compiled for the
  // `cursor` target bakes the camelCase constant, so the message identifies a
  // Cursor-built wrapper installed under a Claude plugin root, not a Claude
  // mapping defect.
  const live = await nativeEnvelope(claudeEventRoutes.find((entry) => entry.route === 'tool/after')!.native);
  const [claudeWrapper] = claudeAdapter.plan(model('claude', [routeHook('tool/after', 'afterTool', ['claude'])])).hookEntries ?? [];
  expect(claudeWrapper?.nativeEvent).toBe('PostToolUse');
  expect(validateNativeEventEnvelope(live, { canonicalEvent: 'tool/after', nativeEvent: claudeWrapper!.nativeEvent, target: 'claude' }))
    .toEqual(live);

  expect(() => validateNativeEventEnvelope(live, { canonicalEvent: 'tool/after', nativeEvent: 'postToolUse', target: 'cursor' }))
    .toThrow('Agent Bundle event route error: native hook_event_name must equal postToolUse');
  expect(() => validateNativeEventEnvelope(
    { ...live, hook_event_name: 'PreToolUse', tool_response: undefined },
    { canonicalEvent: 'tool/before', nativeEvent: 'preToolUse', target: 'cursor' },
  )).toThrow('Agent Bundle event route error: native hook_event_name must equal preToolUse');
});

it('emits no manifest hooks pointer for Claude Code, which auto-loads hooks/hooks.json and flags a pointer at it as a duplicate', () => {
  // Claude Code 2.1.259 (observed): `hooks/hooks.json` is loaded on its own
  // and `manifest.hooks` is for additional documents only. Naming the
  // conventional file records a `hook-load-failed` plugin error, "Duplicate
  // hooks file detected ... The standard hooks/hooks.json is loaded
  // automatically, so manifest.hooks should only reference additional hook
  // files." Claude Code never scans `hooks/` for other documents.
  const claude = writes(claudeAdapter.plan(model('claude', [routeHook('tool/after', 'afterTool', ['claude'])])));
  expect(claude['hooks/hooks.json']).toBeDefined();
  expect(JSON.parse(claude['.claude-plugin/plugin.json']!)).not.toHaveProperty('hooks');
});
