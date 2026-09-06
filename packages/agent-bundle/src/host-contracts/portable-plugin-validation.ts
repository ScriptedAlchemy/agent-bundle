import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { Effect, FileSystem, Option } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import capabilityTable from '../adapters/capabilities/portable-1.0.0.json' with { type: 'json' };
import {
  containedPortableRelativePath,
  portableCommandIssues,
  portableCwdIssues,
  portableEnvKeyIssues,
  portableHeaderIssues,
  portableRemoteUrlIssues,
  type PortableMcpRuleIssue,
} from '../adapters/portable-mcp-rules.ts';
import schemaProvenance from '../adapters/schemas/portable/PROVENANCE.json' with { type: 'json' };
import mcpSchema from '../adapters/schemas/portable/mcp.schema.json' with { type: 'json' };
import pluginSchema from '../adapters/schemas/portable/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  validateJsonSchemaDocument,
  type TargetArtifactDocumentValidator,
} from '../adapters/types.ts';
import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import { isPlatformErrno, readFileString, runWithPlatform } from '../effect/platform.ts';

/**
 * Agent Plugins 1.0.0 bytes-at-rest validation for the `portable` target.
 *
 * The standard publishes machine-readable schemas plus normative text that
 * the schemas cannot express (§4.1 containment, §7.2.1 command and URL forms,
 * §9.2 placeholder scope, §10.1 version agreement). The specification text is
 * authoritative when the two conflict (`PROVENANCE.json`
 * `normativeTextWinsOnConflict`), so this lane checks both. It reads bytes
 * only: no client CLI is spawned and nothing is repaired.
 */

type PortableDiagnosticCode = 'AB6035' | 'AB6036' | 'AB6037' | 'AB6038';
type DocumentPath = 'mcp.json' | 'plugin.json';

export type PortablePluginValidationStatus = 'failed' | 'passed';

export interface PortablePluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'portable';
  readonly specificationVersion: string;
  readonly status: PortablePluginValidationStatus;
  readonly target: string;
}

export interface ValidatePortablePluginFilesOptions {
  /**
   * Document text validated in place of the on-disk bytes, by plugin-relative
   * path. Doctor passes the pre-expansion `mcp.json` an emitted `install.mjs`
   * recorded for a Cursor copy, whose on-disk document carries the absolute
   * paths Cursor needs and is Agent Plugins-conformant only in this form.
   * The file must still exist as a regular file at the plugin root.
   */
  readonly documents?: Readonly<Partial<Record<DocumentPath, string>>>;
  readonly pluginDirectory: string;
  readonly target: string;
}

export type ValidatePortablePluginOptions = ValidatePortablePluginFilesOptions;

interface PinnedDocumentContract {
  readonly path: DocumentPath;
  readonly required: boolean;
  readonly validate: TargetArtifactDocumentValidator;
}

interface ParsedDocument {
  readonly path: DocumentPath;
  readonly value: unknown;
}

const schemaValidator = createAdapterValidator();
const pinnedDocumentContracts = Object.freeze<PinnedDocumentContract[]>([
  Object.freeze({
    path: 'plugin.json',
    required: true,
    validate: validateJsonSchemaDocument(schemaValidator.compile(pluginSchema)),
  }),
  Object.freeze({
    path: 'mcp.json',
    required: false,
    validate: validateJsonSchemaDocument(schemaValidator.compile(mcpSchema)),
  }),
]);

const schemaVersionPattern = /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\//u;

const recoveryFor = (code: PortableDiagnosticCode): string => {
  switch (code) {
    case 'AB6035':
      return 'Repair the generated Agent Plugins document so it satisfies the pinned 1.0.0 schema, then rebuild.';
    case 'AB6036':
      return 'Repair the generated portable layout or MCP entry to satisfy the Agent Plugins 1.0.0 normative text, then rebuild.';
    case 'AB6037':
      return 'Replace the escaping symlink with a file or a link that resolves inside the plugin root, then rebuild.';
    case 'AB6038':
      return 'Review the pinned Agent Plugins provenance before changing the local validator contract.';
    default: {
      const exhaustive: never = code;
      throw new Error(`Unexpected portable validator diagnostic code: ${String(exhaustive)}`);
    }
  }
};

