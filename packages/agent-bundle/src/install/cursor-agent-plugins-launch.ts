import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

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
  const original = expansion?.documents['mcp.json'];
  const documents = original === undefined ? undefined : Object.freeze({ 'mcp.json': original });
  const mcpPath = resolve(pluginRoot, 'mcp.json');
  // The Agent Plugins byte lane owns a missing, non-regular, or unparsable document.
  if ((await fileKind(mcpPath)) !== 'file') {
    return Object.freeze({ diagnostics: Object.freeze([]), ...(documents === undefined ? {} : { documents }) });
  }
  let document: unknown;
  try {
    document = JSON.parse(await readFile(mcpPath, 'utf8')) as unknown;
  } catch {
    return Object.freeze({ diagnostics: Object.freeze([]), ...(documents === undefined ? {} : { documents }) });
  }
  const servers = stdioServers(document);
  if (servers.length === 0) {
    return Object.freeze({ diagnostics: Object.freeze([]), ...(documents === undefined ? {} : { documents }) });
  }
  const names = Object.freeze(servers.map((server) => server.name));
  if (expansion === undefined) {
    // Without a recorded expansion, only servers that still rely on client-side resolution are a finding;
    // a copy expanded by other means (absolute paths, cwd, §9.1 variables in place) launches as it is.
    const unexpanded = servers
      .map((server) => ({ forms: unexpandedForms(server), name: server.name }))
      .filter((server) => server.forms.length > 0);
    if (unexpanded.length === 0) return Object.freeze({ diagnostics: Object.freeze([]) });
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
      launch: Object.freeze({ servers: names, state: 'unexpanded' }),
    });
  }
  const issues = await driftIssues(pluginRoot, expansion, servers, caseInsensitive);
  const launchBase = Object.freeze({ pluginData: expansion.pluginData, pluginRoot: expansion.pluginRoot, servers: names });
  if (issues.length > 0) {
    return Object.freeze({
      diagnostics: freezeDiagnostics([finding(
        `Cursor plugin entry ${JSON.stringify(pluginRoot)} recorded an Agent Plugins placeholder expansion that no longer describes the installed copy: ${issues.join('; ')}.`,
        `${REINSTALL_RECOVERY} A copy moved or edited after install must be reinstalled at its current location.`,
        'error',
      )]),
      ...(documents === undefined ? {} : { documents }),
      launch: Object.freeze({ ...launchBase, state: 'drifted' }),
    });
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics([finding(
      `Cursor plugin entry ${JSON.stringify(pluginRoot)} is an Agent Plugins package whose stdio server${servers.length === 1 ? '' : 's'} ` +
        `${names.map((name) => JSON.stringify(name)).join(', ')} were expanded for Cursor at install (provenance: derived; Cursor 3.18.25 expands no Agent Plugins placeholder itself): ` +
        `PLUGIN_ROOT=${JSON.stringify(expansion.pluginRoot)}, PLUGIN_DATA=${JSON.stringify(expansion.pluginData)}; every expanded path resolves and the pre-expansion mcp.json is validated against the Agent Plugins 1.0.0 contract.`,
      'No action needed; reinstall with the emitted `install.mjs` after moving the copy.',
      'info',
    )]),
    ...(documents === undefined ? {} : { documents }),
    launch: Object.freeze({ ...launchBase, state: 'expanded' }),
  });
};
