import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { resolveEvalAssertions } from './assertions.ts';
import { EvalHarnessError } from './errors.ts';
import { materializeEvalFixture, type EvalFixturePlan } from './fixtures.ts';
import { evalScriptGraderSpec, runEvalGraders, type EvalGraderSpec } from './graders.ts';
import type { PreparedEvalArtifact } from './artifact.ts';
import type { EvalRunWriter, EvalTrialRecord } from './run-store.ts';
import type {
  EvalActivationEvidence,
  EvalAssertionResult,
  EvalCase,
  EvalHarnessFailure,
  EvalMcpCallRecord,
  EvalPluginFailure,
  EvalTrialEvidence,
} from './types.ts';

export interface EvalHarness {
  readonly kind: 'deterministic' | 'native-claude' | 'native-codex';
  readonly name: string;
}

export interface EvalProcessProbe {
  readonly args: readonly string[];
  readonly command: string;
  /** Fixture-relative JSONL log of `{ server, tool }` records the probed process wrote. */
  readonly mcpCallLog?: string;
  readonly timeoutMs?: number;
}

export interface RunDeterministicTrialOptions {
  /** Supplied by a future host harness; the deterministic harness cannot observe activation. */
  readonly activation?: EvalActivationEvidence;
  readonly artifact: PreparedEvalArtifact;
  readonly evalCase: EvalCase;
  readonly fixturePlan: EvalFixturePlan;
  readonly graders?: readonly EvalGraderSpec[];
  readonly host: string;
  readonly now?: () => Date;
  readonly probe?: EvalProcessProbe;
  readonly suiteDir: string;
  readonly target?: string;
  readonly trialIndex: number;
  readonly workspaceRoot: string;
  readonly writer: EvalRunWriter;
}

export interface ReproduceEvalTrialAssertionsOptions {
  readonly directory: string;
  readonly evalCase: EvalCase;
  readonly trial: EvalTrialRecord;
}

interface ProbeResult {
  readonly exitCode?: number;
  readonly spawnFailure?: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const defaultProbeTimeoutMs = 60_000;
const evidenceArtifactName = 'evidence.json';
const unavailableActivation: EvalActivationEvidence = Object.freeze({
  activated: Object.freeze([]),
  level: 'unavailable',
});

const harnessError = (
  code: ConstructorParameters<typeof EvalHarnessError>[0],
  message: string,
): EvalHarnessError => new EvalHarnessError(code, message);

const harnessKinds: Readonly<Record<string, EvalHarness['kind']>> = Object.freeze({
  claude: 'native-claude',
  codex: 'native-codex',
  deterministic: 'deterministic',
});

/** An unknown host has no harness, and asking for one is an explicit error rather than a stub. */
export const createEvalHarness = (name: string): EvalHarness => {
  const kind = harnessKinds[name];
  if (kind === undefined) {
    throw harnessError(
      'EVAL_MODEL_BACKED_UNSUPPORTED',
      `Model-backed eval harness ${JSON.stringify(name)} is not supported yet; only the deterministic, native Claude, and native Codex harnesses are available.`,
    );
  }
  return Object.freeze({ kind, name });
};

const runProbe = async (probe: EvalProcessProbe, cwd: string): Promise<ProbeResult> =>
  new Promise<ProbeResult>((resolvePromise) => {
    const child = spawn(probe.command, [...probe.args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: { stderr: string[]; stdout: string[] } = { stderr: [], stdout: [] };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, probe.timeoutMs ?? defaultProbeTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => chunks.stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => chunks.stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        spawnFailure: error.message,
        stderr: chunks.stderr.join(''),
        stdout: chunks.stdout.join(''),
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        ...(code === null ? {} : { exitCode: code }),
        stderr: chunks.stderr.join(''),
        stdout: chunks.stdout.join(''),
        timedOut,
      });
    });
  });

const readMcpCallLog = async (fixturePath: string, logPath: string): Promise<readonly EvalMcpCallRecord[]> => {
  let contents: string;
  try {
    contents = await readFile(join(fixturePath, logPath), 'utf8');
  } catch {
    return Object.freeze([]);
  }
  const lines = contents.split('\n');
  lines.pop();
  return Object.freeze(lines.filter((line) => line.length > 0).flatMap((line) => {
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(line);
    } catch {
      return [];
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as EvalMcpCallRecord).server !== 'string' ||
      typeof (parsed as EvalMcpCallRecord).tool !== 'string'
    ) {
      return [];
    }
    return [Object.freeze({ server: (parsed as EvalMcpCallRecord).server, tool: (parsed as EvalMcpCallRecord).tool })];
  }));
};

const trialOutcome = (assertions: readonly EvalAssertionResult[]): EvalTrialRecord['outcome'] => {
  if (assertions.some((assertion) => assertion.outcome === 'fail')) return 'fail';
  return assertions.some((assertion) => assertion.outcome === 'inconclusive') ? 'inconclusive' : 'pass';
};

