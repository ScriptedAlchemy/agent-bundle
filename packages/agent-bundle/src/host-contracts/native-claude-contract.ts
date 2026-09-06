import { spawn } from 'node:child_process';

import { meetsMinimumVersion, parseSemanticVersion, type SemanticVersion } from '../core/semver.ts';

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

const minimumClaudeVersion: SemanticVersion = Object.freeze({ major: 2, minor: 1, patch: 232, prerelease: false });

export const parseClaudeVersion = parseSemanticVersion;

export const formatClaudeVersion = (version: SemanticVersion): string => `${version.major}.${version.minor}.${version.patch}`;

export const isCompatibleClaudeVersion = (version: SemanticVersion): boolean => meetsMinimumVersion(version, minimumClaudeVersion);

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

const appendBounded = (chunks: Buffer[], chunk: Buffer, maxBytes: number, currentBytes: number): number => {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return currentBytes;
  const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(retained);
  return currentBytes + retained.byteLength;
};

export const runNativeClaudeProcess = (
  request: NativeClaudeProcessRequest,
  signalOrOptions?: AbortSignal | NativeClaudeProcessOptions,
): Promise<NativeClaudeProcessResult> => new Promise((resolve, reject) => {
  const options = processOptionsFor(signalOrOptions);
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let termination: NativeClaudeProcessResult['termination'];
  let escalation: NodeJS.Timeout | undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    if (escalation !== undefined) clearTimeout(escalation);
    options.signal?.removeEventListener('abort', abort);
  };
  const settle = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const terminate = (reason: NonNullable<NativeClaudeProcessResult['termination']>) => {
    if (termination !== undefined || settled) return;
    termination = reason;
    child.kill('SIGTERM');
    escalation = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, options.gracePeriodMs);
  };
  const abort = () => { terminate('aborted'); };
  const timeout = setTimeout(() => { terminate('timed-out'); }, options.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes = appendBounded(stdout, chunk, options.maxOutputBytes, stdoutBytes);
    if (stdoutBytes >= options.maxOutputBytes && chunk.byteLength > 0) terminate('output-limit');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes = appendBounded(stderr, chunk, options.maxOutputBytes, stderrBytes);
    if (stderrBytes >= options.maxOutputBytes && chunk.byteLength > 0) terminate('output-limit');
  });
  child.once('error', (error) => {
    settle(() => { reject(error); });
  });
  child.once('close', (exitCode, closeSignal) => {
    settle(() => { resolve(Object.freeze({
      exitCode,
      signal: closeSignal,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
      ...(termination === undefined ? {} : { termination }),
    })); });
  });
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
});
