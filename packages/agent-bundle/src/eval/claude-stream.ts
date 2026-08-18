import { EvalHarnessError } from './errors.ts';
import type { EvalActivationEvidence, EvalMcpCallRecord } from './types.ts';

export type ClaudeTraceEventKind =
  | 'assistant'
  | 'error'
  | 'hook'
  | 'init'
  | 'result'
  | 'tool-result'
  | 'unknown';

/** One redacted stream event: shape and tool names only, never message or tool payload text. */
export interface ClaudeTraceEvent {
  readonly index: number;
  readonly kind: ClaudeTraceEventKind;
  readonly skills: readonly string[];
  readonly subtype?: string;
  readonly tools: readonly string[];
  readonly type: string;
}

export interface ClaudeUsage {
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
}

export interface NormalizedClaudeStream {
  readonly activation: EvalActivationEvidence;
  readonly errorKinds: readonly string[];
  readonly finalResponse: string;
  readonly hookEvents: readonly string[];
  readonly incompleteTrailingRecord?: string;
  readonly mcpCalls: readonly EvalMcpCallRecord[];
  readonly mcpServers: readonly string[];
  readonly plugins: readonly string[];
  /** Whether the host reported a plugin list at all, which separates "none loaded" from "not reported". */
  readonly pluginsReported: boolean;
  readonly resultSubtype?: string;
  readonly trace: readonly ClaudeTraceEvent[];
  readonly usage: ClaudeUsage;
}

export interface NormalizeClaudeStreamOptions {
  /** Candidate Skill names used only to look for weaker, non-authoritative activation signals. */
  readonly skills?: readonly string[];
}

interface StreamRecords {
  readonly incompleteTrailingRecord?: string;
  readonly records: readonly Readonly<Record<string, unknown>>[];
}

const mcpToolPrefix = 'mcp__';
const skillToolName = 'Skill';

const emptyUsage: ClaudeUsage = Object.freeze({
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
});

const harnessError = (message: string): EvalHarnessError =>
  new EvalHarnessError('EVAL_HARNESS_INPUT_INVALID', message);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeLabel = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const tokenCount = (usage: unknown, key: string): number =>
  isRecord(usage) ? finiteNumber(usage[key]) ?? 0 : 0;

/**
 * A truncated final line is reported rather than thrown, mirroring the run store's
 * single-incomplete-trailing-record rule; anything earlier is an unusable trace.
 */
const parseStreamRecords = (raw: string): StreamRecords => {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const records: Readonly<Record<string, unknown>>[] = [];
  let incompleteTrailingRecord: string | undefined;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      if (index === lines.length - 1) {
        incompleteTrailingRecord = line;
        break;
      }
      throw harnessError(`Claude stream line ${index + 1} could not be parsed as JSON.`);
    }
    if (!isRecord(parsed)) throw harnessError(`Claude stream line ${index + 1} is not a JSON object.`);
    records.push(parsed);
  }
  return Object.freeze({
    ...(incompleteTrailingRecord === undefined ? {} : { incompleteTrailingRecord }),
    records: Object.freeze(records),
  });
};

const contentBlocks = (record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] => {
  const message = record.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return Object.freeze([]);
  return Object.freeze(message.content.filter(isRecord));
};

const toolUses = (record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] =>
  Object.freeze(contentBlocks(record).filter((block) => block.type === 'tool_use' && isSafeLabel(block.name)));

const assistantText = (record: Readonly<Record<string, unknown>>): string =>
  contentBlocks(record)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');

const namesFromRecords = (value: unknown): readonly string[] => !Array.isArray(value)
  ? Object.freeze([])
  : Object.freeze(value.flatMap((entry) => isRecord(entry) && isSafeLabel(entry.name) ? [entry.name] : []));

const mcpCallFor = (name: string): EvalMcpCallRecord | undefined => {
  const segments = name.slice(mcpToolPrefix.length).split('__');
  const server = segments[0];
  if (segments.length < 2 || server === undefined || server.length === 0) return undefined;
  const tool = segments.slice(1).join('__');
  return tool.length === 0 ? undefined : Object.freeze({ server, tool });
};