const diagnostic = (
  code: PortableDiagnosticCode,
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

const displayPath = (root: string, path: string): string => relative(root, path).replaceAll('\\', '/');

const schemaVersion = (identifier: unknown): string | undefined =>
  typeof identifier === 'string' ? schemaVersionPattern.exec(identifier)?.[1] : undefined;

type FileKind = 'directory' | 'file' | 'missing' | 'other';

/** `stat` follows symlinks, as the §6.2 "resolves to a regular file" wording requires. */
const fileKind = Effect.fnUntraced(function* (path: string): Effect.fn.Return<FileKind, PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(path).pipe(
    Effect.map((metadata): FileKind =>
      metadata.type === 'Directory' ? 'directory' : metadata.type === 'File' ? 'file' : 'other'),
    Effect.catch((error) => isPlatformErrno(error, 'ENOENT', 'ENOTDIR', 'ELOOP')
      ? Effect.succeed<FileKind>('missing')
      : Effect.fail(error)),
  );
});

/**
 * §4.1 plugin-relative path: begins with `./` and stays inside the plugin root
 * after platform-independent lexical normalization (shared with the planner).
 * Filesystem symlink containment is the separate §4.1 symlink lane.
 */
const pluginRelativeTarget = (pluginDirectory: string, value: string): string | undefined => {
  if (!value.startsWith('./')) return undefined;
  const contained = containedPortableRelativePath(value);
  return contained === undefined ? undefined : join(pluginDirectory, contained);
};

interface ReadDocumentsResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly documents: readonly ParsedDocument[];
}

const readDocuments = Effect.fnUntraced(function* (
  pluginDirectory: string,
  target: string,
  overrides: Readonly<Partial<Record<DocumentPath, string>>>,
): Effect.fn.Return<ReadDocumentsResult, PlatformError, FileSystem.FileSystem> {
  const diagnostics: Diagnostic[] = [];
  const documents: ParsedDocument[] = [];
  for (const contract of pinnedDocumentContracts) {
    const file = join(pluginDirectory, contract.path);
    const kind = yield* fileKind(file);
    const override = overrides[contract.path];
    if (kind === 'missing') {
      if (contract.required) {
        diagnostics.push(diagnostic(
          'AB6035',
          `${contract.path} is required at the plugin root (Agent Plugins 1.0.0 §4.1).`,
          'error',
          target,
        ));
      }
      continue;
    }
    if (kind !== 'file') {
      diagnostics.push(diagnostic(
        contract.required ? 'AB6035' : 'AB6036',
        `${contract.path} is present but does not resolve to a regular file (Agent Plugins 1.0.0 §6.2).`,
        'error',
        target,
      ));
      continue;
    }
    let source: string;
    if (override !== undefined) {
      source = override;
    } else {
      const read = yield* readFileString(file).pipe(Effect.option);
      if (Option.isNone(read)) {
        diagnostics.push(diagnostic(
          'AB6035',
          `${contract.path} could not be read for pinned-schema validation.`,
          'error',
          target,
        ));
        continue;
      }
      source = read.value;
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      diagnostics.push(diagnostic('AB6035', `${contract.path} is not valid JSON.`, 'error', target));
      continue;
    }
    documents.push(Object.freeze({ path: contract.path, value }));
    for (const issue of contract.validate(value)) {
      diagnostics.push(diagnostic(
        'AB6035',
        `${contract.path}${issue.instancePath.length === 0 ? '/' : issue.instancePath}: ${issue.message}.`,
        'error',
        target,
      ));
    }
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(diagnostics),
    documents: Object.freeze(documents),
  });
});

const versionAgreementDiagnostics = (
  documents: readonly ParsedDocument[],
  target: string,
): readonly Diagnostic[] => {
  const plugin = documents.find((document) => document.path === 'plugin.json');
  const mcp = documents.find((document) => document.path === 'mcp.json');
  if (plugin === undefined || mcp === undefined || !isRecord(plugin.value) || !isRecord(mcp.value)) {
    return Object.freeze([]);
  }
  const pluginVersion = schemaVersion(plugin.value['$schema']);
  const mcpVersion = schemaVersion(mcp.value['$schema']);
  if (pluginVersion === undefined || mcpVersion === undefined || pluginVersion === mcpVersion) {
    return Object.freeze([]);
  }
  return freezeDiagnostics([diagnostic(
    'AB6036',
    `mcp.json declares Agent Plugins ${mcpVersion} while plugin.json declares ${pluginVersion}; the versions must agree (Agent Plugins 1.0.0 §10.1).`,
    'error',
    target,
  )]);
};

