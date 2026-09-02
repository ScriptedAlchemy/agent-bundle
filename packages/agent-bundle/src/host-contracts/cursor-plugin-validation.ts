import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { Ajv, type ErrorObject } from 'ajv/dist/ajv.js';
import addFormats from 'ajv-formats';

import capabilityTable from '../adapters/capabilities/cursor-2026-08-28.json' with { type: 'json' };
import hooksSchema from '../adapters/schemas/cursor/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from '../adapters/schemas/cursor/marketplace.schema.json' with { type: 'json' };
import mcpSchema from '../adapters/schemas/cursor/mcp.schema.json' with { type: 'json' };
import pluginSchema from '../adapters/schemas/cursor/plugin.schema.json' with { type: 'json' };
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import {
  runBoundedChildProcess,
  type BoundedChildProcessRequest,
  type BoundedChildProcessResult,
} from './process.ts';

const maximumOutputBytes = 1024 * 1024;
const versionTimeoutMs = 5_000;
const cursorPluginRootToken = '${CURSOR_PLUGIN_ROOT}';
const pinnedCursorPluginCommit = '070189284e702e8a4d2e3cc8913994b204c5337a';
const manifestCandidates = Object.freeze([
  '.cursor-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
] as const);

type CursorPluginTermination = 'output-limit' | 'timed-out';
type CursorDiagnosticCode = 'AB6026' | 'AB6027' | 'AB6028' | 'AB6029';
type DocumentPath = '.cursor-plugin/marketplace.json' | '.cursor-plugin/plugin.json' | 'hooks/hooks.json' | 'mcp.json';

export type CursorPluginValidationStatus = 'failed' | 'passed' | 'unavailable' | 'warnings';

export interface CursorPluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'cursor';
  readonly status: CursorPluginValidationStatus;
  readonly target: string;
  readonly version?: string;
}

export type CursorPluginCommandResult = BoundedChildProcessResult<CursorPluginTermination>;

export type CursorPluginCommandRunner = (
  request: BoundedChildProcessRequest,
) => Promise<CursorPluginCommandResult>;

export interface ValidateCursorPluginOptions {
  readonly executable?: string;
  readonly pluginDirectory: string;
  /** Injectable proof seam. Production always uses the bounded process runner. */
  readonly run?: CursorPluginCommandRunner;
  readonly target: string;
}

interface CursorProbe {
  readonly diagnostics: readonly Diagnostic[];
  readonly unavailable: boolean;
  readonly version?: string;
}

interface ParsedDocument {
  readonly path: DocumentPath;
  readonly value: unknown;
}

const runCursorCommand: CursorPluginCommandRunner = (request) => runBoundedChildProcess(request, {
  labels: { outputLimit: 'output-limit', timedOut: 'timed-out' },
  maxOutputBytes: maximumOutputBytes,
  timeoutMs: versionTimeoutMs,
  windowsHide: true,
});

const installFormats = addFormats as unknown as (target: Ajv) => void;
const schemaValidator = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
installFormats(schemaValidator);

const documentContracts = Object.freeze([
  Object.freeze({
    path: '.cursor-plugin/marketplace.json' as const,
    required: false,
    validate: schemaValidator.compile(marketplaceSchema),
  }),
  Object.freeze({
    path: '.cursor-plugin/plugin.json' as const,
    required: true,
    validate: schemaValidator.compile(pluginSchema),
  }),
  Object.freeze({
    path: 'hooks/hooks.json' as const,
    required: false,
    validate: schemaValidator.compile(hooksSchema),
  }),
  Object.freeze({
    path: 'mcp.json' as const,
    required: false,
    validate: schemaValidator.compile(mcpSchema),
  }),
]);

const recoveryFor = (code: CursorDiagnosticCode, severity: DiagnosticSeverity): string => {
  switch (code) {
    case 'AB6026':
      return 'Review the pinned Cursor schema provenance before changing the local validator contract.';
    case 'AB6027':
      return 'Repair the generated Cursor JSON document so it satisfies the vendored pinned schema, then rebuild.';
    case 'AB6028':
      return 'Repair the generated Cursor layout, token locations, or symlinks to match the pinned loader evidence, then rebuild.';
    case 'AB6029':
      return severity === 'info'
        ? 'Install Cursor Agent and ensure `cursor-agent` is on PATH if local CLI version evidence is required.'
        : 'Verify `cursor-agent --version` completes successfully, then rerun artifact validation.';
    default: {
      const exhaustive: never = code;
      throw new Error(`Unexpected Cursor validator diagnostic code: ${String(exhaustive)}`);
    }
  }
};

