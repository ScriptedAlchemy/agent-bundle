import {
  runNativeClaudeProcess,
  type NativeClaudeProcessRequest,
  type NativeClaudeProcessResult,
  type NativeClaudeProcessRunner,
} from '../host-contracts/native-claude-contract.ts';
import type { EvalHarnessFailure } from './types.ts';

export interface ClaudeProcessOutcome {
  readonly exitCode?: number;
  readonly failure?: EvalHarnessFailure;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination?: NativeClaudeProcessResult['termination'];
}

export interface ClaudeProcessOptions {
  readonly gracePeriodMs?: number;
  readonly maxOutputBytes?: number;
  /** Injected for tests; production always spawns the installed CLI. */
  readonly run?: NativeClaudeProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const minimumClaudeEvalVersion = '2.1.232';

const isMissingExecutable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export const claudeProcessFailure = (message: string): EvalHarnessFailure => Object.freeze({
  code: 'EVAL_PROCESS_UNAVAILABLE',
  message,
  stage: 'preflight',
});

/**
 * Runs one Claude child process to completion, bounding output and honouring cancellation,
 * and turns a missing executable into harness evidence instead of a thrown error.
 */
export const runClaudeStreamProcess = async (
  request: NativeClaudeProcessRequest,
  options: ClaudeProcessOptions = {},
): Promise<ClaudeProcessOutcome> => {
  let result: NativeClaudeProcessResult;
  try {
    result = options.run === undefined
      ? await runNativeClaudeProcess(request, {
        ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      : await options.run(request);
  } catch (error) {
    return Object.freeze({
      failure: claudeProcessFailure(isMissingExecutable(error)
        ? `The Claude CLI is not installed or is not on PATH; install Claude Code ${minimumClaudeEvalVersion} or newer.`
        : 'The Claude CLI could not be started; inspect the local CLI without retaining its output.'),
      stderr: '',
      stdout: '',
    });
  }
  return Object.freeze({
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    stderr: result.stderr,
    stdout: result.stdout,
    ...(result.termination === undefined ? {} : { termination: result.termination }),
  });
};
