import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import {
  codexMcpEvidence,
  codexSkillActivationEvidence,
  normalizeCodexEventStream,
} from '../src/eval/codex-events.ts';

const fixtureRoot = new URL('../fixtures/eval/codex/', import.meta.url);

const loadStream = async (name: string): Promise<string> =>
  readFile(new URL(name, fixtureRoot), 'utf8');

it('normalizes a complete Codex JSONL run into redacted envelopes and typed items', async () => {
  const run = normalizeCodexEventStream(await loadStream('complete-run.jsonl'));

  expect(run.envelopes).toEqual([
    { fields: ['thread_id', 'type'], type: 'thread.started' },
    { fields: ['type'], type: 'turn.started' },
    { fields: ['item', 'type'], itemType: 'reasoning', type: 'item.completed' },
    { fields: ['item', 'type'], itemType: 'command_execution', type: 'item.started' },
    { fields: ['item', 'type'], itemType: 'command_execution', type: 'item.completed' },
    { fields: ['item', 'type'], itemType: 'mcp_tool_call', type: 'item.completed' },
    { fields: ['item', 'type'], itemType: 'agent_message', type: 'item.completed' },
    { fields: ['type', 'usage'], type: 'turn.completed' },
  ]);
  expect(run.commands).toEqual([{ command: 'cat skills/release-notes/SKILL.md', exitCode: 0 }]);
  expect(run.messages).toEqual(['Drafted the release notes.']);
  expect(run.mcpCalls).toEqual([{ server: 'project', tool: 'status' }]);
  expect(run.completed).toBe(true);
  expect(run.errors).toEqual([]);
  expect(run.malformedLines).toBe(0);
});

it('records one MCP call per item identity across started and completed events', async () => {
  const run = normalizeCodexEventStream(await loadStream('mcp-calls.jsonl'));

  expect(run.mcpCalls).toEqual([
    { server: 'project', tool: 'status' },
    { server: 'project', tool: 'status' },
    { server: 'project', tool: 'lint' },
  ]);
});

it('reports observed MCP evidence only for a completed, well-formed stream', async () => {
  const complete = normalizeCodexEventStream(await loadStream('complete-run.jsonl'));
  const truncated = normalizeCodexEventStream(await loadStream('truncated.jsonl'));
  const malformed = normalizeCodexEventStream(await loadStream('malformed.jsonl'));

  expect(codexMcpEvidence(complete)).toEqual({
    calls: [{ server: 'project', tool: 'status' }],
    level: 'observed',
  });
  expect(codexMcpEvidence(truncated).level).toBe('unavailable');
  expect(codexMcpEvidence(malformed).level).toBe('unavailable');
});

it('keeps Codex Skill activation inferred and never upgrades it to observed', async () => {
  const run = normalizeCodexEventStream(await loadStream('complete-run.jsonl'));

  expect(codexSkillActivationEvidence(run, ['release-notes', 'triage'])).toEqual({
    activated: ['release-notes'],
    level: 'inferred',
  });
  expect(codexSkillActivationEvidence(run, ['release-notes']).level).not.toBe('observed');
});

it('infers no activation when the run never references a packaged Skill', async () => {
  const run = normalizeCodexEventStream(await loadStream('no-skill.jsonl'));

  expect(codexSkillActivationEvidence(run, ['release-notes'])).toEqual({
    activated: [],
    level: 'inferred',
  });
});

it('reports unavailable activation evidence when the stream cannot be trusted', async () => {
  const malformed = normalizeCodexEventStream(await loadStream('malformed.jsonl'));
  const empty = normalizeCodexEventStream('');

  expect(malformed.malformedLines).toBe(1);
  expect(codexSkillActivationEvidence(malformed, ['release-notes'])).toEqual({
    activated: [],
    level: 'unavailable',
  });
  expect(codexSkillActivationEvidence(empty, ['release-notes']).level).toBe('unavailable');
});

it('captures turn failures and stream errors without inventing a completed turn', async () => {
  const failed = normalizeCodexEventStream(await loadStream('turn-failed.jsonl'));
  const errored = normalizeCodexEventStream(await loadStream('stream-error.jsonl'));

  expect(failed.completed).toBe(false);
  expect(failed.errors).toEqual(['The turn ended before the model produced a final message.']);
  expect(failed.commands).toEqual([{ command: 'npm test', exitCode: 1 }]);
  expect(errored.completed).toBe(false);
  expect(errored.errors).toEqual(['The host reported an unrecoverable stream error.']);
});

it('reads the repeated item identifiers the installed Codex CLI really emits', async () => {
  const run = normalizeCodexEventStream(await loadStream('duplicate-item-id.jsonl'));

  expect(run.malformedLines).toBe(0);
  expect(run.completed).toBe(true);
  expect(run.mcpCalls).toEqual([{ server: 'codex', tool: 'list_mcp_resources' }]);
  expect(codexSkillActivationEvidence(run, ['release-notes'])).toEqual({
    activated: ['release-notes'],
    level: 'inferred',
  });
});

it('does not match a Skill name that only appears inside a longer identifier', () => {
  const run = normalizeCodexEventStream(
    `${JSON.stringify({ type: 'thread.started' })}\n`
    + `${JSON.stringify({
      item: { id: 'item_0', text: 'Consulted skills/release-notes-legacy/SKILL.md.', type: 'agent_message' },
      type: 'item.completed',
    })}\n`
    + `${JSON.stringify({ type: 'turn.completed' })}\n`,
  );

  expect(codexSkillActivationEvidence(run, ['release-notes'])).toEqual({
    activated: [],
    level: 'inferred',
  });
});
