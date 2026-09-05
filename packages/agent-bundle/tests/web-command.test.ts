import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { formatServeAppReadyLine, serveAppAllowCapabilities } from '../src/serve-app/command-contract.ts';
import { runWebCommand, webHelp, webUsageLine, type WebCommandOptions, type WebCommandRuntime } from '../src/web-host/command.ts';
import type { StartWebHostOptions, WebHost } from '../src/web-host/host-server.ts';
import { WebLaunchError, type ResolveWebLaunchOptions } from '../src/web-host/launch.ts';
import type { ArtifactManifestLaunch, WebManifest, WebManifestApp, WebManifestDocument } from '../src/web-host/manifest.ts';
import type { McpAppJsonValue } from '../src/contracts/mcp-apps.ts';
import type { AppSelection, AppSelectionSource, OpenAppRequest } from '../src/web-host/select-app.ts';
import type { StdioAppSession, StdioLaunch } from '../src/web-host/session.ts';
import { deferred, eventually } from './support/eventually.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const statusApp: WebManifestApp = Object.freeze<WebManifestApp>({
  allow: ['open-external-link'],
  app: 'status/status',
  input: { verbose: true },
  name: 'status',
  resourceUri: 'ui://status/status.html',
  server: 'status',
  tool: 'show_status',
});

const notesApp: WebManifestApp = Object.freeze<WebManifestApp>({
  allow: [],
  app: 'notes/notes',
  name: 'notes',
  resourceUri: 'ui://notes/notes.html',
  server: 'notes-server',
});

const statusLaunch: ArtifactManifestLaunch = Object.freeze<ArtifactManifestLaunch>({
  args: [],
  entry: 'mcp/mcp-status-073c1634.mjs',
  env: { STATUS_TOKEN: 'from-manifest' },
});

const notesLaunch: ArtifactManifestLaunch = Object.freeze<ArtifactManifestLaunch>({
  args: [],
  entry: 'mcp/mcp-notes-1a2b3c4d.mjs',
  env: {},
});

const compiledLaunches: ReadonlyMap<string, ArtifactManifestLaunch> = new Map([['status', statusLaunch], ['notes-server', notesLaunch]]);

const manifestOf = (apps: readonly WebManifestApp[], open: WebManifest['open'] = 'never'): WebManifest => Object.freeze({ apps, open });

const documentOf = (web: WebManifest | undefined, launches = compiledLaunches): WebManifestDocument =>
  Object.freeze({ hosts: ['claude'], launches, ...(web === undefined ? {} : { web }) });

const bridgeOf = (sessionId: string): StdioAppSession['bridge'] => Object.freeze({
  callTool: async () => null,
  identity: Object.freeze({ epochId: `web:${sessionId}`, serverName: 'status', sessionId, target: 'web' }),
  listBridgeResources: async () => [],
  listBridgeTools: async () => [],
  readResource: async () => null,
});

const selectionSource: AppSelectionSource = Object.freeze({
  callTool: async () => null,
  listAppResourceUris: async () => [],
  listToolDefinitions: async () => [],
});

interface FakeSession {
  readonly closeCalls: () => number;
  /** Ends the server on its own, as a crash would. */
  readonly exit: () => void;
  readonly session: StdioAppSession;
}

const fakeSession = (stderr = ''): FakeSession => {
  const closed = deferred();
  let closeCalls = 0;
  const session: StdioAppSession = Object.freeze({
    bridge: bridgeOf('session-1'),
    close: async () => {
      closeCalls += 1;
      closed.resolve();
    },
    closed: closed.promise,
    selection: selectionSource,
    sessionId: 'session-1',
    stderr: () => stderr,
    watchClosed: () => () => undefined,
  });
  return { closeCalls: () => closeCalls, exit: () => closed.resolve(), session };
};

const selectionOf = (request: OpenAppRequest): AppSelection => Object.freeze({
  // `openApp` canonicalizes the request's `unknown` record; the fake hands it through as-is.
  input: (request.input ?? {}) as Readonly<Record<string, McpAppJsonValue>>,
  resourceUri: request.resourceUri ?? 'ui://unknown',
  result: { content: [] },
  server: request.server,
  tool: Object.freeze({ name: request.tool ?? 'show_status' }),
});

