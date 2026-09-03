import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

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
      ? 'Verify the Claude CLI starts and responds, then rerun ' +
        '`claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`.'
      : 'Run `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`, ' +
        'repair the reported Claude artifact, and rebuild.',
  severity,
  target,
});

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

type ClaudeFindingSeverity = 'error' | 'note' | 'warning';

interface ClaudeFinding {
  /** Plugin-relative path of the validated file, when the report attributed one. */
  readonly file?: string;
  readonly message: string;
  readonly path?: string;
  readonly severity: ClaudeFindingSeverity;
  /** Claude's file type label: `plugin`, `marketplace`, `hooks`, `skill`, `agent`, `command`. */
  readonly type?: string;
}

type ClaudeValidationRun = 'marketplace' | 'plugin';

/** `claude plugin validate --json` landed in Claude Code 2.1.259 (plugins-reference §plugin validate). */
const jsonReportMinimumVersion: readonly [number, number, number] = [2, 1, 259];

const parseVersion = (version: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const claudeSupportsJsonValidationReport = (version: string | undefined): boolean => {
  if (version === undefined) return false;
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== jsonReportMinimumVersion[index]) return parsed[index] > jsonReportMinimumVersion[index];
  }
  return true;
};

const relativeToPlugin = (file: string, pluginDirectory: string): string => {
  const absolute = resolve(pluginDirectory, file);
  const rel = relative(pluginDirectory, absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
};

/** One finding line: `❯ <path>: <message>`; a line without `: ` carries only a message. */
const splitFindingLine = (line: string): { readonly message: string; readonly path?: string } => {
  const separator = line.indexOf(': ');
  if (separator === -1) return { message: line };
  const path = line.slice(0, separator).trim();
  if (path === '' || /\s/u.test(path.replace(/^plugins\[\d+\] plugin\.json → /u, ''))) return { message: line };
  return { message: line.slice(separator + 2).trim(), path };
};

const findingsFromText = (output: string, pluginDirectory: string): readonly ClaudeFinding[] => {
  const findings: ClaudeFinding[] = [];
  let section: 'error' | 'warning' | undefined;
  let file: string | undefined;
  let type: string | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = /^Validating ([a-z]+(?: [a-z]+)?): (.+)$/u.exec(line);
    if (header !== null) {
      type = header[1] === 'plugin manifest' ? 'plugin' : header[1] === 'marketplace manifest' ? 'marketplace' : header[1];
      file = relativeToPlugin(header[2].trim(), pluginDirectory);
      section = undefined;
      continue;
    }
    if (/Found \d+ warnings?:/u.test(line)) {
      section = 'warning';
      continue;
    }
    if (/Found \d+ errors?:/u.test(line)) {
      section = 'error';
      continue;
    }
    if (!line.startsWith('❯ ') || section === undefined) continue;
    findings.push(Object.freeze({
      ...splitFindingLine(line.slice(2).trim()),
      severity: section,
      ...(file === undefined ? {} : { file }),
      ...(type === undefined ? {} : { type }),
    }));
  }
  return Object.freeze(findings);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const findingsFromReportEntry = (
  entry: unknown,
  severity: ClaudeFindingSeverity,
  pluginDirectory: string,
  fallbackType: string,
): readonly ClaudeFinding[] => {
  if (!isRecord(entry)) return Object.freeze([]);
  const key = severity === 'error' ? 'errors' : severity === 'warning' ? 'warnings' : 'notes';
  const items = entry[key];
  if (!Array.isArray(items)) return Object.freeze([]);
  const file = typeof entry.file === 'string' ? relativeToPlugin(entry.file, pluginDirectory) : undefined;
  const type = typeof entry.type === 'string' ? entry.type : fallbackType;
  const findings: ClaudeFinding[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.message !== 'string') continue;
    findings.push(Object.freeze({
      message: item.message,
      severity,
      type,
      ...(typeof item.path === 'string' && item.path !== '' ? { path: item.path } : {}),
      ...(file === undefined ? {} : { file }),
    }));
  }
  return Object.freeze(findings);
};

