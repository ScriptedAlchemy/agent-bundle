import { stableJson } from '../core/digest.ts';
import { isRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { runClaudeStreamProcess, type ClaudeProcessOptions } from './claude-process.ts';
import { normalizeClaudeStream, type ClaudeTraceEvent } from './claude-stream.ts';
import { claudeSemanticGraderContractRevision, isEvalScriptOutcome } from './graders.ts';
import type { EvalAssertion, EvalScriptOutcome } from './types.ts';

export { claudeSemanticGraderContractRevision, claudeSemanticGraderId } from './graders.ts';

export interface RunClaudeSemanticGraderOptions extends ClaudeProcessOptions {
  readonly assertions: readonly EvalAssertion[];
  readonly environment: NodeJS.ProcessEnv;
  readonly model: string;
  readonly response: string;
  readonly task: string;
  readonly trace: readonly ClaudeTraceEvent[];
  readonly workspacePath: string;
}

export interface ClaudeSemanticGraderRawOutput {
  readonly provenance: string;
  readonly request: string;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ClaudeSemanticGraderRun {
  readonly raw: ClaudeSemanticGraderRawOutput;
  readonly result?: EvalScriptOutcome;
}

/** The semantic response has one strict terminal stream-json result envelope, never an assistant-text fallback. */
const terminalSemanticResult = (raw: string): string | undefined => {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  let terminal: string | undefined;
  for (const [index, line] of lines.entries()) {
    let record: unknown;
    try {
      record = parseJsonWithoutDuplicateKeys(line);
    } catch {
      return undefined;
    }
    if (!isRecord(record)) return undefined;
    if (record.type !== 'result') continue;
    if (
      index !== lines.length - 1 ||
      terminal !== undefined ||
      record.subtype !== 'success' ||
      record.is_error === true ||
      typeof record.result !== 'string'
    ) {
      return undefined;
    }
    terminal = record.result;
  }
  return terminal;
};

const requestFor = (options: RunClaudeSemanticGraderOptions): string => stableJson({
  assertions: options.assertions,
  response: options.response,
  task: Object.freeze({
    instruction: 'Assess whether the response and current workspace satisfy the assertions. Return exactly {"outcome":"pass"|"fail"|"inconclusive","detail":string}; do not use Markdown fences or add fields.',
    prompt: options.task,
  }),
  trace: options.trace,
  workspace: Object.freeze({
    evidence: 'The current working directory is the materialized trial workspace. Inspect it only when workspace evidence is needed.',
  }),
});

const provenanceFor = (model: string): string => stableJson({
  contractRevision: claudeSemanticGraderContractRevision,
  harness: 'claude',
  model,
});

/** Strictly accepts the one schema the server asks the configured Claude grader to return. */
export const parseClaudeSemanticGraderResult = (value: string): EvalScriptOutcome | undefined => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed).sort((left, right) => left.localeCompare(right));
  if (keys.length !== 2 || keys[0] !== 'detail' || keys[1] !== 'outcome') {
    return undefined;
  }
  if (!isEvalScriptOutcome(parsed)) {
    return undefined;
  }
  return Object.freeze({ detail: parsed.detail, outcome: parsed.outcome });
};

/** Parses only a complete stream with exactly one successful terminal result envelope. */
export const parseClaudeSemanticGraderStream = (raw: string): EvalScriptOutcome | undefined => {
  const terminal = terminalSemanticResult(raw);
  if (terminal === undefined) return undefined;
  try {
    const stream = normalizeClaudeStream(raw);
    if (stream.errorKinds.length > 0 || stream.incompleteTrailingRecord !== undefined) return undefined;
  } catch {
    return undefined;
  }
  return parseClaudeSemanticGraderResult(terminal);
};

/**
 * Uses the already-preflighted Claude CLI as a model grader. The command and request are
 * server-owned: it receives no plugin directory, hook flags, authored command, or provider credentials.
 */
export const runClaudeSemanticGrader = async (
  options: RunClaudeSemanticGraderOptions,
): Promise<ClaudeSemanticGraderRun> => {
  const request = requestFor(options);
  const provenance = provenanceFor(options.model);
  const process = await runClaudeStreamProcess(Object.freeze({
    args: Object.freeze([
      '-p',
      '--model',
      options.model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      request,
    ]),
    cwd: options.workspacePath,
    environment: options.environment,
    executable: 'claude',
  }), options);
  const raw = Object.freeze({ provenance, request, stderr: process.stderr, stdout: process.stdout });
  if (process.failure !== undefined || process.exitCode !== 0 || process.termination !== undefined) {
    return Object.freeze({ raw });
  }
  const result = parseClaudeSemanticGraderStream(process.stdout);
  return Object.freeze({ raw, ...(result === undefined ? {} : { result }) });
};
