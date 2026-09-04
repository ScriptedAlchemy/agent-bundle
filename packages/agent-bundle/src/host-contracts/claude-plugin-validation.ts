import { readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { Effect, FileSystem, Option, Result } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { claudeArtifactValidation } from '../adapters/claude.ts';
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { liftPromise } from '../effect/lift.ts';
import { isPlatformErrno, readFileString, runWithPlatform } from '../effect/platform.ts';
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

/**
 * Verdict of `claude --plugin-dir <bundle-dir> plugin list --json`: `loaded`
 * (the plugin's `<name>@inline` row has no `errors`), `refused` (the row
 * carries `errors[]`, reported as `AB7325`), `unregistered` (no row for the
 * plugin, `AB7311`), or `failed` (the listing itself could not be read, `AB6022`).
 */
export type ClaudePluginLoadStatus = 'failed' | 'loaded' | 'refused' | 'unregistered';

export interface ClaudePluginLoadCheck {
  /** The host's own load errors, verbatim from the row's `errors` array; present only when `refused`. */
  readonly errors?: readonly string[];
  readonly status: ClaudePluginLoadStatus;
}

export interface ClaudePluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'claude';
  /**
   * The load check that follows the validation runs. Absent when the CLI was
   * unavailable, a validation run itself failed (`AB6022`), the caller opted
   * out, or the bundle has no readable `.claude-plugin/plugin.json` name to
   * look for in the listing.
   */
  readonly load?: ClaudePluginLoadCheck;
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
  /**
   * Also run `claude --plugin-dir <bundle-dir> plugin list --json` after the
   * validation runs and read the plugin's row (default `true`). `plugin
   * validate --strict` accepts manifests Claude Code then refuses to load
   * (observed 2.1.250–2.1.260); the listing's `errors[]` is the only load
   * verdict. Doctor passes `false` because it runs its own registration proof.
   */
  readonly loadCheck?: boolean;
  readonly pluginDirectory: string;
  /** Injectable proof seam. Production always uses the bounded process runner. */
  readonly run?: ClaudePluginCommandRunner;
  /** Promote host warnings to Agent Bundle errors. Claude itself always runs with `--strict`. */
  readonly strict?: boolean;
  readonly target: string;
  /**
   * The `claude --version` number the caller already probed from the same
   * executable; skips this run's own probe (Doctor validates several
   * directories per host and probes once).
   */
  readonly version?: string;
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

type ClaudeHostDiagnosticCode = 'AB6019' | 'AB6020' | 'AB6021' | 'AB6022' | 'AB7311' | 'AB7325';

const recoveryFor = (code: ClaudeHostDiagnosticCode): string => {
  switch (code) {
    case 'AB6019':
      return 'Install Claude Code and ensure `claude` is on PATH, then rerun artifact validation.';
    case 'AB6020':
    case 'AB6021':
      return 'Run `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`, ' +
        'repair the reported Claude artifact, and rebuild.';
    case 'AB6022':
      return 'Verify the Claude CLI starts and responds, then rerun ' +
        '`claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`.';
    case 'AB7311':
      return 'Inspect `claude --plugin-dir <bundle-dir> plugin list --json` and register the intended bundle.';
    case 'AB7325':
      return 'Fix the artifact so `claude --plugin-dir <bundle-dir> plugin list --json` reports no `errors` for it, ' +
        'then rebuild.';
    default: {
      const exhaustive: never = code;
      throw new TypeError(`Unknown Claude host diagnostic ${String(exhaustive)}.`);
    }
  }
};

const diagnostic = (
  code: ClaudeHostDiagnosticCode,
  message: string,
  severity: DiagnosticSeverity,
  target: string,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery: recoveryFor(code),
  severity,
  target,
});

/**
 * Reads a Claude `plugin list --json` row's `errors` array. Healthy rows omit
 * the key (Claude Code 2.1.259); a refused row carries nonempty strings.
 * Anything else is treated as "no readable errors" rather than a failure, so
 * an unexpected shape cannot mask the row as uninstalled.
 */
