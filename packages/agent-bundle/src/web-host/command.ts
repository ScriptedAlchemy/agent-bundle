import type { McpAppConsentCapability, McpAppJsonValue, McpAppProfileId } from '../contracts/mcp-apps.ts';
import { stableJson } from '../core/digest.ts';
import { CodedError, errorMessage } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { MCP_APP_PROFILE_DESCRIPTORS } from '../dev/mcp-app-profile-descriptors.ts';
import {
  formatServeAppReadyLine,
  isServeAppAllowCapability,
  serveAppAllowCapabilities,
  type ServeAppAllowCapability,
} from '../serve-app/command-contract.ts';
import { startWebHost, type WebHost } from './host-server.ts';
import { resolveWebLaunch } from './launch.ts';
import {
  readWebManifestDocument,
  type ArtifactManifestLaunch,
  type WebManifest,
  type WebManifestApp,
  type WebManifestDocument,
} from './manifest.ts';
import { openApp, parseAppSelector, requireJsonObject, type AppSelector } from './select-app.ts';
import { openStdioAppSession, type StdioAppSession } from './session.ts';

/** Plain Node entry bundled into generated executables; do not import Effect or compiler modules (#564). */
export interface WebCommandOptions {
  readonly argv: readonly string[];
  readonly manifestPath: string;
  readonly name?: string;
  readonly pageScript: string;
  readonly pluginRoot: string;
  readonly signal: AbortSignal;
  readonly writeErr: (text: string) => void;
  readonly writeOut: (text: string) => void;
}

export interface WebCommandRuntime {
  readonly openApp: typeof openApp;
  readonly openStdioAppSession: typeof openStdioAppSession;
  readonly readWebManifestDocument: typeof readWebManifestDocument;
  readonly resolveWebLaunch: typeof resolveWebLaunch;
  readonly startWebHost: typeof startWebHost;
}

const webCommandRuntime: WebCommandRuntime = Object.freeze({
  openApp,
  openStdioAppSession,
  readWebManifestDocument,
  resolveWebLaunch,
  startWebHost,
});

export type WebCommandErrorCode =
  | 'app-ambiguous'
  | 'app-not-exposed'
  | 'manifest-invalid'
  | 'manifest-missing'
  | 'server-exited'
  | 'usage'
  | 'web-missing';

export class WebCommandError extends CodedError<WebCommandErrorCode> {
  constructor(code: WebCommandErrorCode, message: string, options?: ErrorOptions) {
    super('WebCommandError', code, message, options);
  }
}

const exitCodeOf = (code: WebCommandErrorCode): number => {
  switch (code) {
    case 'app-ambiguous':
    case 'app-not-exposed':
    case 'usage':
      return 2;
    case 'manifest-invalid':
    case 'manifest-missing':
    case 'server-exited':
    case 'web-missing':
      return 1;
    default: {
      const unreachable: never = code;
      throw new TypeError(`Unhandled web command error code ${String(unreachable)}.`);
    }
  }
};

const sessionTimeoutMs = 30_000;
const stderrTailChars = 4096;

const webProfiles = Object.freeze(Object.keys(MCP_APP_PROFILE_DESCRIPTORS)) as readonly McpAppProfileId[];

const isWebProfile = (value: string): value is McpAppProfileId => (webProfiles as readonly string[]).includes(value);

const commandName = (name: string | undefined): string => `${name ?? '<plugin>'} web`;

export const webUsageLine = (name: string | undefined): string =>
  `Usage: ${commandName(name)} [<server>/<app>] [options]`;

const columns = (rows: readonly (readonly [string, string])[]): string => {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0);
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join('\n');
};

