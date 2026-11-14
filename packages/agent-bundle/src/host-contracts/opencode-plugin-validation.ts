import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  openCodeArtifactPaths,
  openCodeConfigValidator,
  openCodeMcpValidator,
  openCodePluginValidator,
} from '../adapters/opencode.ts';
import { freezeDiagnostics, type Diagnostic, type DiagnosticSeverity } from '../core/diagnostics.ts';
import { errorMessage, isErrno } from '../core/errors.ts';
import { runBoundedChildProcess, type BoundedChildProcessRequest, type BoundedChildProcessResult } from './process.ts';

export type OpenCodePluginValidationStatus = 'failed' | 'passed' | 'unavailable' | 'warnings';

export interface OpenCodePluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'opencode';
  readonly status: OpenCodePluginValidationStatus;
  readonly target: string;
  readonly version?: string;
}

export type OpenCodePluginCommandResult = BoundedChildProcessResult<'output-limit' | 'timed-out'>;
export type OpenCodePluginCommandRunner = (
  request: BoundedChildProcessRequest,
) => Promise<OpenCodePluginCommandResult>;

export interface ValidateOpenCodePluginOptions {
  readonly executable?: string;
  readonly pluginDirectory: string;
  readonly run?: OpenCodePluginCommandRunner;
  readonly target: string;
}

interface OpenCodeStaticIssue {
  readonly code: 'AB6040';
  readonly message: string;
  readonly severity: DiagnosticSeverity;
}

const diagnostic = (
  code: 'AB6040' | 'AB6041',
  message: string,
  severity: DiagnosticSeverity,
  target: string,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery: code === 'AB6040'
    ? 'Repair the generated OpenCode V2 package against its pinned config, package, and MCP contracts, then rebuild.'
    : 'Install OpenCode V2 on PATH or use `agent-bundle --host-validation` on a machine with the host available; local schema validation already ran.',
  severity,
  target,
});

const versionFrom = (output: string): string | undefined => /\bv?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1];

export const validateOpenCodePluginFiles = async (options: {
  readonly pluginDirectory: string;
  readonly target: string;
}): Promise<readonly OpenCodeStaticIssue[]> => {
  const issues: OpenCodeStaticIssue[] = [];
  const read = async (path: string, validate: (document: unknown) => boolean, required: boolean): Promise<void> => {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(join(options.pluginDirectory, path), 'utf8')) as unknown;
    } catch (error) {
      if (!required && isErrno(error, 'ENOENT')) return;
      issues.push({ code: 'AB6040', message: `${path} is missing or invalid JSON (${errorMessage(error)}).`, severity: 'error' });
      return;
    }
    if (!validate(document)) issues.push({ code: 'AB6040', message: `${path} does not satisfy its pinned OpenCode V2 schema.`, severity: 'error' });
  };
  await read(openCodeArtifactPaths.config, openCodeConfigValidator, true);
  await read(openCodeArtifactPaths.package, openCodePluginValidator, true);
  await read(openCodeArtifactPaths.mcp, openCodeMcpValidator, false);
  return Object.freeze(issues);
};

const defaultRun: OpenCodePluginCommandRunner = (request) => runBoundedChildProcess(request, {
  labels: { outputLimit: 'output-limit', timedOut: 'timed-out' },
  maxOutputBytes: 64 * 1024,
  timeoutMs: 5_000,
  windowsHide: true,
});

export const validateOpenCodePlugin = async (
  options: ValidateOpenCodePluginOptions,
): Promise<OpenCodePluginValidationReport> => {
  const issues = await validateOpenCodePluginFiles(options);
  const diagnostics: Diagnostic[] = issues.map((issue) => diagnostic('AB6040', issue.message, issue.severity, options.target));
  let version: string | undefined;
  try {
    const result = await (options.run ?? defaultRun)({
      args: ['--version'],
      cwd: options.pluginDirectory,
      executable: options.executable ?? 'opencode',
    });
    version = versionFrom(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0 || result.termination !== undefined || version === undefined) {
      diagnostics.push(diagnostic('AB6041', 'OpenCode V2 version probe failed; local pinned-schema validation still ran.', 'warning', options.target));
    }
    if (version !== undefined && !version.startsWith('2.')) {
      diagnostics.push(diagnostic('AB6041', `OpenCode ${version} is not the V2 plugin contract this target supports (V2 2.2.6).`, 'error', options.target));
    }
  } catch (error) {
    diagnostics.push(diagnostic(
      'AB6041',
      isErrno(error, 'ENOENT')
        ? 'OpenCode V2 is not installed or is not on PATH; local pinned-schema validation still ran.'
        : `OpenCode V2 version probe could not start (${errorMessage(error)}); local pinned-schema validation still ran.`,
      isErrno(error, 'ENOENT') ? 'info' : 'warning',
      options.target,
    ));
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(diagnostics),
    host: 'opencode',
    status: diagnostics.some((entry) => entry.severity === 'error')
      ? 'failed'
      : version === undefined
        ? diagnostics.length === 0 ? 'unavailable' : 'warnings'
        : diagnostics.some((entry) => entry.severity === 'warning') ? 'warnings' : 'passed',
    target: options.target,
    ...(version === undefined ? {} : { version }),
  });
};
