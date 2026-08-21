import { isRecord } from '../core/strict-json.ts';
import type { EvalActivationEvidence, EvalMcpCallRecord, EvalMcpEvidence } from './types.ts';

/** One `codex exec --json` event reduced to its shape: no payload text is retained here. */
export interface CodexEventEnvelope {
  readonly fields: readonly string[];
  readonly itemType?: string;
  readonly type: string;
}

export interface CodexCommandRecord {
  readonly command: string;
  readonly exitCode?: number;
}

export interface CodexNormalizedRun {
  readonly commands: readonly CodexCommandRecord[];
  readonly completed: boolean;
  readonly envelopes: readonly CodexEventEnvelope[];
  readonly errors: readonly string[];
  readonly malformedLines: number;
  readonly mcpCalls: readonly EvalMcpCallRecord[];
  readonly messages: readonly string[];
  readonly reasoning: readonly string[];
}

interface MutableRun {
  readonly commands: CodexCommandRecord[];
  readonly envelopes: CodexEventEnvelope[];
  readonly errors: string[];
  readonly mcpCalls: EvalMcpCallRecord[];
  readonly messages: string[];
  readonly reasoning: string[];
  readonly seenItems: Set<string>;
  completed: boolean;
  malformedLines: number;
}

const stringField = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? value[key] : undefined;

const integerField = (value: Record<string, unknown>, key: string): number | undefined =>
  typeof value[key] === 'number' && Number.isSafeInteger(value[key]) ? value[key] : undefined;

/** Codex tags the item union with `type`. */
const itemTypeOf = (item: Record<string, unknown>): string | undefined =>
  stringField(item, 'type');

const recordCommand = (run: MutableRun, item: Record<string, unknown>): void => {
  const command = stringField(item, 'command');
  if (command === undefined) return;
  const exitCode = integerField(item, 'exit_code');
  const existing = run.commands.findIndex((entry) => entry.command === command && entry.exitCode === undefined);
  const next: CodexCommandRecord = Object.freeze({
    command,
    ...(exitCode === undefined ? {} : { exitCode }),
  });
  if (existing >= 0 && exitCode !== undefined) run.commands.splice(existing, 1, next);
  else if (existing < 0) run.commands.push(next);
};

const recordItem = (run: MutableRun, item: Record<string, unknown>): void => {
  const itemType = itemTypeOf(item);
  const identity = stringField(item, 'id');
  if (itemType === 'command_execution') recordCommand(run, item);
  if (itemType === 'agent_message') {
    const text = stringField(item, 'text');
    if (text !== undefined && !run.messages.includes(text)) run.messages.push(text);
  }
  if (itemType === 'reasoning') {
    const text = stringField(item, 'text');
    if (text !== undefined && !run.reasoning.includes(text)) run.reasoning.push(text);
  }
  if (itemType === 'error') {
    const message = stringField(item, 'message');
    if (message !== undefined) run.errors.push(message);
  }
  if (itemType !== 'mcp_tool_call') return;
  const server = stringField(item, 'server');
  const tool = stringField(item, 'tool');
  if (server === undefined || tool === undefined) return;
  const key = identity ?? `${server}\u0000${tool}\u0000${run.mcpCalls.length}`;
  if (run.seenItems.has(key)) return;
  run.seenItems.add(key);
  run.mcpCalls.push(Object.freeze({ server, tool }));
};

const recordEvent = (run: MutableRun, event: Record<string, unknown>): void => {
  const type = stringField(event, 'type');
  if (type === undefined) {
    run.malformedLines += 1;
    return;
  }
  const item = isRecord(event.item) ? event.item : undefined;
  const itemType = item === undefined ? undefined : itemTypeOf(item);
  run.envelopes.push(Object.freeze({
    fields: Object.freeze(Object.keys(event).sort()),
    ...(itemType === undefined ? {} : { itemType }),
    type,
  }));
  if (item !== undefined) recordItem(run, item);
  if (type === 'turn.completed') run.completed = true;
  if (type === 'error') {
    const message = stringField(event, 'message');
    if (message !== undefined) run.errors.push(message);
  }
  if (type === 'turn.failed') {
    const error = isRecord(event.error) ? stringField(event.error, 'message') : undefined;
    if (error !== undefined) run.errors.push(error);
  }
};

/**
 * Normalizes a `codex exec --ephemeral --json` stream. Unparseable lines are counted rather
 * than dropped so evidence derived from a partial stream can honestly report it is unusable.
 */
export const normalizeCodexEventStream = (raw: string): CodexNormalizedRun => {
  const run: MutableRun = {
    commands: [],
    completed: false,
    envelopes: [],
    errors: [],
    malformedLines: 0,
    mcpCalls: [],
    messages: [],
    reasoning: [],
    seenItems: new Set<string>(),
  };
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      // Codex repeats `id` inside some item events, so this foreign stream is read with the
      // permissive parser rather than the strict one Agent Bundle applies to its own documents.
      parsed = JSON.parse(line) as unknown;
    } catch {
      run.malformedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      run.malformedLines += 1;
      continue;
    }
    recordEvent(run, parsed);
  }
  return Object.freeze({
    commands: Object.freeze([...run.commands]),
    completed: run.completed,
    envelopes: Object.freeze([...run.envelopes]),
    errors: Object.freeze([...run.errors]),
    malformedLines: run.malformedLines,
    mcpCalls: Object.freeze([...run.mcpCalls]),
    messages: Object.freeze([...run.messages]),
    reasoning: Object.freeze([...run.reasoning]),
  });
};

/** A stream with an unreadable line may have hidden further activity, so nothing is claimed from it. */
const streamUsable = (run: CodexNormalizedRun): boolean =>
  run.malformedLines === 0 && run.envelopes.length > 0;

/** Codex reports every tool call as an item, so a completed clean stream is an authoritative list. */
export const codexMcpEvidence = (run: CodexNormalizedRun): EvalMcpEvidence => {
  const observed = streamUsable(run) && run.completed;
  return Object.freeze({
    calls: observed ? run.mcpCalls : Object.freeze([]),
    level: observed ? 'observed' : 'unavailable',
  });
};

const mentions = (haystack: readonly string[], skill: string): boolean => {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${escaped}(?:$|[^\\p{L}\\p{N}_-])`, 'iu');
  return haystack.some((entry) => pattern.test(entry));
};

/**
 * Codex exposes no authoritative Skill-activation event, so activation is only ever inferred
 * from the Skill being named in the run's own reasoning, commands, or reply.
 */
export const codexSkillActivationEvidence = (
  run: CodexNormalizedRun,
  skills: readonly string[],
): EvalActivationEvidence => {
  if (!streamUsable(run)) return Object.freeze({ activated: Object.freeze([]), level: 'unavailable' });
  const haystack = [
    ...run.messages,
    ...run.reasoning,
    ...run.commands.map((entry) => entry.command),
  ];
  return Object.freeze({
    activated: Object.freeze([...new Set(skills.filter((skill) => mentions(haystack, skill)))].sort()),
    level: 'inferred',
  });
};