export const webHelp = (name: string | undefined): string => [
  webUsageLine(name),
  '',
  "Open one of the plugin's MCP Apps in a browser.",
  '',
  'Arguments:',
  columns([[
    '[<server>/<app>]',
    'The exposed App to open; <server>/ui://... selects it by resource URI. Defaults to the only exposed App.',
  ]]),
  '',
  'Options:',
  columns([
    ['    --port <number>', 'Loopback TCP port of the host page; 0 picks a free one. [default: 0]'],
    ['    --open', 'Open the default browser once the host is listening.'],
    ['    --no-open', "Do not open a browser, whatever the manifest's web.open says."],
    ['    --tool <name>', 'The tool whose result opens the App. [default: the configured tool, else the only tool that opens the App]'],
    ['    --input <json>', 'Arguments of the opening tool call, as one JSON object. [default: the configured input]'],
    [
      '    --allow <capability> ...',
      `Approve a consent capability as the App requests it; repeatable. One of: ${serveAppAllowCapabilities.join(', ')}.`,
    ],
    [`    --profile <${webProfiles.join('|')}>`, 'The simulated MCP Apps host profile. [default: "portable"]'],
    ['    --json', 'Print one JSON line describing the host instead of the ready line.'],
    ['-h, --help', 'Show help.'],
  ]),
  '',
].join('\n');

interface WebArgv {
  readonly allow: readonly ServeAppAllowCapability[];
  readonly help: boolean;
  readonly input?: Readonly<Record<string, McpAppJsonValue>>;
  readonly json: boolean;
  readonly open?: boolean;
  readonly port?: number;
  readonly profile?: McpAppProfileId;
  readonly selector?: string;
  readonly tool?: string;
}

const usage = (message: string): WebCommandError => new WebCommandError('usage', message);

const parsePort = (value: string): number => {
  const port = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw usage(`--port requires a TCP port number (0-65535); got ${JSON.stringify(value)}.`);
  }
  return port;
};

const parseInput = (value: string): Readonly<Record<string, McpAppJsonValue>> => {
  let parsed;
  try {
    parsed = parseJsonWithoutDuplicateKeys(value);
  } catch {
    throw usage('--input must be one valid JSON object.');
  }
  try {
    return requireJsonObject(parsed, 'MCP App tool input');
  } catch {
    throw usage('--input must be a JSON object; arrays, null, and scalar values are not accepted.');
  }
};

const parseAllow = (value: string): ServeAppAllowCapability => {
  if (!isServeAppAllowCapability(value)) {
    throw usage(`--allow must be one of: ${serveAppAllowCapabilities.join(', ')}; got ${JSON.stringify(value)}.`);
  }
  return value;
};

const parseProfile = (value: string): McpAppProfileId => {
  if (!isWebProfile(value)) throw usage(`--profile must be one of: ${webProfiles.join(', ')}; got ${JSON.stringify(value)}.`);
  return value;
};

export const parseWebArgv = (argv: readonly string[]): WebArgv => {
  if (argv.includes('--help') || argv.includes('-h')) return { allow: [], help: true, json: false };
  const allow: ServeAppAllowCapability[] = [];
  const seen = new Set<string>();
  let json = false;
  let input: WebArgv['input'];
  let open: boolean | undefined;
  let port: number | undefined;
  let profile: McpAppProfileId | undefined;
  let selector: string | undefined;
  let tool: string | undefined;
  const once = (name: string): void => {
    if (seen.has(name)) throw usage(`Duplicate option: --${name}.`);
    seen.add(name);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith('-') || raw === '-') {
      if (selector !== undefined) throw usage(`Unexpected argument: ${JSON.stringify(raw)}.`);
      selector = raw;
      continue;
    }
    if (!raw.startsWith('--')) throw usage(`Unknown option: ${raw}.`);
    const separator = raw.indexOf('=');
    const name = separator === -1 ? raw.slice(2) : raw.slice(2, separator);
    const inline = separator === -1 ? undefined : raw.slice(separator + 1);
    const flag = (): void => {
      if (inline !== undefined) throw usage(`--${name} is a flag and takes no value.`);
      once(name);
    };
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw usage(`--${name} requires a value.`);
      index += 1;
      return next;
    };
    switch (name) {
      case 'json':
        flag();
        json = true;
        break;
      case 'open':
        flag();
        if (open === false) throw usage('Use either --open or --no-open, not both.');
        open = true;
        break;
      case 'no-open':
        flag();
        if (open === true) throw usage('Use either --open or --no-open, not both.');
        open = false;
        break;
      case 'port':
        once(name);
        port = parsePort(value());
        break;
      case 'tool':
        once(name);
        tool = value();
        break;
      case 'input':
        once(name);
        input = parseInput(value());
        break;
      case 'profile':
        once(name);
        profile = parseProfile(value());
        break;
      case 'allow': {
        const capability = parseAllow(value());
        if (!allow.includes(capability)) allow.push(capability);
        break;
      }
      default:
        throw usage(`Unknown option: --${name}.`);
    }
  }
  return {
    allow,
    help: false,
    ...(input === undefined ? {} : { input }),
    json,
    ...(open === undefined ? {} : { open }),
    ...(port === undefined ? {} : { port }),
    ...(profile === undefined ? {} : { profile }),
    ...(selector === undefined ? {} : { selector }),
    ...(tool === undefined ? {} : { tool }),
  };
};

