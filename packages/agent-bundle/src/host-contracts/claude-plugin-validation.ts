import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

import { claudeArtifactValidation } from '../adapters/claude.ts';
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import {
  runBoundedChildProcess,
  type BoundedChildProcessRequest,
  type BoundedChildProcessResult,
} from './process.ts';

const maximumOutputBytes = 1024 * 1024;
const validationTimeoutMs = 15_000;
const versionTimeoutMs = 5_000;

type ClaudePluginTermination = 'output-limit' | 'timed-out';

export type ClaudePluginValidationStatus = 'failed' | 'passed' | 'unavailable' | 'warnings';

export interface ClaudePluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'claude';
  readonly status: ClaudePluginValidationStatus;
  readonly target: string;
  readonly version?: string;
}

export type ClaudePluginCommandResult = BoundedChildProcessResult<ClaudePluginTermination>;

export type ClaudePluginCommandRunner = (
  request: BoundedChildProcessRequest,
) => Promise<ClaudePluginCommandResult>;

export interface ValidateClaudePluginOptions {
  readonly executable?: string;
  readonly pluginDirectory: string;
  /** Injectable proof seam. Production always uses the bounded process runner. */
  readonly run?: ClaudePluginCommandRunner;
  /** Promote host warnings to Agent Bundle errors. Claude itself always runs with `--strict`. */
  readonly strict?: boolean;
  readonly target: string;
}

export interface ValidateClaudePluginFilesOptions {
  readonly pluginDirectory: string;
  readonly target: string;
}

const runClaudeCommand: ClaudePluginCommandRunner = (request) => runBoundedChildProcess(request, {
  labels: { outputLimit: 'output-limit', timedOut: 'timed-out' },
  maxOutputBytes: maximumOutputBytes,
  timeoutMs: request.args[0] === '--version' ? versionTimeoutMs : validationTimeoutMs,
  windowsHide: true,
});

const versionFrom = (output: string): string | undefined =>
  /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];

const diagnostic = (
  code: 'AB6019' | 'AB6020' | 'AB6021' | 'AB6022',
  message: string,
  severity: DiagnosticSeverity,
  target: string,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery: code === 'AB6019'
    ? 'Install Claude Code and ensure `claude` is on PATH, then rerun artifact validation.'
    : code === 'AB6022'
      ? 'Verify the Claude CLI starts and responds, then rerun `claude plugin validate <bundle-dir> --strict`.'
      : 'Run `claude plugin validate <bundle-dir> --strict`, repair the reported Claude artifact, and rebuild.',
  severity,
  target,
});

const issueLines = (output: string): readonly { readonly message: string; readonly severity: 'error' | 'warning' }[] => {
  const issues: { message: string; severity: 'error' | 'warning' }[] = [];
  let section: 'error' | 'warning' | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/Found \d+ warnings?:/u.test(line)) {
      section = 'warning';
      continue;
    }
    if (/Found \d+ errors?:/u.test(line)) {
      section = 'error';
      continue;
    }
    if (!line.startsWith('❯ ') || section === undefined) continue;
    issues.push(Object.freeze({ message: line.slice(2).trim(), severity: section }));
  }
  return Object.freeze(issues);
};

const matchingDocumentPaths = async (
  root: string,
  contractPath: string,
): Promise<readonly string[]> => {
  const wildcard = contractPath.indexOf('*');
  if (wildcard === -1) return Object.freeze([contractPath]);
  const directory = posix.dirname(contractPath);
  const name = contractPath.slice(directory.length + 1);
  const nameWildcard = name.indexOf('*');
  const prefix = name.slice(0, nameWildcard);
  const suffix = name.slice(nameWildcard + 1);
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    throw error;
  }
  return Object.freeze(entries
    .filter((entry) =>
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(suffix) &&
      entry.name.length > prefix.length + suffix.length)
    .map((entry) => posix.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right)));
};

const localDiagnostic = (
  code: 'AB6006' | 'AB6011' | 'AB6012',
  message: string,
  target: string,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery: 'Repair the generated Claude document so it satisfies the vendored pinned schema, then rebuild.',
  severity: 'error',
  target,
});

