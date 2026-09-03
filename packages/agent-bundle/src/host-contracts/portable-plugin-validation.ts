import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

import capabilityTable from '../adapters/capabilities/portable-1.0.0.json' with { type: 'json' };
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

const placeholderPattern = /\$\{PLUGIN_(?:ROOT|DATA)\}/u;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const loopbackIpv4Pattern = /^127(?:\.\d{1,3}){3}$/u;
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const displayPath = (root: string, path: string): string => relative(root, path).replaceAll('\\', '/');

const schemaVersion = (identifier: unknown): string | undefined =>
  typeof identifier === 'string' ? schemaVersionPattern.exec(identifier)?.[1] : undefined;

const fileKind = async (path: string): Promise<'directory' | 'file' | 'missing' | 'other'> => {
  try {
    const metadata = await stat(path);
    if (metadata.isDirectory()) return 'directory';
    if (metadata.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'ELOOP')) return 'missing';
    throw error;
  }
};

/**
 * §4.1 plugin-relative path: begins with `./`, resolves against the plugin
 * root, and stays inside it after lexical normalization. Filesystem symlink
 * containment is the separate §4.1 symlink lane.
 */
const pluginRelativeTarget = (pluginDirectory: string, value: string): string | undefined => {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0')) return undefined;
  const candidate = resolve(pluginDirectory, normalize(value));
  return isInsideOrEqual(pluginDirectory, candidate) ? candidate : undefined;
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
  for (const contract of pinnedDocumentContracts) {
    const file = join(pluginDirectory, contract.path);
    const kind = await fileKind(file);
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
    try {
      source = await readFile(file, 'utf8');
    } catch {
      diagnostics.push(diagnostic(
        'AB6035',
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
};

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

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  hostname === '::1' ||
  loopbackIpv4Pattern.test(hostname);

const remoteUrlDiagnostics = (
  serverName: string,
  url: unknown,
  target: string,
): readonly Diagnostic[] => {
  if (typeof url !== 'string') return Object.freeze([]);
  const location = `mcp.json/mcpServers/${serverName}/url`;
  if (placeholderPattern.test(url)) {
    return freezeDiagnostics([diagnostic(
      'AB6036',
      `${location} contains an Agent Plugins placeholder, but clients never expand placeholders in url (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    )]);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return freezeDiagnostics([diagnostic(
      'AB6036',
      `${location} must be an absolute HTTP or HTTPS URL (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    )]);
  }
  const diagnostics: Diagnostic[] = [];
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    diagnostics.push(diagnostic(
      'AB6036',
      `${location} must use the http or https scheme (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    ));
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    diagnostics.push(diagnostic(
      'AB6036',
      `${location} must not contain user information (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    ));
  }
  if (url.includes('#')) {
    diagnostics.push(diagnostic(
      'AB6036',
      `${location} must not contain a fragment (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    ));
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    diagnostics.push(diagnostic(
      'AB6036',
      `${location} uses plain HTTP against non-loopback host ${JSON.stringify(parsed.hostname)}; non-loopback endpoints must use HTTPS (Agent Plugins 1.0.0 §7.2.1).`,
      'error',
      target,
    ));
  }
  return freezeDiagnostics(diagnostics);
};

const headerDiagnostics = (
  serverName: string,
  headers: unknown,
  target: string,
): readonly Diagnostic[] => {
  if (!isRecord(headers)) return Object.freeze([]);
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const location = `mcp.json/mcpServers/${serverName}/headers/${name}`;
    if (!headerNamePattern.test(name)) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location} is not a valid HTTP header field name (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    }
    if (typeof value === 'string' && /[\r\n\0]/u.test(value)) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location} is not a valid HTTP header field value (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    }
    if (placeholderPattern.test(name) || (typeof value === 'string' && placeholderPattern.test(value))) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location} contains an Agent Plugins placeholder, but clients never expand placeholders in headers (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    }
    const folded = name.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location} repeats header ${JSON.stringify(previous)} under different casing; header names are case-insensitive (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    } else {
      seen.set(folded, name);
    }
  }
  return freezeDiagnostics(diagnostics);
};

const stdioDiagnostics = async (
  pluginDirectory: string,
  serverName: string,
  server: Readonly<Record<string, unknown>>,
  target: string,
): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const command = server['command'];
  const location = `mcp.json/mcpServers/${serverName}`;
  if (typeof command === 'string') {
    if (placeholderPattern.test(command)) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location}/command contains an Agent Plugins placeholder, but clients never expand placeholders in command (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    } else if (command.startsWith('./')) {
      const resolved = pluginRelativeTarget(pluginDirectory, command);
      if (resolved === undefined) {
        diagnostics.push(diagnostic(
          'AB6036',
          `${location}/command ${JSON.stringify(command)} escapes the plugin root (Agent Plugins 1.0.0 §4.1).`,
          'error',
          target,
        ));
      } else if ((await fileKind(resolved)) !== 'file') {
        diagnostics.push(diagnostic(
          'AB6036',
          `${location}/command ${JSON.stringify(command)} does not resolve to a bundled regular file (Agent Plugins 1.0.0 §7.2.1).`,
          'error',
          target,
        ));
      }
    } else if (/[\s/\\]/u.test(command) || isAbsolute(command) || command.startsWith('.')) {
      diagnostics.push(diagnostic(
        'AB6036',
        `${location}/command ${JSON.stringify(command)} is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).`,
        'error',
        target,
      ));
    }
  }
  const cwd = server['cwd'];
  if (typeof cwd === 'string') {
    const relativePart = cwd.startsWith('./')
      ? cwd
      : cwd.startsWith('${PLUGIN_ROOT}')
        ? `.${cwd.slice('${PLUGIN_ROOT}'.length)}`
        : cwd.startsWith('${PLUGIN_DATA}')
          ? `.${cwd.slice('${PLUGIN_DATA}'.length)}`
          : undefined;
    if (relativePart !== undefined) {
      const anchor = join(pluginDirectory, 'anchor');
      const candidate = resolve(anchor, normalize(relativePart === '.' ? './' : relativePart));
      if (!isInsideOrEqual(anchor, candidate)) {
        diagnostics.push(diagnostic(
          'AB6036',
          `${location}/cwd ${JSON.stringify(cwd)} escapes its ${cwd.startsWith('${PLUGIN_DATA}') ? 'plugin data directory' : 'plugin root'} after resolution (Agent Plugins 1.0.0 §7.2.1).`,
          'error',
          target,
        ));
      }
    }
  }
  const env = server['env'];
  if (isRecord(env)) {
    for (const key of Object.keys(env)) {
      if (!placeholderPattern.test(key)) continue;
      diagnostics.push(diagnostic(
        'AB6036',
        `${location}/env key ${JSON.stringify(key)} contains an Agent Plugins placeholder, but expansion never applies to env keys (Agent Plugins 1.0.0 §9.2).`,
        'error',
        target,
      ));
    }
  }
  return freezeDiagnostics(diagnostics);
};

const serverDiagnostics = async (
  pluginDirectory: string,
  documents: readonly ParsedDocument[],
  target: string,
): Promise<readonly Diagnostic[]> => {
  const mcp = documents.find((document) => document.path === 'mcp.json');
  if (mcp === undefined || !isRecord(mcp.value) || !isRecord(mcp.value['mcpServers'])) return Object.freeze([]);
  const diagnostics: Diagnostic[] = [];
  for (const [serverName, server] of Object.entries(mcp.value['mcpServers'])) {
    if (!isRecord(server)) continue;
    switch (server['type']) {
      case 'stdio':
        diagnostics.push(...await stdioDiagnostics(pluginDirectory, serverName, server, target));
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
};

const skillDiagnostics = async (
  pluginDirectory: string,
  target: string,
): Promise<readonly Diagnostic[]> => {
  const skillsRoot = join(pluginDirectory, 'skills');
  const kind = await fileKind(skillsRoot);
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
  const entries = (await readdir(skillsRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const skillDirectory = join(skillsRoot, entry.name);
    if ((await fileKind(skillDirectory)) !== 'directory') continue;
    const skillFile = join(skillDirectory, 'SKILL.md');
    if ((await fileKind(skillFile)) === 'file') continue;
    diagnostics.push(diagnostic(
      'AB6036',
      `skills/${entry.name} has no regular SKILL.md file, so clients skip it (Agent Plugins 1.0.0 §7.1).`,
      'error',
      target,
    ));
  }
  return freezeDiagnostics(diagnostics);
};

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
  const [documents, skills, symlinks] = await Promise.all([
    readDocuments(pluginDirectory, options.target),
    skillDiagnostics(pluginDirectory, options.target),
    symlinkDiagnostics(pluginDirectory, options.target),
  ]);
  return freezeDiagnostics([
    ...documents.diagnostics,
    ...versionAgreementDiagnostics(documents.documents, options.target),
    ...await serverDiagnostics(pluginDirectory, documents.documents, options.target),
    ...skills,
    ...symlinks,
  ]);
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
    ...await validatePortablePluginFiles({ pluginDirectory, target: options.target }),
  ]);
  return Object.freeze({
    diagnostics,
    host: 'portable',
    specificationVersion: capabilityTable.observedSpecificationVersion,
    status: diagnostics.some((entry) => entry.severity === 'error') ? 'failed' : 'passed',
    target: options.target,
  });
};