export const claudePluginRowErrors = (row: Readonly<Record<string, unknown>>): readonly string[] => {
  const errors = row['errors'];
  if (!Array.isArray(errors)) return [];
  return Object.freeze(errors.filter((error): error is string => typeof error === 'string' && error.trim().length > 0));
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

/** Reads and parses one bundle document; `Left` is the read failure, `Right` is the parse outcome. */
const readJsonDocument = (
  path: string,
): Effect.Effect<Result.Result<{ readonly document?: unknown; readonly invalid: boolean }, PlatformError>, never, FileSystem.FileSystem> =>
  readFileString(path).pipe(
    Effect.map((source) => {
      try {
        return { document: JSON.parse(source) as unknown, invalid: false };
      } catch {
        return { invalid: true };
      }
    }),
    Effect.result,
  );

/**
 * The local document lane as a `FileSystem` program. The wildcard listing
 * (`matchingDocumentPaths`) stays on `node:fs` because it keys on `Dirent`
 * symlink types, which the pinned `FileSystem` cannot report. Not exported:
 * an Effect-typed export would put `effect` on the public declaration graph
 * (`public-api.test.ts`).
 */
const validateClaudePluginFilesProgram = Effect.fnUntraced(function* (
  options: ValidateClaudePluginFilesOptions,
): Effect.fn.Return<readonly Diagnostic[], never, FileSystem.FileSystem> {
  const pluginDirectory = resolve(options.pluginDirectory);
  const validators = new Map(
    claudeArtifactValidation.schemas.map((schema) => [schema.name, schema.validate]),
  );
  const diagnostics: Diagnostic[] = [];
  for (const contract of claudeArtifactValidation.documents) {
    const listed = yield* liftPromise(() => matchingDocumentPaths(pluginDirectory, contract.path)).pipe(Effect.option);
    if (Option.isNone(listed)) {
      diagnostics.push(localDiagnostic(
        'AB6012',
        `Claude bundle document pattern ${JSON.stringify(contract.path)} could not be read.`,
        options.target,
      ));
      continue;
    }
    const paths = listed.value;
    if (paths.length === 0 && contract.required) {
      diagnostics.push(localDiagnostic(
        'AB6011',
        `Required Claude bundle document ${JSON.stringify(contract.path)} is missing.`,
        options.target,
      ));
      continue;
    }
    for (const relativePath of paths) {
      const read = yield* readJsonDocument(join(pluginDirectory, relativePath));
      const missing = Result.isFailure(read) && isPlatformErrno(read.failure, 'ENOENT');
      if (Result.isFailure(read) || read.success.invalid) {
        if (missing && !contract.required) continue;
        diagnostics.push(localDiagnostic(
          missing ? 'AB6011' : 'AB6006',
          missing
            ? `Required Claude bundle document ${JSON.stringify(relativePath)} is missing.`
            : `Claude bundle document ${JSON.stringify(relativePath)} is unreadable or not valid JSON.`,
          options.target,
        ));
        continue;
      }
      const document = read.success.document;
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
});

export const validateClaudePluginFiles = (
  options: ValidateClaudePluginFilesOptions,
): Promise<readonly Diagnostic[]> => runWithPlatform(validateClaudePluginFilesProgram(options));

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

/**
 * `claude plugin validate --json` landed in Claude Code 2.1.259 (plugins-reference
 * §plugin validate); the pinned 2.1.260 prints it and 2.1.250 answers
 * `error: unknown option '--json'`.
 */
const jsonReportMinimumVersion: readonly [number, number, number] = [2, 1, 259];

const parseVersion = (version: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Whether to request the JSON report first. `--json` is the primary path: it
 * is skipped only for a probed version known to predate 2.1.259. An unknown
 * or unparseable version asks for JSON and falls back to the text reporter
 * when the CLI rejects the flag (`unknownJsonOption`).
 */
export const claudeSupportsJsonValidationReport = (version: string | undefined): boolean => {
  if (version === undefined) return true;
  const parsed = parseVersion(version);
  if (parsed === undefined) return true;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== jsonReportMinimumVersion[index]) return parsed[index] > jsonReportMinimumVersion[index];
  }
  return true;
};

/** A CLI without `--json` (Claude Code before 2.1.259) rejects the flag on stderr with exit 1. */
const unknownJsonOption = (result: ClaudePluginCommandResult): boolean =>
  result.exitCode !== 0 && /unknown option '--json'/u.test(result.stderr);

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

/** `access` semantics: any failure, not only `ENOENT`, means "treat as absent". */
const fileExists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
  fs.access(path).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));

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
const validationTargets = (pluginDirectory: string): Promise<readonly ClaudeValidationTarget[]> =>
  runWithPlatform(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestDirectory = join(pluginDirectory, '.claude-plugin');
    const pluginManifest = join(manifestDirectory, 'plugin.json');
    const marketplaceManifest = join(manifestDirectory, 'marketplace.json');
    const targets: ClaudeValidationTarget[] = [];
    targets.push({ path: (yield* fileExists(fs, pluginManifest)) ? pluginManifest : pluginDirectory, run: 'plugin' });
    if (yield* fileExists(fs, marketplaceManifest)) targets.push({ path: marketplaceManifest, run: 'marketplace' });
    return Object.freeze(targets);
  }));