const manifestRequirement = (name: string | undefined): string =>
  `agent-bundle.manifest.json with a web section is required beside bin/; run ${commandName(name)} from the built artifact or the installed plugin root.`;

interface ExposedApps {
  readonly launches: WebManifestDocument['launches'];
  readonly manifestPath: string;
  readonly web: WebManifest;
}

const readExposedApps = async (
  runtime: WebCommandRuntime,
  manifestPath: string,
  name: string | undefined,
): Promise<ExposedApps> => {
  if (!(await exists(manifestPath))) {
    throw new WebCommandError('manifest-missing', `${manifestRequirement(name)} (No manifest at ${manifestPath}.)`);
  }
  let document: WebManifestDocument;
  try {
    document = await runtime.readWebManifestDocument(manifestPath);
  } catch (error) {
    throw new WebCommandError('manifest-invalid', `Cannot read the web section of ${manifestPath}: ${errorMessage(error)}`, { cause: error });
  }
  if (document.web === undefined) {
    throw new WebCommandError(
      'web-missing',
      `${manifestRequirement(name)} (${manifestPath} has no web section: configure web.apps and rebuild.)`,
    );
  }
  if (document.web.apps.length === 0) {
    throw new WebCommandError(
      'web-missing',
      `${manifestRequirement(name)} (The web section of ${manifestPath} exposes no App: configure web.apps and rebuild.)`,
    );
  }
  return { launches: document.launches, manifestPath, web: document.web };
};

/** The App's server launch: the manifest's one record of what `<plugin> web` starts. */
const launchOf = (exposed: ExposedApps, app: WebManifestApp): ArtifactManifestLaunch => {
  const launch = exposed.launches.get(app.server);
  if (launch === undefined) {
    throw new WebCommandError(
      'manifest-invalid',
      `${exposed.manifestPath} exposes ${app.app}, but executables.mcpServers has no compiled launch record for server ${JSON.stringify(app.server)}; rebuild the plugin.`,
    );
  }
  return launch;
};

const exposedList = (apps: readonly WebManifestApp[]): string => apps.map((app: WebManifestApp) => app.app).join(', ');

/**
 * Whether a selector names an exposed App. The server part may be the
 * configured server id (`app.app` is `<server>/<app>` as configured, which
 * is what the ready line and the ambiguity listing print) or the server's
 * name (what `mcp run` and the ready line's tool call use); the App part is
 * the App name, or its exact `ui://` resource URI.
 */
const appMatches = (app: WebManifestApp, selector: AppSelector): boolean => {
  const configuredServer = app.app.slice(0, Math.max(0, app.app.indexOf('/')));
  if (selector.server !== app.server && selector.server !== configuredServer) return false;
  return selector.resourceUri === undefined ? selector.name === app.name : selector.resourceUri === app.resourceUri;
};

const pickApp = (manifest: WebManifest, selector: string | undefined): WebManifestApp => {
  const { apps } = manifest;
  if (selector === undefined) {
    if (apps.length === 1) return apps[0]!;
    throw new WebCommandError('app-ambiguous', `Several MCP Apps are exposed; name one: ${exposedList(apps)}.`);
  }
  let parsed: AppSelector;
  try {
    parsed = parseAppSelector(selector);
  } catch (error) {
    throw usage(errorMessage(error));
  }
  const matching = apps.filter((app: WebManifestApp) => appMatches(app, parsed));
  if (matching.length === 1) return matching[0]!;
  if (matching.length === 0) {
    throw new WebCommandError(
      'app-not-exposed',
      `MCP App ${JSON.stringify(selector)} is not exposed by this plugin; exposed: ${exposedList(apps)}.`,
    );
  }
  throw new WebCommandError(
    'app-ambiguous',
    `MCP App ${JSON.stringify(selector)} names ${String(matching.length)} exposed Apps; use one of: ${exposedList(matching)}.`,
  );
};