/**
 * Parse a `claude plugin validate --json` report (plugins-reference §plugin validate):
 * `{ success, strict, target, manifest | null, contents[] }`, where `manifest` and each
 * `contents[]` entry carry `file`, `type`, `errors`, `warnings`, and `notes`.
 */
const findingsFromJsonReport = (
  stdout: string,
  pluginDirectory: string,
  run: ClaudeValidationRun,
): { readonly findings: readonly ClaudeFinding[]; readonly success: boolean } | undefined => {
  const start = stdout.indexOf('{');
  if (start === -1) return undefined;
  let report: unknown;
  try {
    report = JSON.parse(stdout.slice(start)) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(report) || typeof report.success !== 'boolean') return undefined;
  const findings: ClaudeFinding[] = [];
  const entries: unknown[] = [report.manifest, ...(Array.isArray(report.contents) ? report.contents : [])];
  for (const entry of entries) {
    for (const severity of ['error', 'warning', 'note'] as const) {
      findings.push(...findingsFromReportEntry(entry, severity, pluginDirectory, run));
    }
  }
  return Object.freeze({ findings: Object.freeze(findings), success: report.success });
};

const marketplaceEntryPrefix = /^plugins\[\d+\] plugin\.json → /u;

/**
 * A marketplace run re-reports each local plugin's manifest findings prefixed with the entry
 * index (plugin-marketplaces §Marketplace validation errors). Drop the ones the plugin run
 * already reported so the artifact report lists each manifest finding once.
 */
const withoutDuplicateManifestFindings = (
  pluginFindings: readonly ClaudeFinding[],
  marketplaceFindings: readonly ClaudeFinding[],
): readonly ClaudeFinding[] => {
  const seen = new Set(pluginFindings
    .filter((finding) => finding.type === 'plugin')
    .map((finding) => `${finding.severity}\u0000${finding.path ?? ''}\u0000${finding.message}`));
  return Object.freeze(marketplaceFindings.filter((finding) => {
    if (finding.path === undefined || !marketplaceEntryPrefix.test(finding.path)) return true;
    const path = finding.path.replace(marketplaceEntryPrefix, '');
    return !seen.has(`${finding.severity}\u0000${path}\u0000${finding.message}`);
  }));
};

const findingDiagnostic = (finding: ClaudeFinding, strict: boolean, target: string): Diagnostic => {
  const location = finding.file === undefined
    ? finding.type === undefined ? '' : ` (${finding.type})`
    : ` (${finding.type ?? 'file'} ${finding.file})`;
  const detail = finding.path === undefined ? finding.message : `${finding.path}: ${finding.message}`;
  const base = diagnostic(
    finding.severity === 'error' ? 'AB6021' : 'AB6020',
    `Claude plugin validation${location}: ${detail}`,
    finding.severity === 'error' || (finding.severity === 'warning' && strict) ? 'error'
      : finding.severity === 'warning' ? 'warning' : 'info',
    target,
  );
  return finding.file === undefined ? base : Object.freeze({ ...base, generatedPath: finding.file });
};

const failedReport = (
  message: string,
  target: string,
  version: string | undefined,
): ClaudePluginValidationReport => Object.freeze({
  diagnostics: freezeDiagnostics([diagnostic('AB6022', message, 'error', target)]),
  host: 'claude',
  status: 'failed',
  target,
  ...(version === undefined ? {} : { version }),
});

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

interface ClaudeValidationTarget {
  readonly path: string;
  readonly run: ClaudeValidationRun;
}

/**
 * `claude plugin validate <dir>` validates the marketplace when `.claude-plugin/marketplace.json`
 * is present and, from a marketplace, never opens the plugin's skill, agent, command, or hook files
 * (plugin-marketplaces §Marketplace validation errors). Agent Bundle emits both manifests side by
 * side, so run the plugin manifest first (covers `plugin.json`, `hooks/hooks.json`, `skills/`,
 * `agents/`, `commands/`) and the marketplace manifest second.
 */
