import { homedir } from 'node:os';
import { join } from 'node:path';

import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
import { digestFileTree } from './native-codex-contract.ts';
import { runBoundedChildProcess } from './process.ts';

export interface NativeClaudeCommandOptions {
  readonly model?: string;
  readonly pluginDirectory: string;
  readonly prompt: string;
}

export interface NativeClaudeCommand {
  readonly args: readonly string[];
  readonly executable: 'claude';
}

export const createNativeClaudeCommand = (options: NativeClaudeCommandOptions): NativeClaudeCommand => Object.freeze({
  args: Object.freeze([
    '-p',
    '--plugin-dir',
    options.pluginDirectory,
    ...(options.model === undefined ? [] : ['--model', options.model]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--no-session-persistence',
    options.prompt,
  ]),
  executable: 'claude',
});

const isProviderApiKey = (name: string): boolean => /(?:^|_)API_KEY$/iu.test(name);

const subscriptionBypassVariables = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
]);

const removesSubscriptionBypass = (name: string): boolean => subscriptionBypassVariables.has(name.toUpperCase());

export const createNativeClaudeChildEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries(environment).filter(([name]) => !isProviderApiKey(name) && !removesSubscriptionBypass(name)),
);

export type ClaudeActivationEvidence = 'observed' | 'unavailable';
export type ClaudeInitAuthSource = 'environment-key' | 'non-environment' | 'unavailable';

export interface RedactedClaudeEnvelope {
  readonly fields: readonly string[];
  readonly subtype?: string;
  readonly type?: string;
}

export interface NativeClaudeStreamEvidence {
  readonly activationEvidence: ClaudeActivationEvidence;
  readonly authSource: ClaudeInitAuthSource;
  readonly envelopes: readonly RedactedClaudeEnvelope[];
  readonly errorEnvelopes: readonly RedactedClaudeEnvelope[];
  readonly hookEnvelopes: readonly RedactedClaudeEnvelope[];
  readonly mcp: Readonly<{
    readonly configuredServers: number;
    readonly toolCalls: number;
  }>;
  readonly plugins: readonly string[];
}

export interface NativeClaudeStreamNormalizationOptions {
  readonly allowedPluginNames?: readonly string[];
  readonly candidateSkillEventName?: string;
}

const isSafeLabel = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value);

const parseStreamRecords = (raw: string): readonly Readonly<Record<string, unknown>>[] => Object.freeze(
  raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new TypeError('Claude stream event must be a JSON object.');
      return value;
    }),
);

const redactEnvelope = (value: Readonly<Record<string, unknown>>): RedactedClaudeEnvelope => Object.freeze({
  fields: Object.freeze(Object.keys(value).sort()),
  ...(isSafeLabel(value.subtype) ? { subtype: value.subtype } : {}),
  ...(isSafeLabel(value.type) ? { type: value.type } : {}),
});

const namesFromRecords = (value: unknown): readonly string[] => !Array.isArray(value)
  ? Object.freeze([])
  : Object.freeze(value.flatMap((entry) => isRecord(entry) && isSafeLabel(entry.name) ? [entry.name] : []));

const toolUseNames = (value: Readonly<Record<string, unknown>>): readonly string[] => {
  const message = value.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return Object.freeze([]);
  return Object.freeze(message.content.flatMap((content) =>
    isRecord(content) && content.type === 'tool_use' && isSafeLabel(content.name) ? [content.name] : []));
};

const hasCandidateSkillUse = (value: Readonly<Record<string, unknown>>, candidateSkillEventName: string | undefined): boolean => {
  if (candidateSkillEventName === undefined) return false;
  const message = value.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  return message.content.some((content) =>
    isRecord(content)
    && content.type === 'tool_use'
    && content.name === 'Skill'
    && isRecord(content.input)
    && content.input.skill === candidateSkillEventName);
};

const normalizeInitAuthSource = (value: unknown): ClaudeInitAuthSource => {
  if (typeof value !== 'string') return 'unavailable';
  return /(?:environment|env|api[ _-]?key)/iu.test(value) ? 'environment-key' : 'non-environment';
};