const launchOf = (options: ResolveWebLaunchOptions): StdioLaunch => Object.freeze({
  args: Object.freeze([join(options.pluginRoot, options.launch.entry)]),
  command: process.execPath,
  cwd: options.pluginRoot,
  env: Object.freeze({ ...options.launch.env }),
});

interface Recorded {
  readonly hostCloseCalls: () => number;
  readonly hosts: StartWebHostOptions[];
  readonly launches: ResolveWebLaunchOptions[];
  readonly opens: { readonly request: OpenAppRequest; readonly source: AppSelectionSource }[];
  readonly runtime: WebCommandRuntime;
  readonly sessions: { readonly identity: { readonly serverName: string; readonly target: string }; readonly launch: StdioLaunch; readonly timeoutMs: number }[];
}

interface RuntimeOptions {
  readonly manifest?: WebManifest | (() => Promise<WebManifestDocument>);
  readonly openApp?: WebCommandRuntime['openApp'];
  readonly openStdioAppSession?: WebCommandRuntime['openStdioAppSession'];
  readonly resolveWebLaunch?: WebCommandRuntime['resolveWebLaunch'];
  readonly session?: FakeSession;
  readonly url?: string;
}

const recorded = (options: RuntimeOptions = {}): Recorded => {
  const fake = options.session ?? fakeSession();
  const launches: ResolveWebLaunchOptions[] = [];
  const sessions: Recorded['sessions'] = [];
  const opens: Recorded['opens'] = [];
  const hosts: StartWebHostOptions[] = [];
  let hostCloseCalls = 0;
  const url = options.url ?? 'http://127.0.0.1:4321/';
  const runtime: WebCommandRuntime = {
    openApp: options.openApp ?? (async (source: AppSelectionSource, request: OpenAppRequest) => {
      opens.push({ request, source });
      return selectionOf(request);
    }),
    openStdioAppSession: options.openStdioAppSession ?? (async (
      launch: StdioLaunch,
      identity: { readonly serverName: string; readonly target: string },
      timeoutMs: number,
    ) => {
      sessions.push({ identity, launch, timeoutMs });
      return fake.session;
    }),
    readWebManifestDocument: async () => {
      if (options.manifest === undefined) throw new Error('the manifest must not be read for this argv');
      return typeof options.manifest === 'function' ? options.manifest() : documentOf(options.manifest);
    },
    resolveWebLaunch: options.resolveWebLaunch ?? (async (launchOptions) => {
      launches.push(launchOptions);
      return launchOf(launchOptions);
    }),
    startWebHost: async (hostOptions: StartWebHostOptions) => {
      hosts.push(hostOptions);
      const host: WebHost = Object.freeze({
        close: async () => {
          hostCloseCalls += 1;
        },
        closed: hostOptions.session.closed,
        resourceUri: hostOptions.selection.resourceUri,
        sandboxOrigin: 'http://127.0.0.1:4322',
        server: hostOptions.selection.server,
        tool: hostOptions.selection.tool.name,
        url,
      });
      return host;
    },
  };
  return { hostCloseCalls: () => hostCloseCalls, hosts, launches, opens, runtime, sessions };
};

