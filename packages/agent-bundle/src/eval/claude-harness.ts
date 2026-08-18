import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import {
  createNativeClaudeChildEnvironment,
  createNativeClaudeCommand,
} from '../host-contracts/native-claude-contract.ts';
import { resolveEvalAssertions } from './assertions.ts';
import { redactEvalCredentialText, withoutEvalCredentialEnvironment } from './credentials.ts';
import { normalizeClaudeStream, type ClaudeTraceEvent, type NormalizedClaudeStream } from './claude-stream.ts';
import { runClaudePreflight, type ClaudePreflight } from './claude-preflight.ts';
import { runClaudeStreamProcess, type ClaudeProcessOptions, type ClaudeProcessOutcome } from './claude-process.ts';
import { EvalHarnessError } from './errors.ts';
import { materializeEvalFixture, type EvalFixturePlan } from './fixtures.ts';
import {
  evalTrialId,
  evidenceArtifactName,
  pluginFailureFor,
  trialOutcome,
  unavailableEvidence,
} from './harness.ts';
import { evalScriptGraderSpec, runEvalGraders, type EvalGraderSpec } from './graders.ts';
import type { PreparedEvalArtifact } from './artifact.ts';
import type { EvalRunWriter, EvalTrialRecord } from './run-store.ts';
import type {
  EvalAssertion,
  EvalCase,
  EvalHarnessFailure,
  EvalScriptOutcome,
} from './types.ts';

/** The grader sees the task, its assertions, the response, the trace, and the workspace: never a condition label. */
export interface EvalSemanticGraderContext {
  readonly assertions: readonly EvalAssertion[];
  readonly finalResponse: string;
  readonly prompt: string;
  readonly trace: readonly ClaudeTraceEvent[];
  readonly workspacePath: string;
}

export type EvalSemanticGrader = (
  context: EvalSemanticGraderContext,
) => EvalScriptOutcome | Promise<EvalScriptOutcome>;

export interface EvalSemanticGraderSpec {
  readonly grade: EvalSemanticGrader;
  readonly id: string;
}

export interface RunClaudeTrialOptions extends ClaudeProcessOptions {
  readonly artifact: PreparedEvalArtifact;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly evalCase: EvalCase;
  readonly fixturePlan: EvalFixturePlan;
  readonly graders?: readonly EvalGraderSpec[];
  readonly host?: string;
  readonly now?: () => Date;
  readonly semanticGrader?: EvalSemanticGraderSpec;
  readonly suiteDir: string;
  readonly target?: string;
  readonly trialIndex: number;
  readonly workspaceRoot: string;
  readonly writer: EvalRunWriter;
}

interface TrialGrading {
  readonly failures: readonly string[];
  readonly results: Readonly<Record<string, EvalScriptOutcome>>;
}

const claudeHost = 'claude';
const scriptOutcomes = Object.freeze(['fail', 'inconclusive', 'pass']);
const pluginManifestSegments = Object.freeze(['.claude-plugin', 'plugin.json']);
const harnessError = (
  code: ConstructorParameters<typeof EvalHarnessError>[0],
  message: string,
): EvalHarnessError => new EvalHarnessError(code, message);

const harnessFailure = (
  code: EvalHarnessFailure['code'],
  stage: EvalHarnessFailure['stage'],
  message: string,
): EvalHarnessFailure => Object.freeze({ code, message, stage });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScriptOutcome = (value: unknown): value is EvalScriptOutcome =>
  isRecord(value)
  && typeof value.detail === 'string'
  && typeof value.outcome === 'string'
  && scriptOutcomes.includes(value.outcome);

/** The candidate Skill names a case talks about, used only for weaker-signal detection. */
const candidateSkills = (evalCase: EvalCase): readonly string[] => {
  const names = new Set<string>();
  if (evalCase.invocation.skill !== undefined) names.add(evalCase.invocation.skill);
  for (const assertion of evalCase.assertions) {
    if (assertion.kind === 'skill-activation') names.add(assertion.skill);
    if (assertion.kind === 'no-skill-activation' && assertion.skill !== undefined) names.add(assertion.skill);
  }
  return Object.freeze([...names].sort());
};

const readPluginName = async (pluginDirectory: string): Promise<string | undefined> => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(await readFile(join(pluginDirectory, ...pluginManifestSegments), 'utf8'));
  } catch {
    return undefined;
  }
  return isRecord(parsed) && typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
};

