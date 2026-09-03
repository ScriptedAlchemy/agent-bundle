import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv/dist/ajv.js';
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
type DocumentKind = 'hooks' | 'manifest' | 'marketplace' | 'mcp';

const manifestPath = '.cursor-plugin/plugin.json';
const marketplacePath = '.cursor-plugin/marketplace.json';
const mcpPath = 'mcp.json';
/** Cursor's folder-discovery default for hooks, used only when the manifest declares no `hooks` field. */
export const cursorDefaultHooksPath = 'hooks/hooks.json';
const inlineHooksPath = `${manifestPath}#/hooks`;

/**
 * Where the pinned Cursor loader reads a plugin's hooks from, resolved from the
 * `.cursor-plugin/plugin.json` `hooks` field the way the loader does: a string
 * is a plugin-root-relative path that replaces folder discovery (so the default
 * `hooks/hooks.json` is not also scanned), an object is an inline hooks
 * document, and an absent field falls back to `hooks/hooks.json`. The unified
 * `plugin` target relies on the replacement: its Cursor manifest points at
 * `hooks/hooks-cursor.json` while `hooks/hooks.json` carries the Claude/Codex
 * document (#438).
 */
export type CursorHooksSource =
  | Readonly<{ readonly kind: 'default'; readonly path: typeof cursorDefaultHooksPath }>
  | Readonly<{
    /** The manifest string as written. */
    readonly declared: string;
    /** `false` when the declared path is absolute or walks above the plugin root. */
    readonly insidePluginRoot: boolean;
    readonly kind: 'file';
    /** Normalized plugin-root-relative POSIX path (`./hooks/x.json` -> `hooks/x.json`). */
    readonly path: string;
  }>
  | Readonly<{ readonly kind: 'inline'; readonly value: Readonly<Record<string, unknown>> }>
  /** `hooks` is present but neither a string nor an object; the pinned plugin schema already rejects it. */
  | Readonly<{ readonly kind: 'invalid' }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const resolveCursorHooksSource = (manifest: unknown): CursorHooksSource => {
  const declared = isRecord(manifest) ? manifest['hooks'] : undefined;
  if (declared === undefined) return Object.freeze({ kind: 'default', path: cursorDefaultHooksPath });
  if (typeof declared === 'string') {
    const slashed = declared.replaceAll('\\', '/');
    const absolute = isAbsolute(declared) || posix.isAbsolute(slashed) || /^[A-Za-z]:\//u.test(slashed);
    const path = posix.normalize(slashed).replace(/^(?:\.\/)+/u, '');
    const escapes = path === '..' || path.startsWith('../');
    return Object.freeze({
      declared,
      insidePluginRoot: !absolute && !escapes && path.length > 0 && path !== '.',
      kind: 'file',
      path,
    });
  }
  if (isRecord(declared)) return Object.freeze({ kind: 'inline', value: declared });
  return Object.freeze({ kind: 'invalid' });
};

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

export interface ValidateCursorPluginFilesOptions {
  readonly containmentRoot?: string;
  readonly pluginDirectory: string;
  readonly target: string;
}

interface CursorProbe {
  readonly diagnostics: readonly Diagnostic[];
  readonly unavailable: boolean;
  readonly version?: string;
}

interface ParsedDocument {
  readonly kind: DocumentKind;
  /** Plugin-root-relative display path; `.cursor-plugin/plugin.json#/hooks` for an inline hooks object. */
  readonly path: string;
  readonly value: unknown;
}