const portOf = (url: string): number => {
  const parsed = new URL(url);
  if (parsed.port.length > 0) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
};

const hostingEnd = (signal: AbortSignal, closed: Promise<void>): Promise<'aborted' | 'closed'> =>
  new Promise((settle) => {
    if (signal.aborted) {
      settle('aborted');
      return;
    }
    const onAbort = (): void => settle('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    const onClosed = (): void => {
      signal.removeEventListener('abort', onAbort);
      settle('closed');
    };
    closed.then(onClosed, onClosed);
  });

const stderrTail = (session: StdioAppSession): string => {
  const output = session.stderr().trimEnd();
  return output.length <= stderrTailChars ? output : output.slice(-stderrTailChars);
};

interface HostedApp {
  readonly app: WebManifestApp;
  readonly host: WebHost;
}

const reportReady = (options: WebCommandOptions, json: boolean, hosted: HostedApp): void => {
  const { app, host } = hosted;
  if (json) {
    options.writeOut(`${stableJson({
      app: app.app,
      port: portOf(host.url),
      resourceUri: host.resourceUri,
      sandboxOrigin: host.sandboxOrigin,
      server: host.server,
      tool: host.tool,
      url: host.url,
    })}\n`);
    return;
  }
  options.writeOut(`${formatServeAppReadyLine({ app: app.app, tool: host.tool, url: host.url })}\n`);
};

/** Owns and closes the session it launches. */
const hostApp = async (
  options: WebCommandOptions,
  runtime: WebCommandRuntime,
  exposed: ExposedApps,
  app: WebManifestApp,
  argv: WebArgv,
): Promise<number> => {
  const tool = argv.tool ?? app.tool;
  const input = argv.input ?? app.input;
  const allow: readonly McpAppConsentCapability[] = argv.allow.length > 0 ? argv.allow : app.allow;
  const open = argv.open ?? exposed.web.open === 'browser';
  const launch = await runtime.resolveWebLaunch({
    app,
    env: process.env,
    launch: launchOf(exposed, app),
    pluginRoot: options.pluginRoot,
  });
  if (options.signal.aborted) return 0;
  const session = await runtime.openStdioAppSession(launch, { serverName: app.server, target: 'web' }, sessionTimeoutMs);
  let host: WebHost | undefined;
  try {
    if (options.signal.aborted) return 0;
    const selection = await runtime.openApp(session.selection, {
      ...(input === undefined ? {} : { input }),
      resourceUri: app.resourceUri,
      server: app.server,
      ...(tool === undefined ? {} : { tool }),
    });
    if (options.signal.aborted) return 0;
    host = await runtime.startWebHost({
      autoApprove: allow,
      open,
      pageScript: options.pageScript,
      port: argv.port ?? 0,
      profile: argv.profile ?? 'portable',
      selection,
      session,
      title: app.app,
    });
    reportReady(options, argv.json, { app, host });
    const end = await hostingEnd(options.signal, host.closed);
    if (end === 'aborted') return 0;
    const tail = stderrTail(session);
    throw new WebCommandError(
      'server-exited',
      `MCP server ${JSON.stringify(app.server)} exited while ${app.app} was open.${tail.length === 0 ? '' : `\nserver stderr:\n${tail}`}`,
    );
  } finally {
    try {
      await host?.close();
    } finally {
      await session.close();
    }
  }
};

export const runWebCommand = async (options: WebCommandOptions, runtime: WebCommandRuntime = webCommandRuntime): Promise<number> => {
  try {
    const argv = parseWebArgv(options.argv);
    if (argv.help) {
      options.writeOut(webHelp(options.name));
      return 0;
    }
    if (options.signal.aborted) return 0;
    const exposed = await readExposedApps(runtime, options.manifestPath, options.name);
    const app = pickApp(exposed.web, argv.selector);
    return await hostApp(options, runtime, exposed, app, argv);
  } catch (error) {
    if (error instanceof WebCommandError) {
      const exitCode = exitCodeOf(error.code);
      options.writeErr(`${error.message}\n`);
      if (exitCode === 2) options.writeErr(`${webUsageLine(options.name)}\n`);
      return exitCode;
    }
    options.writeErr(`${errorMessage(error)}\n`);
    return 1;
  }
};