const gradeTrial = async (
  options: RunClaudeTrialOptions,
  fixturePath: string,
  stream: NormalizedClaudeStream,
): Promise<TrialGrading> => {
  const semanticId = options.semanticGrader?.id;
  const specs: readonly EvalGraderSpec[] = Object.freeze([
    ...(options.graders ?? []),
    ...options.evalCase.assertions.flatMap((assertion) =>
      assertion.kind === 'outcome' && assertion.script !== semanticId
        ? [evalScriptGraderSpec(assertion.script, options.suiteDir)]
        : []),
  ]);
  const graded = await runEvalGraders(specs, {
    artifactRoot: options.artifact.root,
    fixturePath,
    prompt: options.evalCase.prompt,
  });
  const failures = graded.failures.map((failure) => `${failure.id}: ${failure.message}`);
  if (options.semanticGrader === undefined) {
    return Object.freeze({ failures: Object.freeze(failures), results: graded.results });
  }
  try {
    const outcome = await options.semanticGrader.grade(Object.freeze({
      assertions: options.evalCase.assertions,
      finalResponse: stream.finalResponse,
      prompt: options.evalCase.prompt,
      trace: stream.trace,
      workspacePath: fixturePath,
    }));
    if (!isScriptOutcome(outcome)) throw new TypeError('The semantic grader must return { detail, outcome }.');
    return Object.freeze({
      failures: Object.freeze(failures),
      results: Object.freeze({
        ...graded.results,
        [options.semanticGrader.id]: Object.freeze({ detail: outcome.detail, outcome: outcome.outcome }),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      failures: Object.freeze([...failures, `${options.semanticGrader.id}: ${message}`]),
      results: Object.freeze({
        ...graded.results,
        [options.semanticGrader.id]: Object.freeze({
          detail: `The grader failed: ${message}`,
          outcome: 'inconclusive',
        }),
      }),
    });
  }
};

const traceFailureFor = (
  outcome: ClaudeProcessOutcome,
  stream: NormalizedClaudeStream | undefined,
): EvalHarnessFailure | undefined => {
  if (outcome.termination === 'aborted') {
    return harnessFailure('EVAL_TRACE_UNAVAILABLE', 'trace', 'The trial was cancelled before Claude produced a complete trace.');
  }
  if (outcome.termination === 'output-limit') {
    return harnessFailure('EVAL_TRACE_UNAVAILABLE', 'trace', 'Claude produced more output than the trial retains, so its trace is incomplete.');
  }
  if (stream === undefined) {
    return harnessFailure('EVAL_TRACE_UNAVAILABLE', 'trace', 'Claude did not return a readable stream-JSON trace.');
  }
  return stream.trace.length === 0
    ? harnessFailure('EVAL_TRACE_UNAVAILABLE', 'trace', 'Claude returned no stream-JSON events.')
    : undefined;
};

/**
 * Runs one model-backed trial through the installed, signed-in Claude Code CLI with an
 * explicit generated plugin directory. No provider API key is ever accepted or injected,
 * and `--bare` is never passed, so the CLI can only use its existing session state.
 */
export const runClaudeTrial = async (options: RunClaudeTrialOptions): Promise<EvalTrialRecord> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const host = options.host ?? claudeHost;
  const target = options.target ?? claudeHost;
  const targetDigest = options.artifact.binding.targetDigests[target];
  if (targetDigest === undefined) {
    throw harnessError(
      'EVAL_ARTIFACT_TARGET_MISSING',
      `The prepared artifact has no target ${JSON.stringify(target)} for host ${JSON.stringify(host)}.`,
    );
  }
  const trialId = evalTrialId(options.evalCase.id, host, options.trialIndex);
  const environment = createNativeClaudeChildEnvironment(
    withoutEvalCredentialEnvironment(options.environment ?? process.env),
  );
  const pluginDirectory = join(options.artifact.root, target);
  const processOptions: ClaudeProcessOptions = Object.freeze({
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const preflight: ClaudePreflight = await runClaudePreflight({
    ...processOptions,
    cwd: options.artifact.root,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

  let evidence = unavailableEvidence;
  let failure = preflight.failure;
  let outcome: ClaudeProcessOutcome | undefined;
  let stream: NormalizedClaudeStream | undefined;
  let workspacePath: string | undefined;
  let fixtureDigest = options.fixturePlan.digest;

  if (failure === undefined) {
    const pluginName = await readPluginName(pluginDirectory);
    if (pluginName === undefined) {
      failure = harnessFailure(
        'EVAL_ARTIFACT_UNAVAILABLE',
        'artifact',
        'The generated Claude candidate has no readable manifest.',
      );
    } else {
      try {
        const fixture = await materializeEvalFixture({
          destination: join(options.workspaceRoot, trialId),
          plan: options.fixturePlan,
        });
        workspacePath = fixture.path;
        fixtureDigest = fixture.digest;
      } catch {
        failure = harnessFailure(
          'EVAL_FIXTURE_UNAVAILABLE',
          'fixture',
          'The trial fixture could not be materialized.',
        );
      }
      if (failure === undefined && workspacePath !== undefined) {
        const command = createNativeClaudeCommand({
          model: options.evalCase.hosts[host]?.model ?? 'unpinned',
          pluginDirectory,
          prompt: options.evalCase.prompt,
        });
        if (command.args.includes('--bare')) {
          throw harnessError(
            'EVAL_HARNESS_INPUT_INVALID',
            'The Claude eval command must never pass --bare, which bypasses saved subscription authentication.',
          );
        }
        outcome = await runClaudeStreamProcess(
          Object.freeze({ ...command, cwd: workspacePath, environment }),
          processOptions,
        );
        if (outcome.failure === undefined) {
          try {
            stream = normalizeClaudeStream(outcome.stdout, { skills: candidateSkills(options.evalCase) });
          } catch {
            stream = undefined;
          }
        }
        failure = outcome.failure ?? traceFailureFor(outcome, stream);
        if (failure === undefined && stream?.pluginsReported === true && !stream.plugins.includes(pluginName)) {
          failure = harnessFailure(
            'EVAL_ARTIFACT_UNAVAILABLE',
            'artifact',
            'Claude did not load the generated candidate.',
          );
        }
      }
    }
  }

  if (failure === undefined && outcome !== undefined && stream !== undefined && workspacePath !== undefined) {
    const graded = await gradeTrial(options, workspacePath, stream);
    evidence = Object.freeze({
      mcp: Object.freeze({ calls: stream.mcpCalls, level: 'observed' }),
      process: Object.freeze({
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        level: 'observed',
        timedOut: outcome.termination === 'timed-out',
      }),
      scripts: Object.freeze({
        level: Object.keys(graded.results).length === 0 ? 'unavailable' : 'observed',
        results: graded.results,
      }),
      skillActivation: stream.activation,
    });
    if (graded.failures.length > 0) {
      failure = harnessFailure(
        'EVAL_GRADER_FAILED',
        'grader',
        `Grading is incomplete: ${graded.failures.join('; ')}`,
      );
    }
  }

  const assertions = resolveEvalAssertions(options.evalCase.assertions, evidence);
  const pluginFailure = failure === undefined ? pluginFailureFor(evidence, assertions) : undefined;
  const rawArtifacts = [
    await options.writer.writeArtifactFile(`${trialId}/${evidenceArtifactName}`, `${stableJson(evidence)}\n`),
    ...(outcome === undefined
      ? []
      : [
        await options.writer.writeArtifactFile(`${trialId}/stream.jsonl`, redactEvalCredentialText(outcome.stdout)),
        await options.writer.writeArtifactFile(`${trialId}/stderr.log`, redactEvalCredentialText(outcome.stderr)),
      ]),
    ...(stream === undefined
      ? []
      : [
        await options.writer.writeArtifactFile(`${trialId}/trace.json`, `${stableJson(stream.trace)}\n`),
        await options.writer.writeArtifactFile(`${trialId}/usage.json`, `${stableJson(stream.usage)}\n`),
      ]),
  ];

  const completedAt = now();
  return options.writer.writeTrial({
    assertions,
    caseDigest: options.evalCase.digest,
    caseId: options.evalCase.id,
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    evidence,
    fixtureDigest,
    ...(failure === undefined ? {} : { harnessFailure: failure }),
    host,
    id: trialId,
    model: options.evalCase.hosts[host]?.model ?? 'unpinned',
    outcome: failure === undefined ? trialOutcome(assertions) : 'inconclusive',
    ...(pluginFailure === undefined ? {} : { pluginFailure }),
    prompt: options.evalCase.prompt,
    rawArtifacts: Object.freeze(rawArtifacts),
    startedAt: startedAt.toISOString(),
    targetDigest,
    trialIndex: options.trialIndex,
  });
};