const pluginFailureFor = (
  evidence: EvalTrialEvidence,
  assertions: readonly EvalAssertionResult[],
): EvalPluginFailure | undefined => {
  if (evidence.process.timedOut) {
    return Object.freeze({
      code: 'EVAL_PLUGIN_TIMED_OUT',
      message: 'The trial process did not exit before its timeout.',
    });
  }
  if (evidence.process.exitCode !== undefined && evidence.process.exitCode !== 0) {
    return Object.freeze({
      code: 'EVAL_PLUGIN_PROCESS_FAILED',
      message: `The trial process exited with code ${evidence.process.exitCode}.`,
    });
  }
  return assertions.some((assertion) => assertion.outcome === 'fail')
    ? Object.freeze({ code: 'EVAL_PLUGIN_ASSERTION_FAILED', message: 'At least one assertion failed.' })
    : undefined;
};

/**
 * Runs one model-free trial: a fresh fixture, an optional artifact-owned process probe,
 * deterministic graders, and evidence-backed assertion resolution.
 */
export const runDeterministicTrial = async (
  options: RunDeterministicTrialOptions,
): Promise<EvalTrialRecord> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const target = options.target ?? options.host;
  const targetDigest = options.artifact.binding.targetDigests[target];
  if (targetDigest === undefined) {
    throw harnessError(
      'EVAL_ARTIFACT_TARGET_MISSING',
      `The prepared artifact has no target ${JSON.stringify(target)} for host ${JSON.stringify(options.host)}.`,
    );
  }
  const trialId = `${options.host}-${options.trialIndex + 1}`;
  const fixture = await materializeEvalFixture({
    destination: join(options.workspaceRoot, options.evalCase.id, trialId),
    plan: options.fixturePlan,
  });

  const probe = options.probe === undefined ? undefined : await runProbe(options.probe, fixture.path);
  const harnessFailure: EvalHarnessFailure | undefined = probe?.spawnFailure === undefined
    ? undefined
    : Object.freeze({
      code: 'EVAL_PROCESS_UNAVAILABLE',
      message: `The trial process could not start: ${probe.spawnFailure}`,
      stage: 'preflight',
    });

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
    fixturePath: fixture.path,
    prompt: options.evalCase.prompt,
  });

  const mcpCalls = probe === undefined || harnessFailure !== undefined || options.probe?.mcpCallLog === undefined
    ? undefined
    : await readMcpCallLog(fixture.path, options.probe.mcpCallLog);
  const evidence: EvalTrialEvidence = Object.freeze({
    mcp: Object.freeze({
      calls: mcpCalls ?? Object.freeze([]),
      level: mcpCalls === undefined ? 'unavailable' : 'observed',
    }),
    process: Object.freeze({
      ...(probe?.exitCode === undefined ? {} : { exitCode: probe.exitCode }),
      level: probe === undefined || harnessFailure !== undefined ? 'unavailable' : 'observed',
      timedOut: probe?.timedOut ?? false,
    }),
    scripts: Object.freeze({
      level: graderSpecs.length === 0 ? 'unavailable' : 'observed',
      results: graded.results,
    }),
    skillActivation: options.activation ?? unavailableActivation,
  });

  const assertions = resolveEvalAssertions(options.evalCase.assertions, evidence);
  const graderFailure: EvalHarnessFailure | undefined = graded.failures.length === 0
    ? undefined
    : Object.freeze({
      code: 'EVAL_GRADER_FAILED',
      message: `Grading is incomplete: ${graded.failures.map((failure) => `${failure.id}: ${failure.message}`).join('; ')}`,
      stage: 'grader',
    });
  const failure = harnessFailure ?? graderFailure;
  const pluginFailure = failure === undefined ? pluginFailureFor(evidence, assertions) : undefined;

  const rawArtifacts = [
    await options.writer.writeArtifactFile(`${trialId}/${evidenceArtifactName}`, `${stableJson(evidence)}\n`),
    ...(probe === undefined
      ? []
      : [
        await options.writer.writeArtifactFile(`${trialId}/stdout.log`, probe.stdout),
        await options.writer.writeArtifactFile(`${trialId}/stderr.log`, probe.stderr),
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
    fixtureDigest: fixture.digest,
    ...(failure === undefined ? {} : { harnessFailure: failure }),
    host: options.host,
    id: trialId,
    model: options.evalCase.hosts[options.host]?.model ?? 'unpinned',
    outcome: failure === undefined ? trialOutcome(assertions) : 'inconclusive',
    ...(pluginFailure === undefined ? {} : { pluginFailure }),
    prompt: options.evalCase.prompt,
    rawArtifacts: Object.freeze(rawArtifacts),
    startedAt: startedAt.toISOString(),
    targetDigest,
    trialIndex: options.trialIndex,
  });
};

/** Re-derives a trial's displayed conclusions from its persisted raw evidence artifact. */
export const reproduceEvalTrialAssertions = async (
  options: ReproduceEvalTrialAssertionsOptions,
): Promise<readonly EvalAssertionResult[]> => {
  const reference = options.trial.rawArtifacts.find((path) => path.endsWith(`/${evidenceArtifactName}`));
  if (reference === undefined) {
    throw harnessError(
      'EVAL_HARNESS_INPUT_INVALID',
      `Trial ${JSON.stringify(options.trial.id)} did not record a raw evidence artifact.`,
    );
  }
  const evidence = parseJsonWithoutDuplicateKeys(
    await readFile(join(options.directory, ...reference.split('/')), 'utf8'),
  ) as EvalTrialEvidence;
  return resolveEvalAssertions(options.evalCase.assertions, evidence);
};
