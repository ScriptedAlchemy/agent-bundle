import { stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { runClaudeStreamProcess, type ClaudeProcessOptions } from './claude-process.ts';
import { normalizeClaudeStream, type ClaudeTraceEvent } from './claude-stream.ts';
import { isEvalScriptOutcome } from './graders.ts';
import type { EvalAssertion, EvalScriptOutcome } from './types.ts';

export const claudeSemanticGraderId = 'claude-semantic';
export const claudeSemanticGraderSchemaVersion = 1;

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requestFor = (options: RunClaudeSemanticGraderOptions): string => stableJson({
  assertions: options.assertions,
  response: options.response,
  task: Object.freeze({
    instruction: 'Assess whether the response and current workspace satisfy the assertions. Return exactly {"schemaVersion":1,"outcome":"pass"|"fail"|"inconclusive","detail":string}; do not use Markdown fences or add fields.',
    prompt: options.task,
  }),
  trace: options.trace,
  workspace: Object.freeze({
    evidence: 'The current working directory is the materialized trial workspace. Inspect it only when workspace evidence is needed.',
  }),
});

const provenanceFor = (model: string): string => stableJson({
  harness: 'claude',
  model,
  schemaVersion: claudeSemanticGraderSchemaVersion,
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
  if (keys.length !== 3 || keys[0] !== 'detail' || keys[1] !== 'outcome' || keys[2] !== 'schemaVersion') {
    return undefined;
  }
  if (
    parsed.schemaVersion !== claudeSemanticGraderSchemaVersion ||
    !isEvalScriptOutcome(parsed)
  ) {
    return undefined;
  }
  return Object.freeze({ detail: parsed.detail, outcome: parsed.outcome });
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
  try {
    const stream = normalizeClaudeStream(process.stdout);
    if (stream.errorKinds.length > 0 || stream.incompleteTrailingRecord !== undefined) return Object.freeze({ raw });
    const result = parseClaudeSemanticGraderResult(stream.finalResponse);
    return Object.freeze({ raw, ...(result === undefined ? {} : { result }) });
  } catch {
    return Object.freeze({ raw });
  }
};
