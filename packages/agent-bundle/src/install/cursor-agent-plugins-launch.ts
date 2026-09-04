import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { portablePlaceholderPattern } from '../adapters/portable-mcp-rules.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import { readInstallReceipt, type InstallReceiptCursorExpansion } from './receipt.ts';

/**
 * Read-only Doctor proof that an Agent Plugins package installed under
 * `~/.cursor/plugins/local` can launch its stdio servers on Cursor (#426).
 *
 * Observed on Cursor 3.18.25 (docs/audits/2026-09-03-agent-plugins-cursor-ide-proof.md):
 * the loader spawns an Agent Plugins stdio server without expanding
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in `args`, `env` values or `cwd`,
 * without providing the reserved `PLUGIN_ROOT` / `PLUGIN_DATA` variables
 * (spec §9.1), with an omitted `cwd` defaulting to the home directory and
 * with plugin-relative `./` commands resolved against the workspace folder
 * (spec §7.2.1). The emitted `install.mjs` expands those forms itself in the
 * Cursor copy of `mcp.json` and records what it substituted in the install
 * receipt (`cursorExpansion`). Doctor reports `expanded` when the recorded
 * expansion still describes the installed copy, `drifted` when it does not
 * (moved, copied, or edited after install), and `unexpanded` when an Agent
 * Plugins install still carries the spec forms Cursor cannot launch.
 */

export type CursorAgentPluginsLaunchState = 'drifted' | 'expanded' | 'unexpanded';

export interface CursorAgentPluginsLaunch {
  readonly pluginData?: string;
  readonly pluginRoot?: string;
  /** stdio servers examined, in document order. */
  readonly servers: readonly string[];
  readonly state: CursorAgentPluginsLaunchState;
}

export interface CursorAgentPluginsLaunchInspection {
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The pre-expansion `mcp.json` the installer recorded, for the Agent Plugins
   * byte lane: the on-disk document is conformant only in that form.
   */
  readonly documents?: Readonly<{ readonly 'mcp.json': string }>;
  readonly launch?: CursorAgentPluginsLaunch;
}

export interface InspectCursorAgentPluginsLaunchOptions {
  /** Compare recorded and installed paths case-insensitively (Windows). */
  readonly caseInsensitivePaths?: boolean;
}

const DIAGNOSTIC_CODE = 'AB7325';
const REINSTALL_RECOVERY =
  "Reinstall the package with its bundle's emitted `install.mjs`, which expands the Agent Plugins placeholders for the Cursor copy " +
  '(absolute plugin root and data directory, plugin-root `cwd`, resolved `./` command, `PLUGIN_ROOT`/`PLUGIN_DATA` environment) and records them in the receipt.';

const finding = (message: string, recovery: string, severity: Diagnostic['severity']): Diagnostic =>
  Object.freeze({ code: DIAGNOSTIC_CODE, message, recovery, severity, target: 'cursor' });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type FileKind = 'directory' | 'file' | 'missing' | 'other';