interface Invocation {
  readonly done: Promise<number>;
  readonly manifestPath: string;
  readonly pluginRoot: string;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

/** Runs the command over a temp plugin root that holds a (placeholder) manifest unless `manifest: 'absent'`. */
const invoke = async (
  argv: readonly string[],
  runtime: WebCommandRuntime,
  options: { readonly manifest?: 'absent'; readonly name?: string; readonly signal?: AbortSignal } = {},
): Promise<Invocation> => {
  const pluginRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-command-')));
  roots.push(pluginRoot);
  const manifestPath = join(pluginRoot, 'agent-bundle.manifest.json');
  if (options.manifest !== 'absent') await writeFile(manifestPath, '{}\n');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commandOptions: WebCommandOptions = {
    argv,
    manifestPath,
    name: options.name ?? 'plugin',
    pageScript: '/* page */',
    pluginRoot,
    signal: options.signal ?? new AbortController().signal,
    writeErr: (text) => void stderr.push(text),
    writeOut: (text) => void stdout.push(text),
  };
  return {
    done: runWebCommand(commandOptions, runtime),
    manifestPath,
    pluginRoot,
    stderr: () => stderr.join(''),
    stdout: () => stdout.join(''),
  };
};

const usageLine = 'Usage: plugin web [<server>/<app>] [options]';
const manifestRequirement = 'agent-bundle.manifest.json with a web section is required beside bin/; '
  + 'run plugin web from the built artifact or the installed plugin root.';

describe('<plugin> web', () => {
  describe('--help', () => {
    it('prints the usage and every option on stdout, exit 0, without reading the manifest', async () => {
      const { runtime } = recorded();
      for (const argv of [['--help'], ['-h'], ['status/status', '--port', '1', '--help'], ['--bogus', '-h']]) {
        const run = await invoke(argv, runtime);
        expect(await run.done).toBe(0);
        expect(run.stderr()).toBe('');
        expect(run.stdout()).toBe(webHelp('plugin'));
      }
      const help = webHelp('plugin');
      expect(help.startsWith(`${usageLine}\n\nOpen one of the plugin's MCP Apps in a browser.\n\nArguments:\n  [<server>/<app>]  `)).toBe(true);
      expect(help).toContain('\nOptions:\n');
      const lines = help.split('\n');
      const optionLine = (label: string): string | undefined => lines.find((line) => line.startsWith(`  ${label} `));
      const rows: readonly (readonly [string, string])[] = [
        ['    --port <number>', 'Loopback TCP port of the host page; 0 picks a free one. [default: 0]'],
        ['    --open', 'Open the default browser once the host is listening.'],
        ['    --no-open', "Do not open a browser, whatever the manifest's web.open says."],
        ['    --tool <name>', 'The tool whose result opens the App. [default: the configured tool, else the only tool that opens the App]'],
        ['    --input <json>', 'Arguments of the opening tool call, as one JSON object. [default: the configured input]'],
        ['    --allow <capability> ...', `Approve a consent capability as the App requests it; repeatable. One of: ${serveAppAllowCapabilities.join(', ')}.`],
        ['    --profile <chatgpt|claude|portable>', 'The simulated MCP Apps host profile. [default: "portable"]'],
        ['    --json', 'Print one JSON line describing the host instead of the ready line.'],
        ['-h, --help', 'Show help.'],
      ];
      for (const [label, description] of rows) {
        const line = optionLine(label);
        expect(line, label).toBeDefined();
        expect(line!.endsWith(`  ${description}`), label).toBe(true);
        // One column: every description starts at the same offset.
        expect(line!.indexOf(description)).toBe(2 + '    --profile <chatgpt|claude|portable>'.length + 2);
      }
      expect(help.endsWith('Show help.\n')).toBe(true);
      expect(webHelp(undefined)).toContain('Usage: <plugin> web [<server>/<app>] [options]');
      expect(webUsageLine('plugin')).toBe(usageLine);
    });
  });

  describe('usage errors (exit 2, before anything is read or spawned)', () => {
    it.each([
      [['--bogus'], 'Unknown option: --bogus.'],
      [['-x'], 'Unknown option: -x.'],
      [['status/status', 'notes/notes'], 'Unexpected argument: "notes/notes".'],
      [['--port'], '--port requires a value.'],
      [['--port', '--json'], '--port requires a value.'],
      [['--port', 'abc'], '--port requires a TCP port number (0-65535); got "abc".'],
      [['--port', '70000'], '--port requires a TCP port number (0-65535); got "70000".'],
      [['--port=1.5'], '--port requires a TCP port number (0-65535); got "1.5".'],
      [['--port', '1', '--port', '2'], 'Duplicate option: --port.'],
      [['--tool', 'a', '--tool', 'b'], 'Duplicate option: --tool.'],
      [['--json=true'], '--json is a flag and takes no value.'],
      [['--json', '--json'], 'Duplicate option: --json.'],
      [['--open', '--no-open'], 'Use either --open or --no-open, not both.'],
      [['--no-open', '--open'], 'Use either --open or --no-open, not both.'],
      [['--input', '{bad'], '--input must be one valid JSON object.'],
      [['--input', '[1]'], '--input must be a JSON object; arrays, null, and scalar values are not accepted.'],
      [['--input', 'null'], '--input must be a JSON object; arrays, null, and scalar values are not accepted.'],
      [['--allow', 'camera'], `--allow must be one of: ${serveAppAllowCapabilities.join(', ')}; got "camera".`],
      [['--allow', 'call-tool', '--allow', 'clipboard-write'], `--allow must be one of: ${serveAppAllowCapabilities.join(', ')}; got "clipboard-write".`],
      [['--profile', 'workbench'], '--profile must be one of: chatgpt, claude, portable; got "workbench".'],
    ])('%j → %s', async (argv, message) => {
      const { runtime, launches, sessions } = recorded();
      const run = await invoke(argv, runtime);
      expect(await run.done).toBe(2);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toBe(`${message}\n${usageLine}\n`);
      expect(launches).toEqual([]);
      expect(sessions).toEqual([]);
    });
  });

  describe('the manifest (exit 1)', () => {
    it('requires agent-bundle.manifest.json beside the bin', async () => {
      const { runtime } = recorded();
      const run = await invoke([], runtime, { manifest: 'absent' });
      expect(await run.done).toBe(1);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toBe(`${manifestRequirement} (No manifest at ${run.manifestPath}.)\n`);
    });

    it('requires a web section in it', async () => {
      const { runtime } = recorded({ manifest: async () => documentOf(undefined) });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe(`${manifestRequirement} (${run.manifestPath} has no web section: configure web.apps and rebuild.)\n`);
    });

    it('requires the web section to expose an App', async () => {
      const { runtime } = recorded({ manifest: manifestOf([]) });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe(`${manifestRequirement} (The web section of ${run.manifestPath} exposes no App: configure web.apps and rebuild.)\n`);
    });

    it('reports a malformed manifest with the reader\'s own message', async () => {
      const { runtime } = recorded({ manifest: async () => { throw new Error('web.apps[0].entry must be a string.'); } });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe(`Cannot read the web section of ${run.manifestPath}: web.apps[0].entry must be a string.\n`);
    });

    it('requires the exposed App\'s server to have a compiled launch record', async () => {
      const { runtime, launches: resolved } = recorded({ manifest: async () => documentOf(manifestOf([statusApp]), new Map()) });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe(
        `${run.manifestPath} exposes status/status, but executables.mcpServers has no compiled launch record for server "status"; rebuild the plugin.\n`,
      );
      expect(resolved).toEqual([]);
    });

    it('names the executable in the requirement when the shell told it', async () => {
      const { runtime } = recorded();
      const run = await invoke([], runtime, { manifest: 'absent', name: 'curator' });
      expect(await run.done).toBe(1);
      expect(run.stderr()).toContain('run curator web from the built artifact');
    });
  });

  describe('picking the App (exit 2 when the argv does not settle it)', () => {
    it('lists the exposed Apps when several are and none is named', async () => {
      const { runtime, sessions } = recorded({ manifest: manifestOf([statusApp, notesApp]) });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(2);
      expect(run.stderr()).toBe(`Several MCP Apps are exposed; name one: status/status, notes/notes.\n${usageLine}\n`);
      expect(sessions).toEqual([]);
    });

    it('lists the exposed Apps when the named one is not among them', async () => {
      const { runtime } = recorded({ manifest: manifestOf([statusApp, notesApp]) });
      const run = await invoke(['status/settings'], runtime);
      expect(await run.done).toBe(2);
      expect(run.stderr()).toBe(`MCP App "status/settings" is not exposed by this plugin; exposed: status/status, notes/notes.\n${usageLine}\n`);
      const otherServer = await invoke(['other/status'], runtime);
      expect(await otherServer.done).toBe(2);
      expect(otherServer.stderr()).toContain('MCP App "other/status" is not exposed by this plugin');
    });

    it('rejects a selector that is not <server>/<app> or <server>/ui://... as a usage error', async () => {
      const { runtime } = recorded({ manifest: manifestOf([statusApp, notesApp]) });
      const run = await invoke(['status'], runtime);
      expect(await run.done).toBe(2);
      expect(run.stderr()).toContain('"status"');
      expect(run.stderr()).toContain('<server>/<app>');
      expect(run.stderr().endsWith(`\n${usageLine}\n`)).toBe(true);
    });

    it('accepts the configured <server>/<app>, the server name, or the resource URI', async () => {
      for (const selector of ['notes/notes', 'notes-server/notes', 'notes-server/ui://notes/notes.html', 'notes/ui://notes/notes.html']) {
        const { runtime, opens } = recorded({ manifest: manifestOf([statusApp, notesApp]) });
        const controller = new AbortController();
        const run = await invoke([selector], runtime, { signal: controller.signal });
        await eventually(() => run.stdout().length > 0);
        controller.abort();
        expect(await run.done).toBe(0);
        expect(opens[0]!.request.resourceUri).toBe('ui://notes/notes.html');
        expect(run.stdout()).toBe(`${formatServeAppReadyLine({ app: 'notes/notes', tool: 'show_status', url: 'http://127.0.0.1:4321/' })}\n`);
      }
    });
  });

  describe('hosting', () => {
    it('launches, opens, and hosts the only exposed App with the manifest\'s tool, input, allow, and open, then stops on the signal with exit 0', async () => {
      const session = fakeSession();
      const { runtime, launches, sessions, opens, hosts, hostCloseCalls } = recorded({ manifest: manifestOf([statusApp], 'browser'), session });
      const controller = new AbortController();
      const run = await invoke([], runtime, { signal: controller.signal });
      await eventually(() => run.stdout().length > 0);

      expect(launches).toEqual([{ app: statusApp, env: process.env, launch: statusLaunch, pluginRoot: run.pluginRoot }]);
      expect(sessions).toEqual([{ identity: { serverName: 'status', target: 'web' }, launch: launchOf(launches[0]!), timeoutMs: 30_000 }]);
      expect(opens).toEqual([{
        request: { input: { verbose: true }, resourceUri: 'ui://status/status.html', server: 'status', tool: 'show_status' },
        source: selectionSource,
      }]);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        autoApprove: ['open-external-link'],
        open: true,
        pageScript: '/* page */',
        port: 0,
        profile: 'portable',
        session: session.session,
        title: 'status/status',
      });
      expect(hosts[0]!.selection.tool.name).toBe('show_status');
      expect(run.stdout()).toBe('MCP App status/status at http://127.0.0.1:4321/ (tool show_status; Ctrl-C stops the server)\n');
      expect(run.stderr()).toBe('');
      expect(hostCloseCalls()).toBe(0);
      expect(session.closeCalls()).toBe(0);

      controller.abort();
      expect(await run.done).toBe(0);
      expect(hostCloseCalls()).toBe(1);
      expect(session.closeCalls()).toBe(1);
      expect(run.stderr()).toBe('');
    });

    it('lets the flags override the manifest: --tool, --input, --allow, --no-open, --port, --profile', async () => {
      const { runtime, opens, hosts } = recorded({ manifest: manifestOf([statusApp], 'browser') });
      const controller = new AbortController();
      const run = await invoke([
        'status/status',
        '--tool', 'show_history',
        '--input', '{"days":7}',
        '--allow', 'call-tool',
        '--allow', 'download-file',
        '--allow', 'call-tool',
        '--no-open',
        '--port=4321',
        '--profile', 'claude',
      ], runtime, { signal: controller.signal });
      await eventually(() => run.stdout().length > 0);
      controller.abort();
      expect(await run.done).toBe(0);
      expect(opens[0]!.request).toEqual({ input: { days: 7 }, resourceUri: 'ui://status/status.html', server: 'status', tool: 'show_history' });
      expect(hosts[0]).toMatchObject({ autoApprove: ['call-tool', 'download-file'], open: false, port: 4321, profile: 'claude' });
      expect(run.stdout()).toBe('MCP App status/status at http://127.0.0.1:4321/ (tool show_history; Ctrl-C stops the server)\n');
    });

    it('opens the browser on --open when the manifest says never, and leaves tool and input to the server when neither names them', async () => {
      const { runtime, opens, hosts } = recorded({ manifest: manifestOf([notesApp]) });
      const controller = new AbortController();
      const run = await invoke(['--open'], runtime, { signal: controller.signal });
      await eventually(() => run.stdout().length > 0);
      controller.abort();
      expect(await run.done).toBe(0);
      expect(opens[0]!.request).toEqual({ resourceUri: 'ui://notes/notes.html', server: 'notes-server' });
      expect(hosts[0]).toMatchObject({ autoApprove: [], open: true });
    });

    it('prints one canonical JSON line for --json and keeps running', async () => {
      const { runtime } = recorded({ manifest: manifestOf([statusApp]) });
      const controller = new AbortController();
      const run = await invoke(['--json'], runtime, { signal: controller.signal });
      await eventually(() => run.stdout().length > 0);
      expect(run.stdout()).toBe(
        '{"app":"status/status","port":4321,"resourceUri":"ui://status/status.html","sandboxOrigin":"http://127.0.0.1:4322",'
          + '"server":"status","tool":"show_status","url":"http://127.0.0.1:4321/"}\n',
      );
      let settled = false;
      void run.done.then(() => { settled = true; });
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      expect(settled).toBe(false);
      controller.abort();
      expect(await run.done).toBe(0);
    });

    it('exits 1 with the server\'s stderr tail when the server ends on its own', async () => {
      const session = fakeSession('boot ok\nTypeError: cannot read status\n');
      const { runtime, hostCloseCalls } = recorded({ manifest: manifestOf([statusApp]), session });
      const run = await invoke([], runtime);
      await eventually(() => run.stdout().length > 0);
      session.exit();
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe('MCP server "status" exited while status/status was open.\nserver stderr:\nboot ok\nTypeError: cannot read status\n');
      expect(hostCloseCalls()).toBe(1);
      expect(session.closeCalls()).toBe(1);
    });

    it('omits the stderr section when the server printed nothing', async () => {
      const session = fakeSession();
      const { runtime } = recorded({ manifest: manifestOf([statusApp]), session });
      const run = await invoke([], runtime);
      await eventually(() => run.stdout().length > 0);
      session.exit();
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe('MCP server "status" exited while status/status was open.\n');
    });

    it('returns 0 without launching anything when the signal is already aborted', async () => {
      const { runtime, launches } = recorded({ manifest: manifestOf([statusApp]) });
      const run = await invoke([], runtime, { signal: AbortSignal.abort() });
      expect(await run.done).toBe(0);
      expect(launches).toEqual([]);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toBe('');
    });
  });

