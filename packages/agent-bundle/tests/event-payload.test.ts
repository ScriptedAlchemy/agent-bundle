import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import claudeCapabilityTable from '../src/adapters/capabilities/claude-2.1.260.json' with { type: 'json' };
import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import cursorCapabilityTable from '../src/adapters/capabilities/cursor-2026-08-28.json' with { type: 'json' };
import type { EventRouteCapabilityTableEntry } from '../src/adapters/capability-state.ts';
import { hookEventFields, type HookHandlerEventName } from '../src/adapters/hook-handler.ts';
import { createCanonicalEventProps, projectEventPayload } from '../src/events/project.ts';
import {
  agentEventPayloadFieldKinds,
  agentEventPayloadFields,
  agentEventPayloadNativeKeys,
  canonicalAgentEvents,
  type AgentEventPayloadField,
  type AgentEventPayloadFieldName,
  type AgentEventPayloadHost,
  type AgentEventPayloadNativeKey,
  type CanonicalAgentEvent,
} from '../src/routes/public.ts';

/**
 * The canonical payload of an event route (#466), proven against the live
 * host captures under `fixtures/host-lineage/`: every envelope those runs
 * observed on Claude Code, Codex, and Cursor is projected through the same
 * table the artifact uses, and each mapped field is checked back against the
 * host key it claims to come from.
 */

interface CapturedEvent {
  readonly event: CanonicalAgentEvent;
  readonly host: AgentEventPayloadHost;
  readonly native: Readonly<Record<string, unknown>>;
  readonly nativeEvent: string;
}

const liveFixtures: Readonly<Record<AgentEventPayloadHost, string>> = {
  claude: 'claude-2.1.259-orchestration',
  codex: 'codex-0.147.0',
  cursor: 'cursor-3.18.25',
};

const hostTables: Readonly<Record<AgentEventPayloadHost, Readonly<Record<string, EventRouteCapabilityTableEntry>>>> = {
  claude: claudeCapabilityTable.hooks.eventRoutes,
  codex: codexCapabilityTable.hooks.eventRoutes,
  cursor: cursorCapabilityTable.hooks.eventRoutes,
};

const hosts = Object.keys(liveFixtures) as AgentEventPayloadHost[];
const signal = new AbortController().signal;

const capturedEvents = async (host: AgentEventPayloadHost): Promise<readonly CapturedEvent[]> => {
  const text = await readFile(new URL(`../../../fixtures/host-lineage/${liveFixtures[host]}.ndjson`, import.meta.url), 'utf8');
  const events: CapturedEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as {
      readonly event?: {
        readonly canonical: { readonly event: CanonicalAgentEvent; readonly provenance: { readonly nativeEvent: string } };
        readonly native: Readonly<Record<string, unknown>>;
      };
      readonly host: AgentEventPayloadHost;
      readonly kind: string;
    };
    if (record.kind !== 'event' || record.event === undefined) continue;
    events.push({
      event: record.event.canonical.event,
      host: record.host,
      native: record.event.native,
      nativeEvent: record.event.canonical.provenance.nativeEvent,
    });
  }
  expect(events.length, `${host} captured events`).toBeGreaterThan(0);
  return events;
};

const payloadEntries = (
  payload: Readonly<Record<string, AgentEventPayloadField<unknown> | undefined>>,
): readonly (readonly [AgentEventPayloadFieldName, AgentEventPayloadField<unknown>])[] =>
  Object.entries(payload)
    .filter((entry): entry is [AgentEventPayloadFieldName, AgentEventPayloadField<unknown>] => entry[1] !== undefined);

