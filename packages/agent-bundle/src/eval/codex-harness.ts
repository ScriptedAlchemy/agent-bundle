import { spawn } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { redactEvalCredentialText } from './credentials.ts';
import { resolveEvalAssertions } from './assertions.ts';
import {
  codexMcpEvidence,
  codexSkillActivationEvidence,
  normalizeCodexEventStream,
  type CodexNormalizedRun,
} from './codex-events.ts';
import { CodexEvalHarnessError, codexHarnessFailure } from './codex-errors.ts';
import {
  adoptCodexAuthState,
  codexChildEnvironment,
  codexHomeUnchanged,
  codexUnauthenticatedOutput,
  codexVersionCompatible,
  createTemporaryCodexTrialHome,
  digestCodexHome,
  minimumCodexEvalVersion,
  removeTemporaryCodexTrialHome,
  resolveNormalCodexHome,
  type CodexHomeDigest,
} from './codex-home.ts';
import { codexPluginInstallPlan, codexPluginObserved, readCodexCandidatePlugin } from './codex-plugins.ts';
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
  EvalCase,
  EvalHarnessFailure,
  EvalTrialEvidence,
} from './types.ts';

export interface CodexCommandInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface CodexCommandResult {
  readonly exitCode: number;
  readonly failure?: 'cancelled' | 'output-limit' | 'timeout';
  readonly stderr: string;
  readonly stdout: string;
}

export type CodexCommandRunner = (command: CodexCommandInput) => Promise<CodexCommandResult>;

export interface RunCodexEvalTrialOptions {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly evalCase: EvalCase;
  readonly fixturePlan: EvalFixturePlan;
  readonly graders?: readonly EvalGraderSpec[];
  readonly host?: string;
  readonly normalCodexHome?: string;
  readonly now?: () => Date;
  readonly run?: CodexCommandRunner;
  readonly signal?: AbortSignal;
  readonly suiteDir: string;
  readonly target?: string;
  readonly timeoutMs?: number;
  readonly trialIndex: number;
  readonly workspaceRoot: string;
  readonly writer: EvalRunWriter;
}

export interface CodexEvalHarness {
  readonly host: 'codex';
  readonly kind: 'native-codex';
  readonly name: string;
  readonly runTrial: (options: RunCodexEvalTrialOptions) => Promise<EvalTrialRecord>;
}

interface CodexExecution {
  readonly result: CodexCommandResult;
  readonly run: CodexNormalizedRun;
  readonly skills: readonly string[];
}