export const validateClaudePluginFiles = async (
  options: ValidateClaudePluginFilesOptions,
): Promise<readonly Diagnostic[]> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const validators = new Map(
    claudeArtifactValidation.schemas.map((schema) => [schema.name, schema.validate]),
  );
  const diagnostics: Diagnostic[] = [];
  for (const contract of claudeArtifactValidation.documents) {
    let paths: readonly string[];
    try {
      paths = await matchingDocumentPaths(pluginDirectory, contract.path);
    } catch {
      diagnostics.push(localDiagnostic(
        'AB6012',
        `Claude bundle document pattern ${JSON.stringify(contract.path)} could not be read.`,
        options.target,
      ));
      continue;
    }
    if (paths.length === 0 && contract.required) {
      diagnostics.push(localDiagnostic(
        'AB6011',
        `Required Claude bundle document ${JSON.stringify(contract.path)} is missing.`,
        options.target,
      ));
      continue;
    }
    for (const relativePath of paths) {
      let document: unknown;
      try {
        document = JSON.parse(await readFile(join(pluginDirectory, relativePath), 'utf8')) as unknown;
      } catch (error) {
        if (isErrno(error, 'ENOENT') && !contract.required) continue;
        diagnostics.push(localDiagnostic(
          isErrno(error, 'ENOENT') ? 'AB6011' : 'AB6006',
          isErrno(error, 'ENOENT')
            ? `Required Claude bundle document ${JSON.stringify(relativePath)} is missing.`
            : `Claude bundle document ${JSON.stringify(relativePath)} is unreadable or not valid JSON.`,
          options.target,
        ));
        continue;
      }
      const validate = validators.get(contract.schema);
      if (validate === undefined) continue;
      let issues;
      try {
        issues = validate(document);
      } catch {
        issues = Object.freeze([Object.freeze({
          instancePath: '/',
          message: 'schema validation failed',
        })]);
      }
      for (const issue of issues) {
        diagnostics.push(localDiagnostic(
          'AB6012',
          `Claude bundle document ${JSON.stringify(relativePath)} is invalid for schema ` +
            `${JSON.stringify(contract.schema)} at ${issue.instancePath || '/'}: ${issue.message}.`,
          options.target,
        ));
      }
    }
  }
  return freezeDiagnostics(diagnostics);
};

export const validateClaudePlugin = async (
  options: ValidateClaudePluginOptions,
): Promise<ClaudePluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const executable = options.executable ?? 'claude';
  const run = options.run ?? runClaudeCommand;
  const cwd = dirname(pluginDirectory);
  let version: string | undefined;
  try {
    const probe = await run(Object.freeze({ args: Object.freeze(['--version']), cwd, executable }));
    if (probe.exitCode !== 0 || probe.termination !== undefined) {
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6022',
          probe.termination === 'timed-out'
            ? 'Claude CLI version probe timed out.'
            : probe.termination === 'output-limit'
              ? 'Claude CLI version probe exceeded its output limit.'
              : `Claude CLI version probe exited with code ${probe.exitCode ?? 'unknown'}.`,
          'error',
          options.target,
        )]),
        host: 'claude',
        status: 'failed',
        target: options.target,
      });
    }
    version = versionFrom(`${probe.stdout}\n${probe.stderr}`);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6022',
          'Claude CLI version probe could not be started.',
          'error',
          options.target,
        )]),
        host: 'claude',
        status: 'failed',
        target: options.target,
      });
    }
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6019',
        'The Claude CLI is not installed or is not on PATH; host artifact validation was skipped.',
        'info',
        options.target,
      )]),
      host: 'claude',
      status: 'unavailable',
      target: options.target,
    });
  }

  let result: ClaudePluginCommandResult;
  try {
    result = await run(Object.freeze({
      args: Object.freeze(['plugin', 'validate', pluginDirectory, '--strict']),
      cwd,
      executable,
    }));
  } catch {
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6022',
        'Claude host artifact validation could not be started.',
        'error',
        options.target,
      )]),
      host: 'claude',
      status: 'failed',
      target: options.target,
      ...(version === undefined ? {} : { version }),
    });
  }

  if (result.termination !== undefined) {
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6022',
        result.termination === 'timed-out'
          ? 'Claude host artifact validation timed out.'
          : 'Claude host artifact validation exceeded its output limit.',
        'error',
        options.target,
      )]),
      host: 'claude',
      status: 'failed',
      target: options.target,
      ...(version === undefined ? {} : { version }),
    });
  }

  const parsed = issueLines(`${result.stdout}\n${result.stderr}`);
  const diagnostics = freezeDiagnostics(parsed.map((issue) => diagnostic(
    issue.severity === 'warning' ? 'AB6020' : 'AB6021',
    `Claude plugin validation: ${issue.message}`,
    issue.severity === 'warning' && options.strict !== true ? 'warning' : 'error',
    options.target,
  )));
  if (result.exitCode !== 0 && diagnostics.length === 0) {
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6022',
        'Claude host artifact validation failed without structured issue output.',
        'error',
        options.target,
      )]),
      host: 'claude',
      status: 'failed',
      target: options.target,
      ...(version === undefined ? {} : { version }),
    });
  }
  const failed = diagnostics.some((entry) => entry.severity === 'error');
  return Object.freeze({
    diagnostics,
    host: 'claude',
    status: failed ? 'failed' : diagnostics.length === 0 ? 'passed' : 'warnings',
    target: options.target,
    ...(version === undefined ? {} : { version }),
  });
};