it('projects every live-captured envelope through the host mapping, and every field names the key it was read from', async () => {
  for (const host of hosts) {
    const seen = new Set<string>();
    for (const captured of await capturedEvents(host)) {
      const mapping = agentEventPayloadNativeKeys[host][captured.event];
      expect(mapping, `${host} ${captured.event} has a payload mapping`).toBeDefined();
      const props = createCanonicalEventProps(captured.event, captured.native, host, captured.nativeEvent, 'live', signal);
      const admitted: readonly string[] = agentEventPayloadFields[captured.event];
      for (const [field, mapped] of payloadEntries(props.canonical.payload)) {
        seen.add(`${captured.event}:${field}`);
        expect(admitted, `${host} ${captured.event} admits ${field}`).toContain(field);
        expect(mapped.nativeKey).toBe(mapping![field]!.nativeKey);
        expect(Object.hasOwn(captured.native, mapped.nativeKey), `${host} ${captured.event} ${field} came from the envelope`).toBe(true);
        if (mapping![field]!.decode === undefined) {
          expect(mapped.value).toEqual(captured.native[mapped.nativeKey]);
        }
      }
      // Whatever the envelope carried under a mapped key of the right shape is on the payload: nothing is dropped.
      for (const [field, mapped] of Object.entries(mapping!) as [AgentEventPayloadFieldName, AgentEventPayloadNativeKey][]) {
        if (!Object.hasOwn(captured.native, mapped.nativeKey) || mapped.decode !== undefined) continue;
        const raw = captured.native[mapped.nativeKey];
        const shaped = agentEventPayloadFieldKinds[field] === 'string' ? typeof raw === 'string'
          : agentEventPayloadFieldKinds[field] === 'boolean' ? typeof raw === 'boolean'
            : true;
        if (shaped) expect(props.canonical.payload[field], `${host} ${captured.event} ${field}`).toBeDefined();
      }
      // Frozen, like the rest of the props.
      expect(Object.isFrozen(props.canonical.payload)).toBe(true);
    }
    // The captures exercise the fields the issue is about on every host.
    for (const expected of ['tool/before:toolName', 'tool/before:toolInput', 'tool/before:toolUseId', 'tool/after:toolResponse', 'stop:reentry', 'agent/start:agentId', 'agent/start:agentType', 'tool/before:sessionId', 'prompt/submit:prompt']) {
      expect(seen.has(expected), `${host} captured ${expected}`).toBe(true);
    }
  }
});

it('lets a tool/before route read toolName and toolInput identically under the Claude, Codex, and Cursor captures', async () => {
  for (const host of hosts) {
    const captured = (await capturedEvents(host)).find((candidate) => candidate.event === 'tool/before')!;
    const { payload } = createCanonicalEventProps('tool/before', captured.native, host, captured.nativeEvent, 'live', signal).canonical;
    expect(typeof payload.toolName?.value).toBe('string');
    expect(payload.toolName?.nativeKey).toBe('tool_name');
    expect(typeof payload.toolInput?.value).toBe('object');
    expect(payload.toolInput?.nativeKey).toBe('tool_input');
    expect(typeof payload.toolUseId?.value).toBe('string');
    expect(payload.sessionId?.value).toBe(host === 'cursor' ? captured.native.conversation_id : captured.native.session_id);
    expect(payload.sessionId?.nativeKey).toBe(host === 'cursor' ? 'conversation_id' : 'session_id');
  }
});

it('reads stop re-entry as one boolean: stop_hook_active on Claude and Codex, loop_count > 0 on Cursor', () => {
  const standard = { cwd: '/repo', hook_event_name: 'Stop', last_assistant_message: 'Done.', session_id: 's', transcript_path: '/t.jsonl' };
  for (const host of ['claude', 'codex'] as const) {
    expect(projectEventPayload('stop', { ...standard, stop_hook_active: true }, host).reentry)
      .toEqual({ nativeKey: 'stop_hook_active', value: true });
    expect(projectEventPayload('stop', { ...standard, stop_hook_active: false }, host).reentry)
      .toEqual({ nativeKey: 'stop_hook_active', value: false });
    expect(projectEventPayload('stop', { ...standard, stop_hook_active: false }, host).lastAssistantMessage)
      .toEqual({ nativeKey: 'last_assistant_message', value: 'Done.' });
  }
  const cursor = { conversation_id: 'c', hook_event_name: 'stop', status: 'completed' };
  expect(projectEventPayload('stop', { ...cursor, loop_count: 1 }, 'cursor').reentry).toEqual({ nativeKey: 'loop_count', value: true });
  expect(projectEventPayload('stop', { ...cursor, loop_count: 0 }, 'cursor').reentry).toEqual({ nativeKey: 'loop_count', value: false });
  // Cursor's stop carries no final assistant text; the field is absent, not fabricated from `status`.
  expect('lastAssistantMessage' in projectEventPayload('stop', { ...cursor, loop_count: 0 }, 'cursor')).toBe(false);
  // agent/stop shares the same re-entry reading.
  expect(projectEventPayload('agent/stop', { ...cursor, hook_event_name: 'subagentStop', loop_count: 2, subagent_type: 'explore' }, 'cursor'))
    .toMatchObject({ agentType: { nativeKey: 'subagent_type', value: 'explore' }, reentry: { nativeKey: 'loop_count', value: true } });
});

