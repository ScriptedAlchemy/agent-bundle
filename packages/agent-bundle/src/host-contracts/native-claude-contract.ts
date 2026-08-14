export interface NativeClaudeCommandOptions {
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

export const createNativeClaudeChildEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries(environment).filter(([name]) => !isProviderApiKey(name)),
);

export type ClaudeActivationEvidence = 'observed' | 'unavailable';

export interface RedactedClaudeEnvelope {
  readonly fields: readonly string[];
  readonly subtype?: string;
  readonly type?: string;
}

export interface NativeClaudeStreamEvidence {
  readonly activationEvidence: ClaudeActivationEvidence;
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
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    if (tools.includes('Skill')) activationEvidence = 'observed';
    toolCalls += tools.filter((name) => name.startsWith('mcp__')).length;
    if (
      record.hook_event_name !== undefined
      || record.hook_event !== undefined
      || envelope.subtype?.startsWith('hook_') === true
    ) hookEnvelopes.push(envelope);
    if (envelope.type === 'error' || envelope.subtype === 'error') errorEnvelopes.push(envelope);
  }

  return Object.freeze({
    activationEvidence,
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
}

export type NativeClaudeProcessRunner = (request: NativeClaudeProcessRequest) => Promise<NativeClaudeProcessResult>;

export interface NativeClaudeSmokeOptions extends NativeClaudeCommandOptions {
  readonly candidatePluginNames?: readonly string[];
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
  readonly status: 'harness-failure' | 'passed' | 'skipped';
}

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
  version: string,
  validation: NativeClaudeProcessResult,
  execution: NativeClaudeProcessResult,
  stream: NativeClaudeStreamEvidence,
): NativeClaudeSmokeEvidence => Object.freeze({
  command: nativeClaudeSmokeCommandShape,
  stderr: stderrEvidence(execution.stderr),
  stream,
  validation: Object.freeze({ exitCode: validation.exitCode }),
  version,
});

const isMissingExecutableError = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

const looksUnauthenticated = (output: string): boolean =>
  /(?:not\s+logged\s+in|authentication|authenticate|unauthorized|subscription)/iu.test(output);

interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

const minimumClaudeVersion = Object.freeze({ major: 2, minor: 1, patch: 232, prerelease: false });

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

const formatClaudeVersion = (version: ClaudeVersion): string => `${version.major}.${version.minor}.${version.patch}`;

const isCompatibleClaudeVersion = (version: ClaudeVersion): boolean => {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (version[field] !== minimumClaudeVersion[field]) return version[field] > minimumClaudeVersion[field];
  }
  return !version.prerelease;
};

export const nativeClaudeSmokeEnabled = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean => environment.AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE === '1';

export const runNativeClaudeProcess = (
  request: NativeClaudeProcessRequest,
  signal?: AbortSignal,
): Promise<NativeClaudeProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const abort = () => { child.kill('SIGTERM'); };
  const cleanup = () => signal?.removeEventListener('abort', abort);
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
  child.once('error', (error) => {
    cleanup();
    reject(error);
  });
  child.once('close', (exitCode, closeSignal) => {
    cleanup();
    resolve(Object.freeze({
      exitCode,
      signal: closeSignal,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    }));
  });
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});

export const runNativeClaudeSmoke = async (options: NativeClaudeSmokeOptions): Promise<NativeClaudeSmokeReport> => {
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
      allowedPluginNames: options.candidatePluginNames,
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
  const evidence = evidenceFor(formattedVersion, validation, execution, stream);
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
import { spawn } from 'node:child_process';