interface DocumentContract {
  readonly kind: DocumentKind;
  readonly path: string;
  /** Present-or-error: `.cursor-plugin/plugin.json` always, plus a hooks file the manifest explicitly declares. */
  readonly required: boolean;
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

const validators = Object.freeze({
  hooks: schemaValidator.compile(hooksSchema),
  manifest: schemaValidator.compile(pluginSchema),
  marketplace: schemaValidator.compile(marketplaceSchema),
  mcp: schemaValidator.compile(mcpSchema),
});

const validatorFor = (kind: DocumentKind): ValidateFunction => {
  switch (kind) {
    case 'hooks':
      return validators.hooks;
    case 'manifest':
      return validators.manifest;
    case 'marketplace':
      return validators.marketplace;
    case 'mcp':
      return validators.mcp;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unexpected Cursor document kind: ${String(exhaustive)}`);
    }
  }
};

/** The documents every generated Cursor bundle is checked for; the hooks document is added once the manifest names it. */
const fixedDocumentContracts: readonly DocumentContract[] = Object.freeze([
  Object.freeze({ kind: 'marketplace' as const, path: marketplacePath, required: false }),
  Object.freeze({ kind: 'manifest' as const, path: manifestPath, required: true }),
  Object.freeze({ kind: 'mcp' as const, path: mcpPath, required: false }),
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

const schemaErrorMessage = (path: string, error: ErrorObject): string => {
  const location = error.instancePath.length === 0 ? '/' : error.instancePath;
  return `${path}${location}: ${error.message ?? 'schema validation failed'}.`;
};

interface DocumentReadResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: ParsedDocument;
}

const schemaDiagnostics = (document: ParsedDocument, target: string): readonly Diagnostic[] => {
  const validate = validatorFor(document.kind);
  if (validate(document.value)) return Object.freeze([]);
  return freezeDiagnostics((validate.errors ?? []).map((error) => diagnostic(
    'AB6027',
    schemaErrorMessage(document.path, error),
    'error',
    target,
  )));
};

const readDocument = async (
  pluginDirectory: string,
  contract: DocumentContract,
  missingMessage: string,
  target: string,
): Promise<DocumentReadResult> => {
  const file = join(pluginDirectory, contract.path);
  let source: string;
  try {
    // `stat` first: `readFile` on a FIFO or device would block until a writer appears.
    if (!(await stat(file)).isFile()) throw new Error(`${contract.path} is not a regular file`);
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      if (!contract.required) return Object.freeze({ diagnostics: Object.freeze([]) });
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic('AB6027', missingMessage, 'error', target)]),
      });
    }
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6027',
        `${contract.path} could not be read for pinned-schema validation.`,
        'error',
        target,
      )]),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic('AB6027', `${contract.path} is not valid JSON.`, 'error', target)]),
    });
  }
  const document: ParsedDocument = Object.freeze({ kind: contract.kind, path: contract.path, value });
  return Object.freeze({ diagnostics: schemaDiagnostics(document, target), document });
};

/**
 * The hooks document is the one the manifest names (or the folder-discovery
 * default when it names none), validated with the pinned Cursor hooks schema.
 * A declared file that is missing is an error: the loader would deliver no
 * hooks even though the bundle promised them.
 */
const readHooksDocument = async (
  pluginDirectory: string,
  manifest: ParsedDocument | undefined,
  target: string,
): Promise<DocumentReadResult> => {
  const source = resolveCursorHooksSource(manifest?.value);
  switch (source.kind) {
    case 'default':
      return readDocument(
        pluginDirectory,
        Object.freeze({ kind: 'hooks', path: source.path, required: false }),
        `${source.path} is missing.`,
        target,
      );
    case 'file': {
      if (!source.insidePluginRoot) {
        return Object.freeze({
          diagnostics: freezeDiagnostics([diagnostic(
            'AB6027',
            `${manifestPath} declares hooks at ${JSON.stringify(source.declared)}, which does not resolve inside the plugin root; ` +
              'generated Cursor bundles keep the hooks document under the plugin root.',
            'error',
            target,
          )]),
        });
      }
      return readDocument(
        pluginDirectory,
        Object.freeze({ kind: 'hooks', path: source.path, required: true }),
        `${manifestPath} declares hooks at ${JSON.stringify(source.declared)} but ${source.path} is missing from the Cursor bundle; ` +
          'Cursor would load no hooks for it.',
        target,
      );
    }
    case 'inline': {
      const document: ParsedDocument = Object.freeze({ kind: 'hooks', path: inlineHooksPath, value: source.value });
      return Object.freeze({ diagnostics: schemaDiagnostics(document, target), document });
    }
    case 'invalid':
      // The manifest schema already reports the malformed `hooks` field.
      return Object.freeze({ diagnostics: Object.freeze([]) });
    default: {
      const exhaustive: never = source;
      throw new Error(`Unexpected Cursor hooks source: ${String(exhaustive)}`);
    }
  }
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
  let manifest: ParsedDocument | undefined;
  for (const contract of fixedDocumentContracts) {
    const result = await readDocument(
      pluginDirectory,
      contract,
      `${contract.path} is required in a generated Cursor bundle.`,
      target,
    );
    diagnostics.push(...result.diagnostics);
    if (result.document === undefined) continue;
    documents.push(result.document);
    if (contract.kind === 'manifest') manifest = result.document;
  }
  const hooks = await readHooksDocument(pluginDirectory, manifest, target);
  diagnostics.push(...hooks.diagnostics);
  if (hooks.document !== undefined) documents.push(hooks.document);
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
  containmentRoot: string,
  target: string,
): Promise<readonly Diagnostic[]> => {
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(containmentRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze([]);
    return freezeDiagnostics([diagnostic(
      'AB6028',
      containmentRoot === pluginDirectory
        ? 'The Cursor bundle directory could not be resolved for symlink containment validation.'
        : `Cursor local plugin root ${JSON.stringify(containmentRoot)} could not be resolved for symlink containment validation.`,
      'error',
      target,
    )]);
  }
  const containmentLabel = containmentRoot === pluginDirectory
    ? 'the Cursor bundle directory'
    : `Cursor local plugin root ${JSON.stringify(containmentRoot)}`;
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
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const targetPath = await realpath(path);
          if (!isInsideOrEqual(rootRealPath, targetPath)) {
            diagnostics.push(diagnostic(
              'AB6028',
              `${displayPath(pluginDirectory, path)} is a symlink whose real target escapes ${containmentLabel}.`,
              'error',
              target,
            ));
          }
        } catch {
          diagnostics.push(diagnostic(
            'AB6028',
            `${displayPath(pluginDirectory, path)} is a symlink whose real target cannot be resolved inside ${containmentLabel}.`,
            'error',
            target,
          ));
        }
        continue;
      }
      if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(pluginDirectory);
  return freezeDiagnostics(diagnostics);
};

const isAllowedTokenLocation = (kind: DocumentKind, segments: readonly (number | string)[]): boolean => {
  if (kind === 'mcp' && segments[0] === 'mcpServers' && typeof segments[1] === 'string') {
    if (segments.length === 3) return segments[2] === 'command' || segments[2] === 'cwd' || segments[2] === 'url';
    if (segments.length === 4 && typeof segments[3] === 'number') return segments[2] === 'args';
    if (segments.length === 4 && typeof segments[3] === 'string') {
      return segments[2] === 'env' || segments[2] === 'headers';
    }
  }
  return kind === 'hooks' &&
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
  // An inline manifest `hooks` object is walked as its own hooks document, not as manifest metadata.
  const inlineHooks = document.kind === 'manifest' && isRecord(document.value) && isRecord(document.value['hooks']);
  const visit = (value: unknown, segments: readonly (number | string)[]): void => {
    if (inlineHooks && segments.length === 1 && segments[0] === 'hooks') return;
    if (typeof value === 'string') {
      if (value.includes(cursorPluginRootToken) && !isAllowedTokenLocation(document.kind, segments)) {
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

export const validateCursorPluginSymlinks = async (
  options: ValidateCursorPluginFilesOptions,
): Promise<readonly Diagnostic[]> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  return symlinkDiagnostics(
    pluginDirectory,
    resolve(options.containmentRoot ?? pluginDirectory),
    options.target,
  );
};

export const validateCursorPluginFiles = async (
  options: ValidateCursorPluginFilesOptions,
): Promise<readonly Diagnostic[]> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const [localDocuments, precedence, symlinks] = await Promise.all([
    readDocuments(pluginDirectory, options.target),
    manifestPrecedenceDiagnostics(pluginDirectory, options.target),
    validateCursorPluginSymlinks({
      ...(options.containmentRoot === undefined ? {} : { containmentRoot: options.containmentRoot }),
      pluginDirectory,
      target: options.target,
    }),
  ]);
  return freezeDiagnostics([
    ...localDocuments.diagnostics,
    ...precedence,
    ...symlinks,
    ...localDocuments.documents.flatMap((document) => tokenDiagnostics(document, options.target)),
  ]);
};

export const validateCursorPlugin = async (
  options: ValidateCursorPluginOptions,
): Promise<CursorPluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const executable = options.executable ?? 'cursor-agent';
  const run = options.run ?? runCursorCommand;
  const [probe, localDiagnostics] = await Promise.all([
    probeCursor(executable, dirname(pluginDirectory), run, options.target),
    validateCursorPluginFiles({ pluginDirectory, target: options.target }),
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
    ...localDiagnostics,
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
