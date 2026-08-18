import { createNativeClaudeChildEnvironment } from '../host-contracts/native-claude-contract.ts';
import { withoutEvalCredentialEnvironment } from './credentials.ts';
import {
  claudeProcessFailure,
  minimumClaudeEvalVersion,
  runClaudeStreamProcess,
  type ClaudeProcessOptions,
} from './claude-process.ts';
import type { EvalHarnessFailure } from './types.ts';

export type ClaudePreflightStatus =
  | 'incompatible'
  | 'missing'
  | 'ready'
  | 'unauthenticated'
  | 'unavailable';

export interface ClaudePreflight {
  readonly failure?: EvalHarnessFailure;
  readonly status: ClaudePreflightStatus;
  readonly version?: string;
}

export interface RunClaudePreflightOptions extends ClaudeProcessOptions {
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

const claudeExecutable = 'claude';

const minimumVersion: ClaudeVersion = Object.freeze({
  major: 2,
  minor: 1,
  patch: 232,
  prerelease: false,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseClaudeVersion = (output: string): ClaudeVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|[^0-9A-Za-z.-])/u.exec(output);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  });
};

/** Anything below the checked-in modern baseline is rejected; there is no compatibility branch. */
const isCompatible = (version: ClaudeVersion): boolean => {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (version[field] !== minimumVersion[field]) return version[field] > minimumVersion[field];
  }
  return !version.prerelease;
};

const isSubscriptionSession = (output: string): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value) || value.loggedIn !== true) return false;
  const apiProvider = typeof value.apiProvider === 'string' ? value.apiProvider.toLowerCase() : '';
  const authMethod = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : '';
  const subscriptionType = typeof value.subscriptionType === 'string' ? value.subscriptionType.toLowerCase() : '';
  if (/(?:api[ _-]?key|bedrock|vertex|foundry)/iu.test(`${authMethod}\n${apiProvider}`)) return false;
  if (!(authMethod === 'claude.ai' || authMethod === 'oauth' || authMethod.includes('session'))) return false;
  return subscriptionType.length > 0 && subscriptionType !== 'none';
};

const failed = (status: ClaudePreflightStatus, message: string, version?: string): ClaudePreflight => Object.freeze({
  failure: claudeProcessFailure(message),
  status,
  ...(version === undefined ? {} : { version }),
});

/**
 * Establishes that an installed, modern, signed-in CLI exists before any trial work happens.
 * Every negative answer is harness evidence: the plugin under test has not been exercised.
 */
export const runClaudePreflight = async (options: RunClaudePreflightOptions): Promise<ClaudePreflight> => {
  const environment = createNativeClaudeChildEnvironment(
    withoutEvalCredentialEnvironment(options.environment ?? process.env),
  );
  const processOptions: ClaudeProcessOptions = Object.freeze({
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const versionOutcome = await runClaudeStreamProcess(
    Object.freeze({ args: Object.freeze(['--version']), cwd: options.cwd, environment, executable: claudeExecutable }),
    processOptions,
  );
  if (versionOutcome.failure !== undefined) {
    return Object.freeze({ failure: versionOutcome.failure, status: 'missing' });
  }
  if (versionOutcome.exitCode !== 0) {
    return failed('unavailable', 'The Claude CLI did not report a version; inspect the local CLI without retaining its output.');
  }
  const version = parseClaudeVersion(versionOutcome.stdout);
  if (version === undefined) {
    return failed(
      'incompatible',
      `The Claude CLI did not report a semantic version for the ${minimumClaudeEvalVersion} eval contract.`,
    );
  }
  const formatted = `${version.major}.${version.minor}.${version.patch}`;
  if (!isCompatible(version)) {
    return failed(
      'incompatible',
      `Claude Code ${formatted} is older than the required ${minimumClaudeEvalVersion} eval contract; upgrade the CLI.`,
      formatted,
    );
  }

  const authOutcome = await runClaudeStreamProcess(
    Object.freeze({
      args: Object.freeze(['auth', 'status', '--json']),
      cwd: options.cwd,
      environment,
      executable: claudeExecutable,
    }),
    processOptions,
  );
  if (authOutcome.failure !== undefined) {
    return Object.freeze({ failure: authOutcome.failure, status: 'missing', version: formatted });
  }
  if (authOutcome.exitCode !== 0 || !isSubscriptionSession(authOutcome.stdout)) {
    return failed(
      'unauthenticated',
      'The Claude CLI is not signed in with a supported subscription/session; sign in with Claude Code and retry.',
      formatted,
    );
  }
  return Object.freeze({ status: 'ready', version: formatted });
};