export const normalizeNativeClaudeStream = (
  raw: string,
  options: NativeClaudeStreamNormalizationOptions = {},
): NativeClaudeStreamEvidence => {
  const records = parseStreamRecords(raw);
  const envelopes = Object.freeze(records.map(redactEnvelope));
  const allowedPluginNames = options.allowedPluginNames === undefined
    ? undefined
    : new Set(options.allowedPluginNames);
  const pluginNames = new Set<string>();
  let activationEvidence: ClaudeActivationEvidence = 'unavailable';
  let authSource: ClaudeInitAuthSource = 'unavailable';
  let configuredServers = 0;
  let toolCalls = 0;
  const errorEnvelopes: RedactedClaudeEnvelope[] = [];
  const hookEnvelopes: RedactedClaudeEnvelope[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const envelope = envelopes[index]!;
    for (const plugin of namesFromRecords(record.plugins)) {
      if (allowedPluginNames === undefined || allowedPluginNames.has(plugin)) pluginNames.add(plugin);
    }
    configuredServers += namesFromRecords(record.mcp_servers).length;
    const tools = toolUseNames(record);
    if (hasCandidateSkillUse(record, options.candidateSkillEventName)) activationEvidence = 'observed';
    toolCalls += tools.filter((name) => name.startsWith('mcp__')).length;
    const recordAuthSource = normalizeInitAuthSource(record.apiKeySource ?? record.authSource ?? record.auth_source);
    if (recordAuthSource === 'environment-key' || authSource === 'unavailable') authSource = recordAuthSource;
    if (
      record.hook_event_name !== undefined
      || record.hook_event !== undefined
      || envelope.subtype?.startsWith('hook_') === true
    ) hookEnvelopes.push(envelope);
    if (envelope.type === 'error' || envelope.subtype === 'error') errorEnvelopes.push(envelope);
  }

  return Object.freeze({
    activationEvidence,
    authSource,
    envelopes,
    errorEnvelopes: Object.freeze(errorEnvelopes),
    hookEnvelopes: Object.freeze(hookEnvelopes),
    mcp: Object.freeze({ configuredServers, toolCalls }),
    plugins: Object.freeze([...pluginNames].sort()),
  });
};

export interface NativeClaudeProcessRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
}

export interface NativeClaudeProcessResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination?: 'aborted' | 'output-limit' | 'timed-out';
}

export type NativeClaudeProcessRunner = (request: NativeClaudeProcessRequest) => Promise<NativeClaudeProcessResult>;