it('parses Cursor tool_output when it is JSON and keeps it as the string the host sent otherwise', () => {
  const base = { conversation_id: 'c', cwd: '/repo', hook_event_name: 'postToolUse', tool_input: { command: 'ls' }, tool_name: 'Shell', tool_use_id: 'call-1' };
  expect(projectEventPayload('tool/after', { ...base, tool_output: '{"success":true,"lines":3}' }, 'cursor').toolResponse)
    .toEqual({ nativeKey: 'tool_output', value: { lines: 3, success: true } });
  expect(projectEventPayload('tool/after', { ...base, tool_output: 'plain terminal text' }, 'cursor').toolResponse)
    .toEqual({ nativeKey: 'tool_output', value: 'plain terminal text' });
  // Claude and Codex deliver tool_response as JSON already — an object for built-in tools, a string for MCP tools on Claude.
  const claude = { cwd: '/repo', hook_event_name: 'PostToolUse', session_id: 's', tool_input: {}, tool_name: 'Write', tool_use_id: 't', transcript_path: '/t' };
  expect(projectEventPayload('tool/after', { ...claude, tool_response: { filePath: '/a', success: true } }, 'claude').toolResponse)
    .toEqual({ nativeKey: 'tool_response', value: { filePath: '/a', success: true } });
  expect(projectEventPayload('tool/after', { ...claude, tool_response: 'text' }, 'claude').toolResponse)
    .toEqual({ nativeKey: 'tool_response', value: 'text' });
});