const diagnostic = (
  code: CursorDiagnosticCode,
  message: string,
  severity: DiagnosticSeverity,
  target: string,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery: recoveryFor(code, severity),
  severity,
  target,
});

const versionFrom = (output: string): string | undefined =>
  /\b\d{4}\.\d{2}\.\d{2}-[0-9A-Za-z]+\b/u.exec(output)?.[0];

const probeCursor = async (
  executable: string,
  cwd: string,
  run: CursorPluginCommandRunner,
  target: string,
): Promise<CursorProbe> => {
  try {
    const result = await run(Object.freeze({
      args: Object.freeze(['--version']),
      cwd,
      executable,
    }));
    if (result.exitCode !== 0 || result.termination !== undefined) {
      const message = result.termination === 'timed-out'
        ? 'Cursor Agent version probe timed out.'
        : result.termination === 'output-limit'
          ? 'Cursor Agent version probe exceeded its output limit.'
          : `Cursor Agent version probe exited with code ${result.exitCode ?? 'unknown'}.`;
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic('AB6029', message, 'warning', target)]),
        unavailable: false,
      });
    }
    const version = versionFrom(`${result.stdout}\n${result.stderr}`);
    return Object.freeze({
      diagnostics: Object.freeze([]),
      unavailable: false,
      ...(version === undefined ? {} : { version }),
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6029',
          'Cursor Agent is not installed or is not on PATH; local pinned-schema validation still ran.',
          'info',
          target,
        )]),
        unavailable: true,
      });
    }
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6029',
        'Cursor Agent version probe could not be started; local pinned-schema validation still ran.',
        'warning',
        target,
      )]),
      unavailable: false,
    });
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

const schemaErrorMessage = (path: DocumentPath, error: ErrorObject): string => {
  const location = error.instancePath.length === 0 ? '/' : error.instancePath;
  return `${path}${location}: ${error.message ?? 'schema validation failed'}.`;
};

const readDocuments = async (
  pluginDirectory: string,
  target: string,
): Promise<Readonly<{
  readonly diagnostics: readonly Diagnostic[];
  readonly documents: readonly ParsedDocument[];
}>> => {
  const diagnostics: Diagnostic[] = [];
  const documents: ParsedDocument[] = [];
  for (const contract of documentContracts) {
    const file = join(pluginDirectory, contract.path);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        if (contract.required) {
          diagnostics.push(diagnostic(
            'AB6027',
            `${contract.path} is required in a generated Cursor bundle.`,
            'error',
            target,
          ));
        }
        continue;
      }
      diagnostics.push(diagnostic(
        'AB6027',
        `${contract.path} could not be read for pinned-schema validation.`,
        'error',
        target,
      ));
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      diagnostics.push(diagnostic(
        'AB6027',
        `${contract.path} is not valid JSON.`,
        'error',
        target,
      ));
      continue;
    }
    documents.push(Object.freeze({ path: contract.path, value }));
    if (contract.validate(value)) continue;
    diagnostics.push(...(contract.validate.errors ?? []).map((error) => diagnostic(
      'AB6027',
      schemaErrorMessage(contract.path, error),
      'error',
      target,
    )));
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(diagnostics),
    documents: Object.freeze(documents),
  });
};

const manifestPrecedenceDiagnostics = async (
  pluginDirectory: string,
  target: string,
): Promise<readonly Diagnostic[]> => {
  const present = await Promise.all(manifestCandidates.map(async (candidate) => ({
    candidate,
    exists: await pathExists(join(pluginDirectory, candidate)),
  })));
  const selected = present.find((entry) => entry.exists)?.candidate;
  if (selected === undefined || selected === manifestCandidates[0]) return Object.freeze([]);
  return freezeDiagnostics([diagnostic(
    'AB6028',
    `The pinned Cursor loader manifest precedence would select ${selected}; generated Cursor bundles require ${manifestCandidates[0]}.`,
    'error',
    target,
  )]);
};

const displayPath = (root: string, path: string): string => relative(root, path).replaceAll('\\', '/');