const codexExecutable = 'codex';
const defaultHost = 'codex';
const defaultKillGraceMs = 1_000;
const defaultMaxOutputBytes = 4 * 1024 * 1024;
const defaultTimeoutMs = 300_000;
const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const defaultCodexRunner: CodexCommandRunner = (command) => new Promise((resolvePromise, reject) => {
  const child = spawn(codexExecutable, [...command.args], {
    cwd: command.cwd,
    env: command.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let bytes = 0;
  let failure: CodexCommandResult['failure'];
  let finished = false;
  let escalationTimer: NodeJS.Timeout | undefined;

  const settle = (exitCode: number): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    command.signal?.removeEventListener('abort', onAbort);
    resolvePromise(Object.freeze({
      exitCode,
      ...(failure === undefined ? {} : { failure }),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    }));
  };
  const terminate = (reason: NonNullable<CodexCommandResult['failure']>): void => {
    if (failure !== undefined || finished) return;
    failure = reason;
    child.kill('SIGTERM');
    escalationTimer = setTimeout(() => {
      if (!finished) child.kill('SIGKILL');
    }, defaultKillGraceMs);
  };
  const onAbort = (): void => terminate('cancelled');
  const append = (chunks: Buffer[], chunk: Buffer): void => {
    if (failure !== undefined) return;
    if (bytes + chunk.byteLength > defaultMaxOutputBytes) {
      terminate('output-limit');
      return;
    }
    bytes += chunk.byteLength;
    chunks.push(chunk);
  };
  const timeoutTimer = setTimeout(() => terminate('timeout'), command.timeoutMs);

  command.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout?.on('data', (chunk: Buffer) => append(stdoutChunks, chunk));
  child.stderr?.on('data', (chunk: Buffer) => append(stderrChunks, chunk));
  child.once('error', (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    command.signal?.removeEventListener('abort', onAbort);
    reject(error);
  });
  child.once('close', (code) => settle(code ?? 1));
});

const activationSkills = (candidateSkills: readonly string[], evalCase: EvalCase): readonly string[] =>
  Object.freeze([...new Set([
    ...candidateSkills,
    ...(evalCase.invocation.skill === undefined ? [] : [evalCase.invocation.skill]),
  ])].sort((left, right) => left.localeCompare(right)));

/**
 * Runs one Codex trial in a throwaway `CODEX_HOME`: the candidate is installed from a local
 * marketplace, verified through plugin state, and exercised with `codex exec --ephemeral --json`.
 * No provider API key is accepted, requested, or forwarded; the CLI's own session is the only auth.
 */
export const runCodexEvalTrial = async (options: RunCodexEvalTrialOptions): Promise<EvalTrialRecord> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const environment = options.environment ?? process.env;
  const host = options.host ?? defaultHost;
  const target = options.target ?? host;
  const targetDigest = options.artifact.binding.targetDigests[target];
  if (targetDigest === undefined) {
    throw new CodexEvalHarnessError(
      'CODEX_ARTIFACT_INVALID',
      `The prepared artifact has no target ${JSON.stringify(target)} for host ${JSON.stringify(host)}.`,
    );
  }
  const normalCodexHome = options.normalCodexHome ?? resolveNormalCodexHome(environment);
  const runner = options.run ?? defaultCodexRunner;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const trialId = evalTrialId(options.evalCase.id, host, options.trialIndex);

  const before: CodexHomeDigest = await digestCodexHome(normalCodexHome);
  const temporary = await createTemporaryCodexTrialHome(options.workspaceRoot);
  const childEnvironment = codexChildEnvironment(environment, temporary.home);
  const lifecycle: string[] = [];
  let execution: CodexExecution | undefined;
  let harnessFailure: EvalHarnessFailure | undefined;
  let fixtureDigest = options.fixturePlan.digest;

  const execute = async (step: string, args: readonly string[]): Promise<CodexCommandResult> => {
    let result: CodexCommandResult;
    try {
      result = await runner({
        args,
        cwd: temporary.workspace,
        environment: childEnvironment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs,
      });
    } catch (error) {
      if (options.signal?.aborted === true || isErrno(error, 'ABORT_ERR')) {
        throw new CodexEvalHarnessError('CODEX_TRIAL_CANCELLED', `The trial was cancelled during ${JSON.stringify(step)}.`);
      }
      if (isErrno(error, 'ENOENT')) {
        throw new CodexEvalHarnessError(
          'CODEX_CLI_MISSING',
          `No installed ${codexExecutable} executable could be started for step ${JSON.stringify(step)}.`,
        );
      }
      throw error;
    }
    lifecycle.push(`${step} exit=${result.exitCode}${result.failure === undefined ? '' : ` failure=${result.failure}`}`);
    if (result.failure === 'cancelled' || options.signal?.aborted === true) {
      throw new CodexEvalHarnessError('CODEX_TRIAL_CANCELLED', `The trial was cancelled during ${JSON.stringify(step)}.`);
    }
    if (result.exitCode !== 0 && codexUnauthenticatedOutput(`${result.stdout}\n${result.stderr}`)) {
      throw new CodexEvalHarnessError(
        'CODEX_CLI_UNAUTHENTICATED',
        `The installed Codex CLI reported that it is not signed in during step ${JSON.stringify(step)}.`,
      );
    }
    return result;
  };

  try {
    try {
      try {
        await cp(join(options.artifact.root, target), temporary.candidate, { recursive: true });
      } catch (error) {
        throw new CodexEvalHarnessError(
          'CODEX_ARTIFACT_INVALID',
          `The Codex candidate target ${JSON.stringify(target)} could not be copied into the temporary home: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const candidate = await readCodexCandidatePlugin(temporary.candidate);
      try {
        const fixture = await materializeEvalFixture({ destination: temporary.workspace, plan: options.fixturePlan });
        fixtureDigest = fixture.digest;
      } catch (error) {
        throw new CodexEvalHarnessError(
          'CODEX_FIXTURE_UNAVAILABLE',
          `The trial fixture could not be materialized: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const version = await execute('--version', ['--version']);
      if (version.exitCode !== 0 || !codexVersionCompatible(version.stdout)) {
        throw new CodexEvalHarnessError(
          'CODEX_CLI_INCOMPATIBLE',
          `The installed Codex CLI reported ${JSON.stringify(version.stdout.trim())}; ${minimumCodexEvalVersion} or newer is required.`,
        );
      }
      await adoptCodexAuthState(normalCodexHome, temporary.home);

      for (const step of codexPluginInstallPlan(candidate, temporary.candidate)) {
        const result = await execute(step.id, step.args);
        if (result.exitCode !== 0) {
          throw new CodexEvalHarnessError(
            'CODEX_PLUGIN_UNAVAILABLE',
            `Codex step ${JSON.stringify(step.id)} exited with code ${result.exitCode} in the temporary home.`,
          );
        }
        if (step.id === 'plugin.list' && !codexPluginObserved(result.stdout, candidate)) {
          throw new CodexEvalHarnessError(
            'CODEX_PLUGIN_UNAVAILABLE',
            `The temporary home does not report ${JSON.stringify(`${candidate.plugin}@${candidate.marketplace}`)} as installed and enabled.`,
          );
        }
      }

      const result = await execute('exec', [
        'exec',
        '--strict-config',
        '--ephemeral',
        '--json',
        '-s',
        'read-only',
        ...(options.fixturePlan.git ? [] : ['--skip-git-repo-check']),
        '-C',
        temporary.workspace,
        options.evalCase.prompt,
      ]);
      const run = normalizeCodexEventStream(result.stdout);
      if (result.failure !== 'timeout' && (run.malformedLines > 0 || run.envelopes.length === 0)) {
        throw new CodexEvalHarnessError(
          'CODEX_TRACE_INVALID',
          `The ephemeral run produced ${run.envelopes.length} readable event(s) and ${run.malformedLines} unreadable line(s).`,
        );
      }
      execution = Object.freeze({ result, run, skills: activationSkills(candidate.skills, options.evalCase) });
    } catch (error) {
      harnessFailure = codexHarnessFailure(error);
    }

    const graderSpecs: readonly EvalGraderSpec[] = harnessFailure === undefined
      ? [
        ...(options.graders ?? []),
        ...options.evalCase.assertions
          .filter((assertion) => assertion.kind === 'outcome')
          .map((assertion) => evalScriptGraderSpec(assertion.script, options.suiteDir)),
      ]
      : [];
    const graded = await runEvalGraders(graderSpecs, {
      artifactRoot: options.artifact.root,
      fixturePath: temporary.workspace,
      prompt: options.evalCase.prompt,
    });

    const evidence: EvalTrialEvidence = execution === undefined
      ? unavailableEvidence
      : Object.freeze({
        mcp: codexMcpEvidence(execution.run),
        process: Object.freeze({
          exitCode: execution.result.exitCode,
          level: 'observed' as const,
          timedOut: execution.result.failure === 'timeout',
        }),
        scripts: Object.freeze({
          level: graderSpecs.length === 0 ? 'unavailable' as const : 'observed' as const,
          results: graded.results,
        }),
        skillActivation: codexSkillActivationEvidence(execution.run, execution.skills),
      });

    const assertions = resolveEvalAssertions(options.evalCase.assertions, evidence);
    const graderFailure: EvalHarnessFailure | undefined = graded.failures.length === 0
      ? undefined
      : Object.freeze({
        code: 'EVAL_GRADER_FAILED',
        message: `Grading is incomplete: ${graded.failures.map((failure) => `${failure.id}: ${failure.message}`).join('; ')}`,
        stage: 'grader',
      });

    const rawArtifacts = [
      await options.writer.writeArtifactFile(`${trialId}/${evidenceArtifactName}`, `${stableJson(evidence)}\n`),
      await options.writer.writeArtifactFile(`${trialId}/lifecycle.log`, `${lifecycle.join('\n')}\n`),
      ...(execution === undefined
        ? []
        : [
          await options.writer.writeArtifactFile(
            `${trialId}/events.jsonl`,
            execution.run.envelopes.map((envelope) => `${stableJson(envelope)}\n`).join(''),
          ),
          await options.writer.writeArtifactFile(`${trialId}/stdout.log`, redactEvalCredentialText(execution.result.stdout)),
          await options.writer.writeArtifactFile(`${trialId}/stderr.log`, redactEvalCredentialText(execution.result.stderr)),
        ]),
    ];

    const after = await digestCodexHome(normalCodexHome);
    const isolationFailure: EvalHarnessFailure | undefined = codexHomeUnchanged(before, after)
      ? undefined
      : codexHarnessFailure(new CodexEvalHarnessError(
        'CODEX_HOME_MUTATED',
        `The trial changed the normal Codex home ${JSON.stringify(normalCodexHome)}.`,
      ));

    const failure = harnessFailure ?? isolationFailure ?? graderFailure;
    const pluginFailure = failure === undefined ? pluginFailureFor(evidence, assertions) : undefined;
    const completedAt = now();
    return await options.writer.writeTrial({
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
  } finally {
    await removeTemporaryCodexTrialHome(temporary.root);
  }
};

/** The native Codex harness; its trials are model-backed, so it never claims a deterministic kind. */
export const createCodexEvalHarness = (name: string = defaultHost): CodexEvalHarness => Object.freeze({
  host: defaultHost,
  kind: 'native-codex',
  name,
  runTrial: runCodexEvalTrial,
});