export interface NativeClaudeProcessOptions {
  readonly gracePeriodMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface NativeClaudeSmokeOptions extends NativeClaudeCommandOptions {
  readonly candidatePluginName: string;
  readonly candidateSkillName: string;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly run?: NativeClaudeProcessRunner;
  readonly signal?: AbortSignal;
}

export interface NativeClaudeSmokeDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface NativeClaudeSmokeEvidence {
  readonly authentication: Readonly<{
    readonly status: 'subscription-session';
  }>;
  readonly command: Readonly<{
    readonly args: readonly string[];
    readonly executable: 'claude';
  }>;
  readonly stderr: Readonly<{
    readonly lineCount: number;
    readonly present: boolean;
  }>;
  readonly stream: NativeClaudeStreamEvidence;
  readonly validation: Readonly<{
    readonly exitCode: number | null;
  }>;
  readonly version: string;
}

export interface NativeClaudeSmokeReport {
  readonly diagnostics: readonly NativeClaudeSmokeDiagnostic[];
  readonly evidence?: NativeClaudeSmokeEvidence;
  readonly normalHome?: 'unchanged';
  readonly status: 'harness-failure' | 'passed' | 'skipped';
}

interface ClaudeNormalHomeSnapshot {
  readonly claudeJson: string;
  readonly config: string;
  readonly localSettings: string;
  readonly plugins: string;
  readonly settings: string;
}

const candidateSkillEventName = (pluginName: string, skillName: string): string => `${pluginName}:${skillName}`;

const nativeClaudeSmokeCommandShape = Object.freeze({
  args: Object.freeze([
    '-p',
    '--plugin-dir',
    '<plugin-root>',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--no-session-persistence',
    '<task-input>',
  ]),
  executable: 'claude' as const,
});

const diagnostic = (code: string, message: string): readonly NativeClaudeSmokeDiagnostic[] =>
  Object.freeze([Object.freeze({ code, message })]);

const stderrEvidence = (stderr: string): NativeClaudeSmokeEvidence['stderr'] => Object.freeze({
  lineCount: stderr.trim().length === 0 ? 0 : stderr.trim().split(/\r?\n/u).length,
  present: stderr.trim().length > 0,
});

const evidenceFor = (
  authentication: NativeClaudeSmokeEvidence['authentication'],
  version: string,
  validation: NativeClaudeProcessResult,
  execution: NativeClaudeProcessResult,
  stream: NativeClaudeStreamEvidence,
): NativeClaudeSmokeEvidence => Object.freeze({
  authentication,
  command: nativeClaudeSmokeCommandShape,
  stderr: stderrEvidence(execution.stderr),
  stream,
  validation: Object.freeze({ exitCode: validation.exitCode }),
  version,
});

const digestClaudeFileTree = (path: string, includeContents = true): Promise<string> =>
  digestFileTree(path, Object.freeze({ hashContents: includeContents, includeIdentity: true }));

interface ClaudeNormalHomePaths {
  readonly directory: string;
  readonly stateFile: string;
}

const resolveClaudeNormalHome = (environment: Readonly<NodeJS.ProcessEnv>): ClaudeNormalHomePaths => {
  const configuredDirectory = environment.CLAUDE_CONFIG_DIR;
  if (configuredDirectory !== undefined) {
    return Object.freeze({ directory: configuredDirectory, stateFile: join(configuredDirectory, '.claude.json') });
  }
  const homeDirectory = homedir();
  return Object.freeze({ directory: join(homeDirectory, '.claude'), stateFile: join(homeDirectory, '.claude.json') });
};

const snapshotClaudeNormalHome = async (paths: ClaudeNormalHomePaths): Promise<ClaudeNormalHomeSnapshot> => Object.freeze({
  claudeJson: await digestClaudeFileTree(paths.stateFile),
  config: await digestClaudeFileTree(join(paths.directory, 'config.json')),
  localSettings: await digestClaudeFileTree(join(paths.directory, 'settings.local.json')),
  plugins: await digestClaudeFileTree(join(paths.directory, 'plugins'), false),
  settings: await digestClaudeFileTree(join(paths.directory, 'settings.json')),
});

const sameClaudeNormalHome = (left: ClaudeNormalHomeSnapshot, right: ClaudeNormalHomeSnapshot): boolean =>
  left.claudeJson === right.claudeJson
  && left.config === right.config
  && left.localSettings === right.localSettings
  && left.plugins === right.plugins
  && left.settings === right.settings;

const normalHomeFailure = (code: string, message: string): NativeClaudeSmokeReport => Object.freeze({
  diagnostics: diagnostic(code, message),
  status: 'harness-failure',
});

const normalHomeChangedDiagnostic = Object.freeze({
  code: 'claude-native.normal-home.changed',
  message: 'Claude normal config/settings/plugins state changed; inspect local state without retaining its output.',
});

const isMissingExecutableError = (error: unknown): boolean => isErrno(error, 'ENOENT');

const looksUnauthenticated = (output: string): boolean =>
  /(?:not\s+logged\s+in|authentication|authenticate|unauthorized|subscription)/iu.test(output);

export interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

const minimumClaudeVersion = Object.freeze({ major: 2, minor: 1, patch: 232, prerelease: false });

export const parseClaudeVersion = (output: string): ClaudeVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|[^0-9A-Za-z.-])/u.exec(output);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  });
};

export const formatClaudeVersion = (version: ClaudeVersion): string => `${version.major}.${version.minor}.${version.patch}`;

export const isCompatibleClaudeVersion = (version: ClaudeVersion): boolean => {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (version[field] !== minimumClaudeVersion[field]) return version[field] > minimumClaudeVersion[field];
  }
  return !version.prerelease;
};

const parseSubscriptionAuthentication = (
  output: string,
): NativeClaudeSmokeEvidence['authentication'] | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.loggedIn !== true) return undefined;
  const authMethod = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : '';
  const subscriptionType = typeof value.subscriptionType === 'string' ? value.subscriptionType.toLowerCase() : '';
  const apiProvider = typeof value.apiProvider === 'string' ? value.apiProvider.toLowerCase() : '';
  const usesAlternateProvider = /(?:api[ _-]?key|bedrock|vertex|foundry)/iu.test(`${authMethod}\n${apiProvider}`);
  const supportedMethod = authMethod === 'claude.ai' || authMethod === 'oauth' || authMethod.includes('session');
  if (usesAlternateProvider || !supportedMethod || subscriptionType.length === 0 || subscriptionType === 'none') return undefined;
  return Object.freeze({ status: 'subscription-session' });
};

const nativeClaudeProcessDefaults = Object.freeze({
  gracePeriodMs: 1_000,
  maxOutputBytes: 256 * 1024,
  timeoutMs: 60_000,
});