const symlinkDiagnostics = async (
  pluginDirectory: string,
  target: string,
): Promise<readonly Diagnostic[]> => {
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(pluginDirectory);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    return freezeDiagnostics([diagnostic(
      'AB6028',
      'The Cursor bundle directory could not be resolved for symlink containment validation.',
      'error',
      target,
    )]);
  }
  const diagnostics: Diagnostic[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      diagnostics.push(diagnostic(
        'AB6028',
        `${displayPath(pluginDirectory, directory)} could not be inspected for symlink containment.`,
        'error',
        target,
      ));
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const targetPath = await realpath(path);
          if (!isInsideOrEqual(rootRealPath, targetPath)) {
            diagnostics.push(diagnostic(
              'AB6028',
              `${displayPath(pluginDirectory, path)} is a symlink whose real target escapes the Cursor bundle directory.`,
              'error',
              target,
            ));
          }
        } catch {
          diagnostics.push(diagnostic(
            'AB6028',
            `${displayPath(pluginDirectory, path)} is a symlink whose real target cannot be resolved inside the Cursor bundle directory.`,
            'error',
            target,
          ));
        }
        return;
      }
      if (entry.isDirectory()) await visit(path);
    }));
  };
  await visit(pluginDirectory);
  return freezeDiagnostics(diagnostics);
};

const isAllowedTokenLocation = (path: DocumentPath, segments: readonly (number | string)[]): boolean => {
  if (path === 'mcp.json' && segments[0] === 'mcpServers' && typeof segments[1] === 'string') {
    if (segments.length === 3) return segments[2] === 'command' || segments[2] === 'cwd';
    if (segments.length === 4 && typeof segments[3] === 'number') return segments[2] === 'args';
    if (segments.length === 4 && typeof segments[3] === 'string') return segments[2] === 'env';
  }
  return path === 'hooks/hooks.json' &&
    segments.length === 4 &&
    segments[0] === 'hooks' &&
    typeof segments[1] === 'string' &&
    typeof segments[2] === 'number' &&
    segments[3] === 'command';
};

const tokenLocation = (segments: readonly (number | string)[]): string =>
  `/${segments.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;

const tokenDiagnostics = (
  document: ParsedDocument,
  target: string,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const visit = (value: unknown, segments: readonly (number | string)[]): void => {
    if (typeof value === 'string') {
      if (value.includes(cursorPluginRootToken) && !isAllowedTokenLocation(document.path, segments)) {
        diagnostics.push(diagnostic(
          'AB6028',
          `${document.path}${tokenLocation(segments)} uses CURSOR_PLUGIN_ROOT where the pinned Cursor loader does not substitute CURSOR_PLUGIN_ROOT.`,
          'error',
          target,
        ));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { visit(entry, [...segments, index]); });
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    Object.entries(value).forEach(([key, entry]) => { visit(entry, [...segments, key]); });
  };
  visit(document.value, []);
  return freezeDiagnostics(diagnostics);
};

export const validateCursorPlugin = async (
  options: ValidateCursorPluginOptions,
): Promise<CursorPluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const executable = options.executable ?? 'cursor-agent';
  const run = options.run ?? runCursorCommand;
  const [probe, localDocuments, precedence, symlinks] = await Promise.all([
    probeCursor(executable, dirname(pluginDirectory), run, options.target),
    readDocuments(pluginDirectory, options.target),
    manifestPrecedenceDiagnostics(pluginDirectory, options.target),
    symlinkDiagnostics(pluginDirectory, options.target),
  ]);
  const transparency = diagnostic(
    'AB6026',
    `Cursor publishes no plugin-validate devtools verb; this report validates local bytes against schemas pinned at cursor/plugins@${pinnedCursorPluginCommit} (${capabilityTable.provenance.observedAt} evidence).`,
    'info',
    options.target,
  );
  const diagnostics = freezeDiagnostics([
    transparency,
    ...probe.diagnostics,
    ...localDocuments.diagnostics,
    ...precedence,
    ...symlinks,
    ...localDocuments.documents.flatMap((document) => tokenDiagnostics(document, options.target)),
  ]);
  const failed = diagnostics.some((entry) => entry.severity === 'error');
  const warnings = diagnostics.some((entry) => entry.severity === 'warning');
  const status: CursorPluginValidationStatus = failed
    ? 'failed'
    : warnings
      ? 'warnings'
      : probe.unavailable
        ? 'unavailable'
        : 'passed';
  return Object.freeze({
    diagnostics,
    host: 'cursor',
    status,
    target: options.target,
    ...(probe.version === undefined ? {} : { version: probe.version }),
  });
};