interface ClaudeCommandContext {
  readonly cwd: string;
  readonly executable: string;
  readonly run: ClaudePluginCommandRunner;
}

type ClaudeVersionProbe =
  | { readonly report: ClaudePluginValidationReport }
  | { readonly version: string | undefined };

/** `claude --version`: the report to return when the CLI is missing or unresponsive, else its version number. */
const probeClaudeVersion = async (context: ClaudeCommandContext, target: string): Promise<ClaudeVersionProbe> => {
  try {
    const probe = await context.run(Object.freeze({
      args: Object.freeze(['--version']),
      cwd: context.cwd,
      executable: context.executable,
    }));
    if (probe.exitCode !== 0 || probe.termination !== undefined) {
      return {
        report: failedReport(
          probe.termination === 'timed-out'
            ? 'Claude CLI version probe timed out.'
            : probe.termination === 'output-limit'
              ? 'Claude CLI version probe exceeded its output limit.'
              : `Claude CLI version probe exited with code ${probe.exitCode ?? 'unknown'}.`,
          target,
          undefined,
        ),
      };
    }
    return { version: versionFrom(`${probe.stdout}\n${probe.stderr}`) };
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      return { report: failedReport('Claude CLI version probe could not be started.', target, undefined) };
    }
    return {
      report: Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6019',
          'The Claude CLI is not installed or is not on PATH; host artifact validation was skipped.',
          'info',
          target,
        )]),
        host: 'claude',
        status: 'unavailable',
        target,
      }),
    };
  }
};

