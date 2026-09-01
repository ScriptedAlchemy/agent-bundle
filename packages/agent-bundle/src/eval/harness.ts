import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { resolveEvalAssertions } from './assertions.ts';
import { redactEvalCredentialText, withoutEvalCredentialEnvironment } from './credentials.ts';
import { harnessError } from './errors.ts';
import { materializeEvalFixture, type EvalFixturePlan } from './fixtures.ts';
import { graderFailureFor, outcomeGraderSpecs, runEvalGraders, type EvalGraderSpec } from './graders.ts';
import type { EvalHarnessName } from './harness-names.ts';
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
import { deepFreeze } from '../core/freeze.ts';


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

interface McpCallLogResult {
  readonly calls: readonly EvalMcpCallRecord[];
  readonly level: 'observed' | 'unavailable';
}

const defaultProbeTimeoutMs = 60_000;
export const evidenceArtifactName = 'evidence.json';
/** The deterministic harness is server-owned, so its artifact producer version is its truthful identity. */
const deterministicHarnessIdentity = (agentBundleVersion: string): string => `agent-bundle@${agentBundleVersion}`;
const unavailableActivation: EvalActivationEvidence = Object.freeze({
  activated: Object.freeze([]),
  level: 'unavailable',
});

/** Every channel unavailable: the shape a harness reports when it observed nothing at all. */
export const unavailableEvidence: EvalTrialEvidence = deepFreeze({
  mcp: { calls: Object.freeze([]), level: 'unavailable' },
  process: { level: 'unavailable', timedOut: false },
  scripts: { level: 'unavailable', results: Object.freeze({}) },
  skillActivation: { activated: Object.freeze([]), level: 'unavailable' },
});

const harnessKinds: Readonly<Record<string, EvalHarness['kind']>> = Object.freeze({
  claude: 'native-claude',
  codex: 'native-codex',
  deterministic: 'deterministic',
} satisfies Record<EvalHarnessName, EvalHarness['kind']>);

/** Case-qualified trial ids keep records and raw evidence unique across one multi-case run. */
export const evalTrialId = (caseId: string, host: string, trialIndex: number): string =>
  `${caseId}--${host}-${trialIndex + 1}`;

/** An unknown harness is rejected explicitly rather than falling back to a stub. */
export const createEvalHarness = (name: string): EvalHarness => {
  const kind = harnessKinds[name];
  if (kind === undefined) {
    throw harnessError(
      'EVAL_MODEL_BACKED_UNSUPPORTED',
      `Unknown or unsupported eval harness ${JSON.stringify(name)}. Available harnesses are deterministic, claude, and codex.`,
    );
  }
  return Object.freeze({ kind, name });
};

const runProbe = async (probe: EvalProcessProbe, cwd: string): Promise<ProbeResult> =>
  new Promise<ProbeResult>((resolvePromise) => {
    const child = spawn(probe.command, [...probe.args], {
      cwd,
      env: withoutEvalCredentialEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const readMcpCallLog = async (fixturePath: string, logPath: string): Promise<McpCallLogResult> => {
  let contents: string;
  try {
    contents = await readFile(join(fixturePath, logPath), 'utf8');
  } catch {
    return Object.freeze({ calls: Object.freeze([]), level: 'unavailable' });
  }
  const lines = contents.length === 0 ? [] : contents.endsWith('\n') ? contents.slice(0, -1).split('\n') : undefined;
  if (lines === undefined || lines.some((line) => line.length === 0)) {
    return Object.freeze({ calls: Object.freeze([]), level: 'unavailable' });
  }
  const calls: EvalMcpCallRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(line);
    } catch {
      return Object.freeze({ calls: Object.freeze([]), level: 'unavailable' });
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.hasOwn(parsed, 'server') ||
      !Object.hasOwn(parsed, 'tool') ||
      typeof (parsed as EvalMcpCallRecord).server !== 'string' ||
      typeof (parsed as EvalMcpCallRecord).tool !== 'string'
    ) {
      return Object.freeze({ calls: Object.freeze([]), level: 'unavailable' });
    }
    calls.push(Object.freeze({ server: (parsed as EvalMcpCallRecord).server, tool: (parsed as EvalMcpCallRecord).tool }));
  }
  return Object.freeze({ calls: Object.freeze(calls), level: 'observed' });
};

export const trialOutcome = (assertions: readonly EvalAssertionResult[]): EvalTrialRecord['outcome'] => {
  if (assertions.some((assertion) => assertion.outcome === 'fail')) return 'fail';
  return assertions.some((assertion) => assertion.outcome === 'inconclusive') ? 'inconclusive' : 'pass';
};

export const pluginFailureFor = (
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
  const trialId = evalTrialId(options.evalCase.id, options.host, options.trialIndex);
  const fixture = await materializeEvalFixture({
    destination: join(options.workspaceRoot, trialId),
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
    ? [...(options.graders ?? []), ...outcomeGraderSpecs(options.evalCase.assertions, options.suiteDir)]
    : [];
  const graded = await runEvalGraders(graderSpecs, {
    artifactRoot: options.artifact.root,
    fixturePath: fixture.path,
    prompt: options.evalCase.prompt,
  });

  const mcpLog = probe === undefined || harnessFailure !== undefined || options.probe?.mcpCallLog === undefined
    ? undefined
    : await readMcpCallLog(fixture.path, options.probe.mcpCallLog);
  const evidence: EvalTrialEvidence = Object.freeze({
    mcp: Object.freeze({
      calls: mcpLog?.calls ?? Object.freeze([]),
      level: mcpLog?.level ?? 'unavailable',
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
  const graderFailure = graderFailureFor(graded.failures);
  const failure = harnessFailure ?? graderFailure;
  const pluginFailure = failure === undefined ? pluginFailureFor(evidence, assertions) : undefined;

  const rawArtifacts = [
    await options.writer.writeArtifactFile(`${trialId}/${evidenceArtifactName}`, `${stableJson(evidence)}\n`),
    ...(probe === undefined
      ? []
      : [
        await options.writer.writeArtifactFile(`${trialId}/stdout.log`, redactEvalCredentialText(probe.stdout)),
        await options.writer.writeArtifactFile(`${trialId}/stderr.log`, redactEvalCredentialText(probe.stderr)),
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
    provenance: Object.freeze({
      hostCliVersion: deterministicHarnessIdentity(options.artifact.manifest.producer.version),
      invocation: Object.freeze({ ...options.evalCase.invocation }),
      semanticGrader: null,
    }),
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