interface ResolvedNativeClaudeProcessOptions {
  readonly gracePeriodMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === 'object'
  && value !== null
  && 'aborted' in value
  && 'addEventListener' in value
  && typeof value.addEventListener === 'function';

const processOptionsFor = (value: AbortSignal | NativeClaudeProcessOptions | undefined): ResolvedNativeClaudeProcessOptions => {
  const options = isAbortSignal(value) ? { signal: value } : value;
  return Object.freeze({
    gracePeriodMs: options?.gracePeriodMs ?? nativeClaudeProcessDefaults.gracePeriodMs,
    maxOutputBytes: options?.maxOutputBytes ?? nativeClaudeProcessDefaults.maxOutputBytes,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? nativeClaudeProcessDefaults.timeoutMs,
  });
};

export const nativeClaudeSmokeEnabled = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean => environment.AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE === '1';

export const runNativeClaudeProcess = async (
  request: NativeClaudeProcessRequest,
  signalOrOptions?: AbortSignal | NativeClaudeProcessOptions,
): Promise<NativeClaudeProcessResult> => {
  const options = processOptionsFor(signalOrOptions);
  const result = await runBoundedChildProcess(request, Object.freeze({
    gracePeriodMs: options.gracePeriodMs,
    labels: Object.freeze({
      aborted: 'aborted',
      outputLimit: 'output-limit',
      timedOut: 'timed-out',
    }),
    maxOutputBytes: options.maxOutputBytes,
    overflow: 'truncate',
    outputBudget: 'separate',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  }));
  return Object.freeze({
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
    ...(result.termination === undefined ? {} : { termination: result.termination }),
  });
};

const runNativeClaudeSmokeUnchecked = async (options: NativeClaudeSmokeOptions): Promise<NativeClaudeSmokeReport> => {
  if (!options.enabled) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.opt-in.required',
        'Set AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE=1 to run the signed-in Claude native smoke.',
      ),
      status: 'skipped',
    });
  }

  const environment = createNativeClaudeChildEnvironment(options.environment);
  const run = options.run ?? ((request: NativeClaudeProcessRequest) => runNativeClaudeProcess(request, options.signal));
  const versionRequest: NativeClaudeProcessRequest = Object.freeze({
    args: Object.freeze(['--version']),
    cwd: options.cwd,
    environment,
    executable: 'claude',
  });
  let versionOutput: NativeClaudeProcessResult;
  try {
    versionOutput = await run(versionRequest);
  } catch (error) {
    return Object.freeze({
      diagnostics: diagnostic(
        isMissingExecutableError(error) ? 'claude-native.cli.missing' : 'claude-native.version.unavailable',
        isMissingExecutableError(error)
          ? 'Claude is not installed or is not on PATH; install Claude Code 2.1.232 or newer.'
          : 'Claude version preflight could not start; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  if (versionOutput.exitCode !== 0) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.version.failed',
        'Claude version preflight failed; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  const version = parseClaudeVersion(versionOutput.stdout);
  if (version === undefined) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.version.unparseable',
        'Claude did not report a semantic version for the 2.1.232 native contract.',
      ),
      status: 'harness-failure',
    });
  }
  const formattedVersion = formatClaudeVersion(version);
  if (!isCompatibleClaudeVersion(version)) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.version.incompatible',
        `Claude Code ${formattedVersion} is older than the required 2.1.232 native contract; upgrade the CLI.`,
      ),
      status: 'harness-failure',
    });
  }

  const authRequest: NativeClaudeProcessRequest = Object.freeze({
    args: Object.freeze(['auth', 'status', '--json']),
    cwd: options.cwd,
    environment,
    executable: 'claude',
  });
  let authenticationResult: NativeClaudeProcessResult;
  try {
    authenticationResult = await run(authRequest);
  } catch (error) {
    return Object.freeze({
      diagnostics: diagnostic(
        isMissingExecutableError(error) ? 'claude-native.cli.missing' : 'claude-native.auth.unavailable',
        isMissingExecutableError(error)
          ? 'Claude is not installed or is not on PATH; install Claude Code 2.1.232 or newer.'
          : 'Claude authentication preflight could not start; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  if (authenticationResult.exitCode !== 0) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.auth.failed',
        'Claude authentication preflight failed; sign in with Claude Code and retry.',
      ),
      status: 'harness-failure',
    });
  }
  const authentication = parseSubscriptionAuthentication(authenticationResult.stdout);
  if (authentication === undefined) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.auth.unsupported',
        'Claude is not signed in with a supported subscription/session; sign in with Claude Code and retry.',
      ),
      status: 'harness-failure',
    });
  }

  const validationRequest: NativeClaudeProcessRequest = Object.freeze({
    args: Object.freeze(['plugin', 'validate', '--strict', options.pluginDirectory]),
    cwd: options.cwd,
    environment,
    executable: 'claude',
  });
  let validation: NativeClaudeProcessResult;
  try {
    validation = await run(validationRequest);
  } catch (error) {
    return Object.freeze({
      diagnostics: diagnostic(
        isMissingExecutableError(error) ? 'claude-native.cli.missing' : 'claude-native.validation.unavailable',
        isMissingExecutableError(error)
          ? 'Claude is not installed or is not on PATH; install Claude Code 2.1.232 or newer.'
          : 'Claude strict plugin validation could not start; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  if (validation.exitCode !== 0) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.plugin-validation.failed',
        'Claude strict plugin validation failed; inspect the candidate locally without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }

  let execution: NativeClaudeProcessResult;
  try {
    const command = createNativeClaudeCommand(options);
    execution = await run(Object.freeze({
      ...command,
      cwd: options.cwd,
      environment,
    }));
  } catch (error) {
    return Object.freeze({
      diagnostics: diagnostic(
        isMissingExecutableError(error) ? 'claude-native.cli.missing' : 'claude-native.execution.unavailable',
        isMissingExecutableError(error)
          ? 'Claude is not installed or is not on PATH; install Claude Code 2.1.232 or newer.'
          : 'Claude native execution could not start; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }

  let stream: NativeClaudeStreamEvidence;
  try {
    stream = normalizeNativeClaudeStream(execution.stdout, {
      allowedPluginNames: [options.candidatePluginName],
      candidateSkillEventName: candidateSkillEventName(options.candidatePluginName, options.candidateSkillName),
    });
  } catch {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.stream.invalid',
        'Claude native execution did not return a valid stream-JSON trace; inspect the local CLI without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  const evidence = evidenceFor(authentication, formattedVersion, validation, execution, stream);
  if (execution.exitCode !== 0) {
    return Object.freeze({
      diagnostics: diagnostic(
        looksUnauthenticated(`${execution.stdout}\n${execution.stderr}`)
          ? 'claude-native.authentication.unavailable'
          : 'claude-native.execution.failed',
        looksUnauthenticated(`${execution.stdout}\n${execution.stderr}`)
          ? 'Claude is not authenticated with a usable subscription/session; sign in with Claude Code and retry.'
          : 'Claude native execution failed; inspect the local CLI without retaining its output.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }
  if (stream.authSource === 'environment-key') {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.auth.environment-key',
        'Claude reported an environment-key auth source; remove provider credentials before running the subscription smoke.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }
  if (!stream.plugins.includes(options.candidatePluginName)) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.plugin.not-loaded',
        'Claude did not report the explicit candidate plugin as loaded; inspect the local CLI without retaining its output.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }
  if (stream.activationEvidence !== 'observed') {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.activation.unobserved',
        'Claude did not emit the exact candidate Skill tool event; inspect the local CLI without retaining its output.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }
  if (stream.envelopes.length === 0 || !stream.envelopes.some((envelope) => envelope.type === 'result')) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.stream.result.missing',
        'Claude native execution did not emit a terminal result event; inspect the local CLI without retaining its output.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }
  if (stream.errorEnvelopes.length > 0) {
    return Object.freeze({
      diagnostics: diagnostic(
        'claude-native.stream.error',
        'Claude native execution emitted a host error event; inspect the local CLI without retaining its output.',
      ),
      evidence,
      status: 'harness-failure',
    });
  }

  return Object.freeze({ diagnostics: Object.freeze([]), evidence, status: 'passed' });
};

export const runNativeClaudeSmoke = async (options: NativeClaudeSmokeOptions): Promise<NativeClaudeSmokeReport> => {
  if (!options.enabled) return runNativeClaudeSmokeUnchecked(options);

  const environment = options.environment ?? process.env;
  const normalClaudeHome = resolveClaudeNormalHome(environment);
  let before: ClaudeNormalHomeSnapshot;
  try {
    before = await snapshotClaudeNormalHome(normalClaudeHome);
  } catch {
    return normalHomeFailure(
      'claude-native.normal-home.unavailable',
      'Claude normal config/settings/plugins could not be inspected; inspect local state without retaining its output.',
    );
  }

  const result = await runNativeClaudeSmokeUnchecked(options);
  let after: ClaudeNormalHomeSnapshot;
  try {
    after = await snapshotClaudeNormalHome(normalClaudeHome);
  } catch {
    return Object.freeze({
      ...result,
      diagnostics: diagnostic(
        'claude-native.normal-home.unavailable',
        'Claude normal config/settings/plugins could not be inspected after the smoke; inspect local state without retaining its output.',
      ),
      status: 'harness-failure',
    });
  }
  if (!sameClaudeNormalHome(before, after)) {
    return Object.freeze({
      ...result,
      diagnostics: Object.freeze([normalHomeChangedDiagnostic]),
      status: 'harness-failure',
    });
  }
  return Object.freeze({ ...result, normalHome: 'unchanged' as const });
};