export const validateClaudePlugin = async (
  options: ValidateClaudePluginOptions,
): Promise<ClaudePluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const executable = options.executable ?? 'claude';
  const run = options.run ?? runClaudeCommand;
  const cwd = dirname(pluginDirectory);
  const context: ClaudeCommandContext = Object.freeze({ cwd, executable, run });
  const probed = options.version === undefined
    ? await probeClaudeVersion(context, options.target)
    : { version: options.version };
  if ('report' in probed) return probed.report;
  const version = probed.version;

  // `--json` first (2.1.259+); a CLI that rejects the flag drops every run
  // of this validation to the text reporter, so the two runs stay consistent.
  let jsonReport = claudeSupportsJsonValidationReport(version);
  const findingsByRun: Partial<Record<ClaudeValidationRun, readonly ClaudeFinding[]>> = {};
  for (const validationTarget of await validationTargets(pluginDirectory)) {
    const label = validationTarget.run === 'marketplace'
      ? 'Claude marketplace manifest validation'
      : 'Claude host artifact validation';
    const validate = (json: boolean): Promise<ClaudePluginCommandResult> => run(Object.freeze({
      args: Object.freeze([
        'plugin',
        'validate',
        validationTarget.path,
        '--strict',
        ...(json ? ['--json'] : []),
      ]),
      cwd,
      executable,
    }));
    let result: ClaudePluginCommandResult;
    try {
      result = await validate(jsonReport);
      if (jsonReport && result.termination === undefined && unknownJsonOption(result)) {
        jsonReport = false;
        result = await validate(false);
      }
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
  const load = options.loadCheck === false
    ? undefined
    : await claudeLoadCheck(pluginDirectory, context, options.target, options.strict === true);
  const diagnostics = freezeDiagnostics([
    ...[...pluginFindings, ...marketplaceFindings]
      .map((finding) => findingDiagnostic(finding, options.strict === true, options.target)),
    ...(load?.diagnostics ?? []),
  ]);
  const failed = diagnostics.some((entry) => entry.severity === 'error');
  const blocking = diagnostics.some((entry) => entry.severity !== 'info');
  return Object.freeze({
    diagnostics,
    host: 'claude',
    ...(load === undefined ? {} : { load: load.check }),
    status: failed ? 'failed' : blocking ? 'warnings' : 'passed',
    target: options.target,
    ...(version === undefined ? {} : { version }),
  });
};

interface ClaudeLoadCheckOutcome {
  readonly check: ClaudePluginLoadCheck;
  readonly diagnostics: readonly Diagnostic[];
}

/** The `name` of `<dir>/.claude-plugin/plugin.json`, or `undefined` when the manifest cannot name a row. */
const claudePluginManifestName = (pluginDirectory: string): Promise<string | undefined> =>
  runWithPlatform(Effect.gen(function* () {
    const read = yield* readJsonDocument(join(pluginDirectory, '.claude-plugin', 'plugin.json'));
    if (Result.isFailure(read) || read.success.invalid) return undefined;
    const manifest = read.success.document;
    const name = isRecord(manifest) ? manifest['name'] : undefined;
    return typeof name === 'string' && name.trim() !== '' ? name : undefined;
  }));

const claudeLoadFailure = (message: string, target: string): ClaudeLoadCheckOutcome => Object.freeze({
  check: Object.freeze({ status: 'failed' }),
  diagnostics: freezeDiagnostics([diagnostic('AB6022', message, 'error', target)]),
});

/**
 * The load verdict `plugin validate` cannot give: `claude --plugin-dir <dir>
 * plugin list --json` registers the directory as `<name>@inline` and reports
 * in that row's `errors[]` why a session would refuse it (#479: `--strict`
 * accepts manifests Claude then refuses to load). Read-only — the listing
 * writes nothing under `~/.claude`. Returns `undefined` when the bundle has no
 * readable manifest name: the validation runs already reported that manifest.
 */
const claudeLoadCheck = async (
  pluginDirectory: string,
  context: ClaudeCommandContext,
  target: string,
  strict: boolean,
): Promise<ClaudeLoadCheckOutcome | undefined> => {
  const name = await claudePluginManifestName(pluginDirectory);
  if (name === undefined) return undefined;
  const label = 'Claude plugin load check (`claude --plugin-dir <bundle-dir> plugin list --json`)';
  let result: ClaudePluginCommandResult;
  try {
    result = await context.run(Object.freeze({
      args: Object.freeze(['--plugin-dir', pluginDirectory, 'plugin', 'list', '--json']),
      cwd: context.cwd,
      executable: context.executable,
    }));
  } catch {
    return claudeLoadFailure(`${label} could not be started.`, target);
  }
  if (result.termination !== undefined) {
    return claudeLoadFailure(
      result.termination === 'timed-out' ? `${label} timed out.` : `${label} exceeded its output limit.`,
      target,
    );
  }
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim();
    return claudeLoadFailure(
      `${label} exited with code ${result.exitCode ?? 'unknown'}${reason === '' ? '' : `: ${reason}`}.`,
      target,
    );
  }
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return claudeLoadFailure(`${label} did not return JSON.`, target);
  }
  if (!Array.isArray(rows)) return claudeLoadFailure(`${label} did not return a JSON array.`, target);
  const id = `${name}@inline`;
  const row = rows.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry['id'] === id);
  if (row === undefined) {
    return Object.freeze({
      check: Object.freeze({ status: 'unregistered' }),
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7311',
        `Claude Code did not register ${id} from ${JSON.stringify(pluginDirectory)}: ` +
          '`claude --plugin-dir <bundle-dir> plugin list --json` listed no row for it.',
        'error',
        target,
      )]),
    });
  }
  const errors = claudePluginRowErrors(row);
  if (errors.length === 0) return Object.freeze({ check: Object.freeze({ status: 'loaded' }), diagnostics: freezeDiagnostics([]) });
  // A declared `dependencies` entry the validating machine lacks is a property of this machine,
  // not of the artifact: Claude refuses the load here, and would load it where the dependency is
  // installed. Report it, but let the build finish unless `--strict` asked otherwise.
  const environmental = errors.every((error) => claudeMissingDependencyError.test(error));
  return Object.freeze({
    check: Object.freeze({ errors, status: 'refused' }),
    diagnostics: freezeDiagnostics([diagnostic(
      'AB7325',
      `Claude Code refused to load ${id} from ${JSON.stringify(pluginDirectory)} although ` +
        `\`plugin validate --strict\` accepted it` +
        `${environmental ? ' (a declared dependency is not installed on this machine)' : ''}; ` +
        `the host reported: ${errors.join(' | ')}`,
      environmental && !strict ? 'warning' : 'error',
      target,
    )]),
  });
};

/** Claude Code 2.1.260: `Dependency "audit-logger@acme-shared" is not installed — run \`claude plugin install …\``. */
const claudeMissingDependencyError = /^Dependency "[^"]+" is not installed\b/u;