it('never fabricates a field: hosts that do not send one leave it absent, null stays null, and wrong shapes are dropped', () => {
  const cursorStart = projectEventPayload('session/start', { conversation_id: 'c', hook_event_name: 'sessionStart', model: 'default', transcript_path: null }, 'cursor');
  expect(cursorStart).toEqual({
    model: { nativeKey: 'model', value: 'default' },
    sessionId: { nativeKey: 'conversation_id', value: 'c' },
    transcriptPath: { nativeKey: 'transcript_path', value: null },
  });
  expect(Object.keys(cursorStart)).not.toContain('source');
  expect(Object.keys(cursorStart)).not.toContain('cwd');
  expect(Object.keys(cursorStart)).not.toContain('permissionMode');
  // A Cursor envelope that also spells session_id still maps sessionId from the documented conversation_id.
  expect(projectEventPayload('session/start', { conversation_id: 'c', hook_event_name: 'sessionStart', session_id: 'c' }, 'cursor').sessionId)
    .toEqual({ nativeKey: 'conversation_id', value: 'c' });
  // A wrong shape is not coerced: the field is absent and `native` still has the raw value.
  expect(projectEventPayload('stop', { hook_event_name: 'Stop', session_id: 's', stop_hook_active: 'yes' }, 'claude').reentry).toBeUndefined();
  expect(projectEventPayload('compact/before', { hook_event_name: 'PreCompact', session_id: 's', trigger: 'sometimes' }, 'claude').trigger).toBeUndefined();
  expect(projectEventPayload('stop', { conversation_id: 'c', hook_event_name: 'stop', loop_count: 'one' }, 'cursor').reentry).toBeUndefined();
  // A host without a mapping table gets an empty payload, never a guess.
  expect(projectEventPayload('tool/before', { hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'portable')).toEqual({});
  expect(projectEventPayload('tool/before', { hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'plugin')).toEqual({});
  // A family a host does not support has no mapping either.
  expect(projectEventPayload('task/create', { hook_event_name: 'TaskCreated', session_id: 's', task_id: 't' }, 'codex')).toEqual({});
});

it('projects the Claude-only model-switch families from the documented PreModelSwitch / PostModelSwitch input (2.1.260 re-pin)', async () => {
  const fixture = async (name: string): Promise<Readonly<Record<string, unknown>>> =>
    JSON.parse(await readFile(new URL(`./fixtures/events/${name}.json`, import.meta.url), 'utf8')) as Readonly<Record<string, unknown>>;
  const before = projectEventPayload('model-switch/before', await fixture('claude-pre-model-switch'), 'claude');
  expect(before).toEqual({
    cwd: { nativeKey: 'cwd', value: '/workspace' },
    fromModel: { nativeKey: 'from_model', value: 'claude-sonnet-5' },
    requestedModel: { nativeKey: 'requested_model', value: 'opus' },
    sessionId: { nativeKey: 'session_id', value: 'session-claude-1' },
    source: { nativeKey: 'source', value: 'command' },
    toModel: { nativeKey: 'to_model', value: 'claude-opus-5' },
    transcriptPath: { nativeKey: 'transcript_path', value: '/workspace/.claude/projects/session.jsonl' },
  });
  // An automatic switch names no requested model: `null` is kept as the host sent it.
  const after = projectEventPayload('model-switch/after', await fixture('claude-post-model-switch'), 'claude');
  expect(after.requestedModel).toEqual({ nativeKey: 'requested_model', value: null });
  expect(after.source).toEqual({ nativeKey: 'source', value: 'auto' });
  // The cache and pricing fields stay host-specific: read them from `native`.
  expect(Object.keys(after)).not.toContain('contextTokens');
  expect(Object.keys(after)).not.toContain('pricing');
  // No other host maps the family.
  expect(agentEventPayloadNativeKeys.codex['model-switch/before']).toBeUndefined();
  expect(agentEventPayloadNativeKeys.cursor['model-switch/after']).toBeUndefined();
});

it('admits every field the config hook handler contract (#488) guarantees for the same family, under the same name', () => {
  // `HookEvent<E>` (adapters/hook-handler.ts) is the wrapper-decoded payload
  // of the six plain-hook events; `canonical.payload` is the provenance-
  // carrying payload of every event-route family. The two tables are held
  // to one vocabulary where they overlap: a field the handler contract
  // requires on every host is admitted here for the matching family.
  const families: Readonly<Record<HookHandlerEventName, CanonicalAgentEvent>> = {
    afterTool: 'tool/after',
    agentStart: 'agent/start',
    agentStop: 'agent/stop',
    beforeTool: 'tool/before',
    sessionStart: 'session/start',
    stop: 'stop',
  };
  const spelling: Readonly<Record<string, AgentEventPayloadFieldName>> = { stopHookActive: 'reentry' };
  for (const [handlerEvent, family] of Object.entries(families) as [HookHandlerEventName, CanonicalAgentEvent][]) {
    const admitted: readonly string[] = agentEventPayloadFields[family];
    for (const field of hookEventFields[handlerEvent].required) {
      expect(admitted, `${family} admits ${handlerEvent}.${field}`).toContain(spelling[field] ?? field);
    }
  }
});

it('keeps the idempotency key a hash of the envelope alone, so the derived payload never re-identifies an event', () => {
  const native = { cwd: '/repo', hook_event_name: 'PreToolUse', session_id: 's', tool_input: { a: 1 }, tool_name: 'Write', tool_use_id: 't', transcript_path: '/t' };
  const props = createCanonicalEventProps('tool/before', native, 'claude', 'PreToolUse', '2.1.250', signal);
  expect(props.canonical.idempotencyKey).toBe(
    createHash('sha256').update(JSON.stringify({ event: 'tool/before', native, target: 'claude' }), 'utf8').digest('hex'),
  );
  expect(props.canonical.payload.toolInput?.value).toEqual({ a: 1 });
  // The payload shares the frozen snapshot's values rather than copying the envelope.
  expect(props.canonical.payload.toolInput?.value).toBe(props.native.tool_input);
});

/** The JSON mirror in the runtime table's shape (`decode` stays the JSON's string; equality checks it). */
const normalizedMirror = (
  payload: NonNullable<EventRouteCapabilityTableEntry['payload']>,
): Readonly<Record<string, { readonly decode?: string; readonly nativeKey: string }>> => Object.fromEntries(
  Object.entries(payload).map(([field, mapping]) => [
    field,
    typeof mapping === 'string'
      ? { nativeKey: mapping }
      : { ...(mapping.decode === undefined ? {} : { decode: mapping.decode }), nativeKey: mapping.nativeKey },
  ]),
);

it('mirrors the runtime mapping table in every pinned capability table, field for field', () => {
  for (const host of hosts) {
    const table = hostTables[host];
    for (const event of canonicalAgentEvents) {
      const row = table[event];
      const mapping = agentEventPayloadNativeKeys[host][event];
      expect(row, `${host} ${event} row`).toBeDefined();
      if (row!.state !== 'supported') {
        expect(mapping, `${host} ${event} is unsupported and maps no payload`).toBeUndefined();
        expect(row!.payload, `${host} ${event} carries no payload mirror`).toBeUndefined();
        continue;
      }
      expect(mapping, `${host} ${event} is supported and maps a payload`).toBeDefined();
      expect(row!.payload, `${host} ${event} mirrors its payload mapping`).toBeDefined();
      expect(normalizedMirror(row!.payload!)).toEqual(mapping);
    }
  }
});

it('admits a family field only when at least two supporting hosts report it, or the family has one host', () => {
  for (const event of canonicalAgentEvents) {
    const supporting = hosts.filter((host) => agentEventPayloadNativeKeys[host][event] !== undefined);
    expect(supporting.length, `${event} is supported somewhere`).toBeGreaterThan(0);
    const admitted: readonly AgentEventPayloadFieldName[] = agentEventPayloadFields[event];
    for (const field of admitted) {
      const reporters = supporting.filter((host) => agentEventPayloadNativeKeys[host][event]![field] !== undefined);
      expect(reporters.length, `${event}.${field} is reported by ${reporters.join(', ') || 'no host'}`)
        .toBeGreaterThanOrEqual(Math.min(2, supporting.length));
    }
    for (const host of supporting) {
      for (const field of Object.keys(agentEventPayloadNativeKeys[host][event]!)) {
        expect(admitted, `${host} ${event} maps only admitted fields`).toContain(field);
      }
    }
  }
  // Every vocabulary field is used by at least one family.
  const used = new Set(Object.values(agentEventPayloadFields).flat());
  for (const field of Object.keys(agentEventPayloadFieldKinds)) {
    expect(used.has(field as AgentEventPayloadFieldName), `${field} belongs to a family`).toBe(true);
  }
});

it('exports the tables frozen through, so a consumer cannot change what later invocations project', () => {
  for (const fields of Object.values(agentEventPayloadFields)) {
    expect(Object.isFrozen(fields)).toBe(true);
  }
  for (const host of hosts) {
    for (const mapping of Object.values(agentEventPayloadNativeKeys[host])) {
      expect(Object.isFrozen(mapping)).toBe(true);
      for (const entry of Object.values(mapping)) expect(Object.isFrozen(entry)).toBe(true);
    }
  }
  expect(() => (agentEventPayloadFields['tool/before'] as unknown as string[]).push('reentry')).toThrow(TypeError);
  expect(Object.isFrozen(agentEventPayloadFieldKinds)).toBe(true);
});