/** Authoritative Skill events name `plugin:skill`; both the qualified id and the bare name are recorded. */
const activatedNamesFor = (identifier: string): readonly string[] => {
  const separator = identifier.lastIndexOf(':');
  return separator <= 0 || separator === identifier.length - 1
    ? Object.freeze([identifier])
    : Object.freeze([identifier, identifier.slice(separator + 1)]);
};

const traceKindFor = (record: Readonly<Record<string, unknown>>, hook: boolean): ClaudeTraceEventKind => {
  if (hook) return 'hook';
  if (record.type === 'error' || record.subtype === 'error') return 'error';
  if (record.type === 'result') return 'result';
  if (record.type === 'assistant') return 'assistant';
  if (record.type === 'user') return 'tool-result';
  if (record.type === 'system' && record.subtype === 'init') return 'init';
  return 'unknown';
};

const isHookRecord = (record: Readonly<Record<string, unknown>>): boolean =>
  record.hook_event_name !== undefined
  || record.hook_event !== undefined
  || (typeof record.subtype === 'string' && record.subtype.startsWith('hook_'));

const usageFor = (
  result: Readonly<Record<string, unknown>> | undefined,
  assistantUsage: ClaudeUsage,
): ClaudeUsage => {
  if (result === undefined) return assistantUsage;
  const costUsd = finiteNumber(result.total_cost_usd);
  const durationMs = finiteNumber(result.duration_ms);
  const usage = result.usage;
  const reported = isRecord(usage);
  return Object.freeze({
    cacheCreationInputTokens: reported
      ? tokenCount(usage, 'cache_creation_input_tokens')
      : assistantUsage.cacheCreationInputTokens,
    cacheReadInputTokens: reported
      ? tokenCount(usage, 'cache_read_input_tokens')
      : assistantUsage.cacheReadInputTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(durationMs === undefined ? {} : { durationMs }),
    inputTokens: reported ? tokenCount(usage, 'input_tokens') : assistantUsage.inputTokens,
    outputTokens: reported ? tokenCount(usage, 'output_tokens') : assistantUsage.outputTokens,
    turns: finiteNumber(result.num_turns) ?? assistantUsage.turns,
  });
};

/**
 * Turns raw Claude stream JSON into the eval trace and evidence model. Authoritative Skill
 * tool events are the only `observed` activation; a weaker signal stays `inferred` and is
 * never promoted, and an incomplete trace can only ever report `inferred`.
 */