const validationTargets = async (pluginDirectory: string): Promise<readonly ClaudeValidationTarget[]> => {
  const manifestDirectory = join(pluginDirectory, '.claude-plugin');
  const pluginManifest = join(manifestDirectory, 'plugin.json');
  const marketplaceManifest = join(manifestDirectory, 'marketplace.json');
  const targets: ClaudeValidationTarget[] = [];
  targets.push({ path: (await fileExists(pluginManifest)) ? pluginManifest : pluginDirectory, run: 'plugin' });
  if (await fileExists(marketplaceManifest)) targets.push({ path: marketplaceManifest, run: 'marketplace' });
  return Object.freeze(targets);
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
      return failedReport(
        probe.termination === 'timed-out'
          ? 'Claude CLI version probe timed out.'
          : probe.termination === 'output-limit'
            ? 'Claude CLI version probe exceeded its output limit.'
            : `Claude CLI version probe exited with code ${probe.exitCode ?? 'unknown'}.`,
        options.target,
        undefined,
      );
    }
    version = versionFrom(`${probe.stdout}\n${probe.stderr}`);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      return failedReport('Claude CLI version probe could not be started.', options.target, undefined);
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

  const jsonReport = claudeSupportsJsonValidationReport(version);
  const findingsByRun: Partial<Record<ClaudeValidationRun, readonly ClaudeFinding[]>> = {};
  for (const validationTarget of await validationTargets(pluginDirectory)) {
    const label = validationTarget.run === 'marketplace'
      ? 'Claude marketplace manifest validation'
      : 'Claude host artifact validation';
    let result: ClaudePluginCommandResult;
    try {
      result = await run(Object.freeze({
        args: Object.freeze([
          'plugin',
          'validate',
          validationTarget.path,
          '--strict',
          ...(jsonReport ? ['--json'] : []),
        ]),
        cwd,
        executable,
      }));
    } catch {
      return failedReport(`${label} could not be started.`, options.target, version);
    }
    if (result.termination !== undefined) {
      return failedReport(
        result.termination === 'timed-out'
          ? `${label} timed out.`
          : `${label} exceeded its output limit.`,
        options.target,
        version,
      );
    }
    if (jsonReport) {
      const report = findingsFromJsonReport(result.stdout, pluginDirectory, validationTarget.run);
      if (report === undefined) {
        // Exit 2 writes nothing to stdout; the reason is on stderr.
        const reason = result.stderr.trim();
        return failedReport(
          `${label} did not return a JSON report (exit code ${result.exitCode ?? 'unknown'})` +
            `${reason === '' ? '' : `: ${reason}`}.`,
          options.target,
          version,
        );
      }
      if (!report.success && report.findings.every((finding) => finding.severity === 'note')) {
        return failedReport(`${label} failed without structured issue output.`, options.target, version);
      }
      findingsByRun[validationTarget.run] = report.findings;
      continue;
    }
    const findings = findingsFromText(`${result.stdout}\n${result.stderr}`, pluginDirectory);
    if (result.exitCode !== 0 && findings.length === 0) {
      return failedReport(`${label} failed without structured issue output.`, options.target, version);
    }
    findingsByRun[validationTarget.run] = findings;
  }

  const pluginFindings = findingsByRun.plugin ?? [];
  const marketplaceFindings = withoutDuplicateManifestFindings(pluginFindings, findingsByRun.marketplace ?? []);
  const diagnostics = freezeDiagnostics(
    [...pluginFindings, ...marketplaceFindings]
      .map((finding) => findingDiagnostic(finding, options.strict === true, options.target)),
  );
  const failed = diagnostics.some((entry) => entry.severity === 'error');
  const blocking = diagnostics.some((entry) => entry.severity !== 'info');
  return Object.freeze({
    diagnostics,
    host: 'claude',
    status: failed ? 'failed' : blocking ? 'warnings' : 'passed',
    target: options.target,
    ...(version === undefined ? {} : { version }),
  });
};