  describe('failures before the host listens (exit 1)', () => {
    it('reports an entry that escapes the plugin root and spawns nothing', async () => {
      const { runtime, sessions } = recorded({
        manifest: manifestOf([statusApp]),
        resolveWebLaunch: async () => {
          throw new WebLaunchError('entry-outside-root', 'MCP server entry "../x.mjs" of status/status escapes the plugin root /plugin; a web manifest may only name files of its own artifact.');
        },
      });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe('MCP server entry "../x.mjs" of status/status escapes the plugin root /plugin; a web manifest may only name files of its own artifact.\n');
      expect(sessions).toEqual([]);
    });

    it('reports a server that did not start', async () => {
      const { runtime } = recorded({
        manifest: manifestOf([statusApp]),
        openStdioAppSession: async () => {
          throw new Error('The packed MCP server did not start: connection closed\nserver stderr:\nENOENT');
        },
      });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe('The packed MCP server did not start: connection closed\nserver stderr:\nENOENT\n');
      expect(run.stdout()).toBe('');
    });

    it('closes the session when the App cannot be opened', async () => {
      const session = fakeSession();
      const { runtime, hosts } = recorded({
        manifest: manifestOf([statusApp]),
        openApp: async () => {
          throw new Error('Tool "show_status" does not open MCP App ui://status/status.html.');
        },
        session,
      });
      const run = await invoke([], runtime);
      expect(await run.done).toBe(1);
      expect(run.stderr()).toBe('Tool "show_status" does not open MCP App ui://status/status.html.\n');
      expect(hosts).toEqual([]);
      expect(session.closeCalls()).toBe(1);
    });
  });
});