export const normalizeClaudeStream = (
  raw: string,
  options: NormalizeClaudeStreamOptions = {},
): NormalizedClaudeStream => {
  const parsed = parseStreamRecords(raw);
  const candidateSkills = Object.freeze((options.skills ?? []).map((skill) => skill.toLocaleLowerCase('en-US')));
  const authoritative = new Set<string>();
  const inferred = new Set<string>();
  const errorKinds: string[] = [];
  const hookEvents: string[] = [];
  const mcpCalls: EvalMcpCallRecord[] = [];
  const mcpServers = new Set<string>();
  const plugins = new Set<string>();
  const trace: ClaudeTraceEvent[] = [];
  let assistantUsage = emptyUsage;
  let finalResponse = '';
  let lastAssistantText = '';
  let pluginsReported = false;
  let result: Readonly<Record<string, unknown>> | undefined;

  for (const [index, record] of parsed.records.entries()) {
    const hook = isHookRecord(record);
    const kind = traceKindFor(record, hook);
    const uses = toolUses(record);
    const tools: string[] = [];
    const skills: string[] = [];
    for (const use of uses) {
      const name = String(use.name);
      tools.push(name);
      if (name === skillToolName && isRecord(use.input) && typeof use.input.skill === 'string') {
        skills.push(use.input.skill);
        for (const activated of activatedNamesFor(use.input.skill)) authoritative.add(activated);
        continue;
      }
      if (name.startsWith(mcpToolPrefix)) {
        const call = mcpCallFor(name);
        if (call !== undefined) mcpCalls.push(call);
        continue;
      }
      const reference = JSON.stringify(use.input ?? '').toLocaleLowerCase('en-US');
      for (const [position, skill] of candidateSkills.entries()) {
        if (reference.includes(`skills/${skill}`)) inferred.add((options.skills ?? [])[position] ?? skill);
      }
    }
    const text = assistantText(record);
    if (text.length > 0) {
      lastAssistantText = text;
      const haystack = text.toLocaleLowerCase('en-US');
      for (const [position, skill] of candidateSkills.entries()) {
        if (haystack.includes(skill)) inferred.add((options.skills ?? [])[position] ?? skill);
      }
    }
    if (Array.isArray(record.plugins)) pluginsReported = true;
    for (const plugin of namesFromRecords(record.plugins)) plugins.add(plugin);
    for (const server of namesFromRecords(record.mcp_servers)) mcpServers.add(server);
    if (hook && isSafeLabel(record.hook_event_name)) hookEvents.push(record.hook_event_name);
    if (kind === 'error') errorKinds.push(isSafeLabel(record.subtype) ? record.subtype : 'error');
    if (kind === 'result') {
      result = record;
      if (record.is_error === true) {
        errorKinds.push(isSafeLabel(record.subtype) ? `result:${record.subtype}` : 'result:error');
      }
      if (typeof record.result === 'string') finalResponse = record.result;
    }
    trace.push(Object.freeze({
      index,
      kind,
      skills: Object.freeze(skills),
      ...(isSafeLabel(record.subtype) ? { subtype: record.subtype } : {}),
      tools: Object.freeze(tools),
      type: typeof record.type === 'string' ? record.type : 'unknown',
    }));
    const usage = isRecord(record.message) ? record.message.usage : undefined;
    if (kind === 'assistant' && isRecord(usage)) {
      assistantUsage = Object.freeze({
        cacheCreationInputTokens: assistantUsage.cacheCreationInputTokens + tokenCount(usage, 'cache_creation_input_tokens'),
        cacheReadInputTokens: assistantUsage.cacheReadInputTokens + tokenCount(usage, 'cache_read_input_tokens'),
        inputTokens: assistantUsage.inputTokens + tokenCount(usage, 'input_tokens'),
        outputTokens: assistantUsage.outputTokens + tokenCount(usage, 'output_tokens'),
        turns: assistantUsage.turns,
      });
    }
  }

  const complete = result !== undefined && parsed.incompleteTrailingRecord === undefined;
  const level: EvalActivationEvidence['level'] = parsed.records.length === 0
    ? 'unavailable'
    : authoritative.size > 0
      ? 'observed'
      : inferred.size > 0 || !complete
        ? 'inferred'
        : 'observed';
  const activated = authoritative.size > 0 ? [...authoritative] : inferred.size > 0 ? [...inferred] : [];

  return Object.freeze({
    activation: Object.freeze({ activated: Object.freeze(activated.sort()), level }),
    errorKinds: Object.freeze(errorKinds),
    finalResponse: finalResponse.length > 0 ? finalResponse : lastAssistantText,
    hookEvents: Object.freeze(hookEvents),
    ...(parsed.incompleteTrailingRecord === undefined
      ? {}
      : { incompleteTrailingRecord: parsed.incompleteTrailingRecord }),
    mcpCalls: Object.freeze(mcpCalls),
    mcpServers: Object.freeze([...mcpServers].sort()),
    plugins: Object.freeze([...plugins].sort()),
    pluginsReported,
    ...(result === undefined || !isSafeLabel(result.subtype) ? {} : { resultSubtype: result.subtype }),
    trace: Object.freeze(trace),
    usage: usageFor(result, assistantUsage),
  });
};