const fileKind = async (path: string): Promise<FileKind> => {
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

interface StdioServer {
  readonly args: readonly unknown[];
  readonly command: unknown;
  readonly cwd: unknown;
  readonly env: Readonly<Record<string, unknown>>;
  readonly name: string;
}

const stdioServers = (document: unknown): readonly StdioServer[] => {
  if (!isRecord(document) || !isRecord(document['mcpServers'])) return Object.freeze([]);
  const servers: StdioServer[] = [];
  for (const [name, server] of Object.entries(document['mcpServers'])) {
    if (!isRecord(server) || server['type'] !== 'stdio') continue;
    servers.push(Object.freeze({
      args: Array.isArray(server['args']) ? Object.freeze([...server['args']]) : Object.freeze([]),
      command: server['command'],
      cwd: server['cwd'],
      env: isRecord(server['env']) ? server['env'] : Object.freeze({}),
      name,
    }));
  }
  return Object.freeze(servers);
};

const hasPlaceholder = (value: unknown): boolean => typeof value === 'string' && portablePlaceholderPattern.test(value);

/** The spec forms an unexpanded server relies on, as Cursor 3.18.25 leaves them. */
const unexpandedForms = (server: StdioServer): readonly string[] => {
  const forms: string[] = [];
  if (typeof server.command === 'string' && server.command.startsWith('./')) {
    forms.push('plugin-relative `./` command resolved against the workspace folder instead of the plugin root (spec §7.2.1)');
  }
  const placeholderFields: string[] = [];
  if (hasPlaceholder(server.command)) placeholderFields.push('command');
  if (server.args.some(hasPlaceholder)) placeholderFields.push('args');
  if (Object.values(server.env).some(hasPlaceholder)) placeholderFields.push('env');
  if (hasPlaceholder(server.cwd)) placeholderFields.push('cwd');
  if (placeholderFields.length > 0) {
    forms.push(`\${PLUGIN_ROOT}/\${PLUGIN_DATA} left unexpanded in ${placeholderFields.join(', ')} (spec §9.2)`);
  }
  if (server.cwd === undefined) {
    forms.push('omitted `cwd` defaulted to the home directory instead of the plugin root (spec §7.2.1)');
  } else if (typeof server.cwd === 'string' && server.cwd.startsWith('./')) {
    forms.push('plugin-relative `./` cwd not resolved against the plugin root (spec §7.2.1)');
  }
  if (typeof server.env['PLUGIN_ROOT'] !== 'string' || typeof server.env['PLUGIN_DATA'] !== 'string') {
    forms.push('reserved `PLUGIN_ROOT`/`PLUGIN_DATA` variables not provided to the subprocess (spec §9.1)');
  }
  return Object.freeze(forms);
};

const samePath = (left: string, right: string, caseInsensitive: boolean): boolean => {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

const isUnder = (path: string, root: string, caseInsensitive: boolean): boolean => {
  const normalize = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const resolvedRoot = normalize(resolve(root));
  const resolvedPath = normalize(resolve(path));
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`);
};

/** Every way the installed copy no longer matches what the receipt says was expanded for it. */
const driftIssues = async (
  pluginRoot: string,
  expansion: InstallReceiptCursorExpansion,
  servers: readonly StdioServer[],
  caseInsensitive: boolean,
): Promise<readonly string[]> => {
  const issues: string[] = [];
  if (!samePath(expansion.pluginRoot, pluginRoot, caseInsensitive)) {
    issues.push(`the receipt expanded PLUGIN_ROOT to ${JSON.stringify(expansion.pluginRoot)} but the package is installed at ${JSON.stringify(pluginRoot)}`);
  }
  if (!isAbsolute(expansion.pluginData)) {
    issues.push(`the receipt records a relative PLUGIN_DATA ${JSON.stringify(expansion.pluginData)}`);
  } else if ((await fileKind(expansion.pluginData)) !== 'directory') {
    issues.push(`the PLUGIN_DATA directory ${JSON.stringify(expansion.pluginData)} does not exist`);
  }
  for (const server of servers) {
    const at = (field: string): string => `mcpServers/${server.name}/${field}`;
    if (hasPlaceholder(server.command) || server.args.some(hasPlaceholder) || Object.values(server.env).some(hasPlaceholder) || hasPlaceholder(server.cwd)) {
      issues.push(`${at('')} still carries an Agent Plugins placeholder`);
    }
    if (typeof server.command === 'string') {
      if (server.command.startsWith('./')) {
        issues.push(`${at('command')} ${JSON.stringify(server.command)} was not resolved against the plugin root`);
      } else if (isAbsolute(server.command) && (await fileKind(server.command)) !== 'file') {
        issues.push(`${at('command')} ${JSON.stringify(server.command)} is not a regular file`);
      }
    }
    if (typeof server.cwd !== 'string' || !isAbsolute(server.cwd)) {
      issues.push(`${at('cwd')} is not an absolute directory`);
    } else if ((await fileKind(server.cwd)) !== 'directory') {
      issues.push(`${at('cwd')} ${JSON.stringify(server.cwd)} does not exist`);
    }
    for (const [index, argument] of server.args.entries()) {
      if (typeof argument !== 'string' || !isAbsolute(argument) || !isUnder(argument, expansion.pluginRoot, caseInsensitive)) continue;
      if ((await fileKind(argument)) === 'missing') {
        issues.push(`${at(`args/${String(index)}`)} ${JSON.stringify(argument)} does not exist under the plugin root`);
      }
    }
    if (server.env['PLUGIN_ROOT'] !== expansion.pluginRoot) {
      issues.push(`${at('env/PLUGIN_ROOT')} does not equal the expanded plugin root`);
    }
    if (server.env['PLUGIN_DATA'] !== expansion.pluginData) {
      issues.push(`${at('env/PLUGIN_DATA')} does not equal the expanded data directory`);
    }
  }
  return Object.freeze(issues);
};

/**
 * The expansion the emitted `install.mjs` performs, reproduced byte for byte
 * so Doctor can recompute what the Cursor copy of a recorded document must
 * hold. `undefined` when the document has no stdio server to expand. Any
 * change here must be mirrored in `surface.ts` (`expandAgentPluginsMcp`); the
 * Doctor test that installs through the real emitted installer pins the two.
 */
export const expandAgentPluginsMcpForCursor = (
  text: string,
  pluginRoot: string,
  pluginData: string,
): string | undefined => {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(document) || !isRecord(document['mcpServers'])) return undefined;
  const expandPlaceholders = (value: string): string =>
    value.replaceAll('${PLUGIN_ROOT}', pluginRoot).replaceAll('${PLUGIN_DATA}', pluginData);
  const expandPath = (value: string): string => (value.startsWith('./') ? join(pluginRoot, value.slice(2)) : expandPlaceholders(value));
  let expanded = false;
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(document['mcpServers'])) {
    if (!isRecord(server) || server['type'] !== 'stdio' || typeof server['command'] !== 'string') {
      servers[name] = server;
      continue;
    }
    expanded = true;
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(isRecord(server['env']) ? server['env'] : {})) {
      env[key] = typeof value === 'string' ? expandPlaceholders(value) : value;
    }
    env['PLUGIN_ROOT'] = pluginRoot;
    env['PLUGIN_DATA'] = pluginData;
    const args = server['args'];
    servers[name] = {
      ...server,
      command: expandPath(server['command']),
      ...(Array.isArray(args) ? { args: args.map((argument) => (typeof argument === 'string' ? expandPlaceholders(argument) : argument)) } : {}),
      cwd: typeof server['cwd'] === 'string' ? expandPath(server['cwd']) : pluginRoot,
      env,
    };
  }
  if (!expanded) return undefined;
  return `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`;
};

const readText = async (path: string): Promise<string | undefined> => {
  if ((await fileKind(path)) !== 'file') return undefined;
  return readFile(path, 'utf8');
};

const empty = (documents?: Readonly<{ readonly 'mcp.json': string }>): CursorAgentPluginsLaunchInspection =>
  Object.freeze({ diagnostics: Object.freeze([]), ...(documents === undefined ? {} : { documents }) });

export const inspectCursorAgentPluginsLaunch = async (
  pluginRoot: string,
  options: InspectCursorAgentPluginsLaunchOptions = {},
): Promise<CursorAgentPluginsLaunchInspection> => {
  const caseInsensitive = options.caseInsensitivePaths === true;
  let expansion: InstallReceiptCursorExpansion | undefined;
  try {
    expansion = (await readInstallReceipt(pluginRoot))?.cursorExpansion;
  } catch {
    // An unreadable or non-regular receipt is the install-comparison lane's finding; here it is simply absent.
    expansion = undefined;
  }
  const mcpPath = resolve(pluginRoot, 'mcp.json');
  const installedText = await readText(mcpPath);
  if (expansion === undefined) {
    // The Agent Plugins byte lane owns a missing, non-regular, or unparsable document.
    if (installedText === undefined) return empty();
    let document: unknown;
    try {
      document = JSON.parse(installedText) as unknown;
    } catch {
      return empty();
    }
    const servers = stdioServers(document);
    // Without a recorded expansion, only servers that still rely on client-side resolution are a finding;
    // a copy expanded by other means (absolute paths, cwd, §9.1 variables in place) launches as it is.
    const unexpanded = servers
      .map((server) => ({ forms: unexpandedForms(server), name: server.name }))
      .filter((server) => server.forms.length > 0);
    if (unexpanded.length === 0) return empty();
    const detail = unexpanded.map((server) => `${server.name}: ${server.forms.join('; ')}`).join(' | ');
    const unexpandedNames = unexpanded.map((server) => JSON.stringify(server.name)).join(', ');
    return Object.freeze({
      diagnostics: freezeDiagnostics([finding(
        `Cursor plugin entry ${JSON.stringify(pluginRoot)} is an Agent Plugins package whose stdio server${unexpanded.length === 1 ? '' : 's'} ` +
          `${unexpandedNames} depend on client-side Agent Plugins 1.0.0 resolution that Cursor 3.18.25 does not perform ` +
          `(observed 2026-09-03, docs/audits/2026-09-03-agent-plugins-cursor-ide-proof.md), so Cursor fails the spawn (\`spawn … ENOENT\` / MODULE_NOT_FOUND): ${detail}.`,
        REINSTALL_RECOVERY,
        'warning',
      )]),
      launch: Object.freeze({ servers: Object.freeze(servers.map((server) => server.name)), state: 'unexpanded' }),
    });
  }

  // A recorded expansion is proven, never trusted: the installed bytes must be exactly the expansion
  // of the recorded document, and only then is that document the one the Agent Plugins byte lane validates.
  const original = expansion.documents['mcp.json'];
  const expected = original === undefined ? undefined : expandAgentPluginsMcpForCursor(original, expansion.pluginRoot, expansion.pluginData);
  const drift = (issues: readonly string[], servers: readonly string[], documents?: Readonly<{ readonly 'mcp.json': string }>): CursorAgentPluginsLaunchInspection =>
    Object.freeze({
      diagnostics: freezeDiagnostics([finding(
        `Cursor plugin entry ${JSON.stringify(pluginRoot)} recorded an Agent Plugins placeholder expansion that no longer describes the installed copy: ${issues.join('; ')}.`,
        `${REINSTALL_RECOVERY} A copy moved or edited after install must be reinstalled at its current location.`,
        'error',
      )]),
      ...(documents === undefined ? {} : { documents }),
      launch: Object.freeze({ pluginData: expansion.pluginData, pluginRoot: expansion.pluginRoot, servers, state: 'drifted' }),
    });
  if (original === undefined || expected === undefined) {
    return drift(['the receipt records an expansion but no pre-expansion mcp.json with a stdio server to expand'], Object.freeze([]));
  }
  if (installedText === undefined) {
    return drift(['mcp.json is missing or not a regular file although the receipt recorded its expansion'], Object.freeze([]));
  }
  const documents = Object.freeze({ 'mcp.json': original });
  const servers = stdioServers(JSON.parse(expected) as unknown);
  const names = Object.freeze(servers.map((server) => server.name));
  if (installedText !== expected) {
    return drift(['the installed mcp.json is not the expansion of the recorded document (edited or replaced after install)'], names);
  }
  const issues = await driftIssues(pluginRoot, expansion, servers, caseInsensitive);
  if (issues.length > 0) return drift(issues, names, documents);
  return Object.freeze({
    diagnostics: freezeDiagnostics([finding(
      `Cursor plugin entry ${JSON.stringify(pluginRoot)} is an Agent Plugins package whose stdio server${servers.length === 1 ? '' : 's'} ` +
        `${names.map((name) => JSON.stringify(name)).join(', ')} were expanded for Cursor at install (provenance: derived; Cursor 3.18.25 expands no Agent Plugins placeholder itself): ` +
        `PLUGIN_ROOT=${JSON.stringify(expansion.pluginRoot)}, PLUGIN_DATA=${JSON.stringify(expansion.pluginData)}; the installed mcp.json is byte-identical to the expansion of the recorded document, every expanded path resolves, and the recorded document is validated against the Agent Plugins 1.0.0 contract.`,
      'No action needed; reinstall with the emitted `install.mjs` after moving the copy.',
      'info',
    )]),
    documents,
    launch: Object.freeze({ pluginData: expansion.pluginData, pluginRoot: expansion.pluginRoot, servers: names, state: 'expanded' }),
  });
};