const ruleDiagnostics = (
  serverName: string,
  issues: readonly PortableMcpRuleIssue[],
  target: string,
): readonly Diagnostic[] => freezeDiagnostics(issues.map((entry) => diagnostic(
  'AB6036',
  `mcp.json/mcpServers/${serverName}/${entry.field} ${entry.message}.`,
  'error',
  target,
)));

const remoteUrlDiagnostics = (
  serverName: string,
  url: unknown,
  target: string,
): readonly Diagnostic[] => ruleDiagnostics(serverName, portableRemoteUrlIssues(url), target);

const headerDiagnostics = (
  serverName: string,
  headers: unknown,
  target: string,
): readonly Diagnostic[] => ruleDiagnostics(serverName, portableHeaderIssues(headers), target);

const stdioDiagnostics = Effect.fnUntraced(function* (
  pluginDirectory: string,
  serverName: string,
  server: Readonly<Record<string, unknown>>,
  target: string,
): Effect.fn.Return<readonly Diagnostic[], PlatformError, FileSystem.FileSystem> {
  const command = server['command'];
  const diagnostics: Diagnostic[] = [
    ...ruleDiagnostics(serverName, portableCommandIssues(command), target),
  ];
  // Only the byte lane can prove a plugin-relative command is a bundled regular file.
  if (typeof command === 'string' && command.startsWith('./') && diagnostics.length === 0) {
    const resolved = pluginRelativeTarget(pluginDirectory, command);
    if (resolved !== undefined && (yield* fileKind(resolved)) !== 'file') {
      diagnostics.push(diagnostic(
        'AB6036',
        `mcp.json/mcpServers/${serverName}/command ${JSON.stringify(command)} does not resolve to a bundled regular file (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    }
  }
  diagnostics.push(
    ...ruleDiagnostics(serverName, portableCwdIssues(server['cwd']), target),
    ...ruleDiagnostics(serverName, portableEnvKeyIssues(server['env']), target),
  );
  return freezeDiagnostics(diagnostics);
});

const serverDiagnostics = Effect.fnUntraced(function* (
  pluginDirectory: string,
  documents: readonly ParsedDocument[],
  target: string,
): Effect.fn.Return<readonly Diagnostic[], PlatformError, FileSystem.FileSystem> {
  const mcp = documents.find((document) => document.path === 'mcp.json');
  if (mcp === undefined || !isRecord(mcp.value) || !isRecord(mcp.value['mcpServers'])) return Object.freeze([]);
  const diagnostics: Diagnostic[] = [];
  for (const [serverName, server] of Object.entries(mcp.value['mcpServers'])) {
    if (!isRecord(server)) continue;
    switch (server['type']) {
      case 'stdio':
        diagnostics.push(...yield* stdioDiagnostics(pluginDirectory, serverName, server, target));
        break;
      case 'sse':
      case 'streamable-http':
        diagnostics.push(...remoteUrlDiagnostics(serverName, server['url'], target));
        diagnostics.push(...headerDiagnostics(serverName, server['headers'], target));
        break;
      default:
        // The pinned schema already rejects unknown variants (AB6035).
        break;
    }
  }
  return freezeDiagnostics(diagnostics);
});

const skillDiagnostics = Effect.fnUntraced(function* (
  pluginDirectory: string,
  target: string,
): Effect.fn.Return<readonly Diagnostic[], PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const skillsRoot = join(pluginDirectory, 'skills');
  const kind = yield* fileKind(skillsRoot);
  if (kind === 'missing') return Object.freeze([]);
  if (kind !== 'directory') {
    return freezeDiagnostics([diagnostic(
      'AB6036',
      'skills is present but does not resolve to a directory (Agent Plugins 1.0.0 §6.2).',
      'error',
      target,
    )]);
  }
  const diagnostics: Diagnostic[] = [];
  const entries = (yield* fs.readDirectory(skillsRoot))
    .sort((left, right) => left.localeCompare(right));
  for (const name of entries) {
    const skillDirectory = join(skillsRoot, name);
    if ((yield* fileKind(skillDirectory)) !== 'directory') continue;
    const skillFile = join(skillDirectory, 'SKILL.md');
    if ((yield* fileKind(skillFile)) === 'file') continue;
    diagnostics.push(diagnostic(
      'AB6036',
      `skills/${name} has no regular SKILL.md file, so clients skip it (Agent Plugins 1.0.0 §7.1).`,
      'error',
      target,
    ));
  }
  return freezeDiagnostics(diagnostics);
});

/**
 * The document, server, and skill lanes as one `FileSystem` program;
 * `validatePortablePluginFiles` runs it beside the raw symlink lane. Not
 * exported: an Effect-typed export would put `effect` on the public
 * declaration graph (`public-api.test.ts`).
 */
const portablePluginByteDiagnostics = Effect.fnUntraced(function* (
  pluginDirectory: string,
  target: string,
  overrides: Readonly<Partial<Record<DocumentPath, string>>>,
): Effect.fn.Return<readonly Diagnostic[], PlatformError, FileSystem.FileSystem> {
  const [documents, skills] = yield* Effect.all([
    readDocuments(pluginDirectory, target, overrides),
    skillDiagnostics(pluginDirectory, target),
  ], { concurrency: 'unbounded' });
  return freezeDiagnostics([
    ...documents.diagnostics,
    ...versionAgreementDiagnostics(documents.documents, target),
    ...yield* serverDiagnostics(pluginDirectory, documents.documents, target),
    ...skills,
  ]);
});

/**
 * Stays on `node:fs`: §4.1 containment is about link identity (`Dirent`
 * symlink types, `lstat` of the root), which the pinned `FileSystem` cannot
 * express — `stat` follows links and `readDirectory` returns names only.
 */
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
      'AB6037',
      'The portable plugin directory could not be resolved for symlink containment validation.',
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
        'AB6037',
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
              'AB6037',
              `${displayPath(pluginDirectory, path)} is a symlink whose real target escapes the plugin root (Agent Plugins 1.0.0 §4.1).`,
              'error',
              target,
            ));
          }
        } catch {
          diagnostics.push(diagnostic(
            'AB6037',
            `${displayPath(pluginDirectory, path)} is a symlink whose real target cannot be resolved inside the plugin root (Agent Plugins 1.0.0 §4.1).`,
            'error',
            target,
          ));
        }
        continue;
      }
      if (entry.isDirectory()) await visit(path);
    }
  };
  const rootMetadata = await lstat(pluginDirectory).catch(() => undefined);
  if (rootMetadata?.isDirectory() === true) await visit(pluginDirectory);
  return freezeDiagnostics(diagnostics);
};

/** Pure byte lane: pinned schemas, normative-text rules, and §4.1 symlink containment. */
export const validatePortablePluginFiles = async (
  options: ValidatePortablePluginFilesOptions,
): Promise<readonly Diagnostic[]> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const [bytes, symlinks] = await Promise.all([
    runWithPlatform(portablePluginByteDiagnostics(pluginDirectory, options.target, options.documents ?? {})),
    symlinkDiagnostics(pluginDirectory, options.target),
  ]);
  return freezeDiagnostics([...bytes, ...symlinks]);
};

export const validatePortablePlugin = async (
  options: ValidatePortablePluginOptions,
): Promise<PortablePluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const transparency = diagnostic(
    'AB6038',
    `Agent Plugins publishes no reference validator; this report validates local bytes against the ` +
      `${schemaProvenance.version} schemas pinned at ${schemaProvenance.specRepository.url}@` +
      `${schemaProvenance.specRepository.commit.slice(0, 9)} (retrieved ${schemaProvenance.retrievedAt}, ` +
      `re-verified ${schemaProvenance.reverifiedAt}) and the normative specification text.`,
    'info',
    options.target,
  );
  const diagnostics = freezeDiagnostics([
    transparency,
    ...await validatePortablePluginFiles({
      ...(options.documents === undefined ? {} : { documents: options.documents }),
      pluginDirectory,
      target: options.target,
    }),
  ]);
  return Object.freeze({
    diagnostics,
    host: 'portable',
    specificationVersion: capabilityTable.observedSpecificationVersion,
    status: diagnostics.some((entry) => entry.severity === 'error') ? 'failed' : 'passed',
    target: options.target,
  });
};