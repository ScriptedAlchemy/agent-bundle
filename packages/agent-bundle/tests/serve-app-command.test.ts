import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import type { McpAppConsentCapability, ServeAppOptions, ServedApp } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { formatServeAppReadyLine } from '../src/serve-app/command-contract.ts';
import {
  locateFrameworkCli,
  parseServeAppReadyLine,
  serveAppAllowCapabilities,
  serveAppArgv,
  type ServeAppAllowCapability,
  type ServeAppArgvOptions,
} from '../src/serve-app-command.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { deferred } from './support/eventually.ts';

/** `true` only when `A` and `B` are the same type; the usual conditional-type identity check, since `@rstest/core` ships no `expectTypeOf`. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/**
 * The `serveApp` options that stay with host processes calling `serveApp`
 * directly: in-process injections (`logger`, `registry`, `openBrowser`) and
 * the two keys the CLI does not expose (`targets`, `timeoutMs`). Everything
 * else must have an argv form — the #558 acceptance criterion.
 */
type HostOnlyKey = 'logger' | 'openBrowser' | 'registry' | 'targets' | 'timeoutMs';
type ArgvKey = Exclude<keyof ServeAppOptions, HostOnlyKey>;

/**
 * Every key of `ServeAppOptions` classified. A new `ServeAppOptions` key
 * fails to compile here until it is either lowered by `serveAppArgv` (and
 * listed in `argvEvidence` below) or added to `HostOnlyKey` with a reason.
 */
const classification: { readonly [K in keyof ServeAppOptions]-?: K extends HostOnlyKey ? 'host-only' : 'argv' } = {
  app: 'argv',
  artifact: 'argv',
  autoApprove: 'argv',
  configPath: 'argv',
  envFiles: 'argv',
  input: 'argv',
  loadEnvFiles: 'argv',
  logger: 'host-only',
  mode: 'argv',
  open: 'argv',
  openBrowser: 'host-only',
  pluginRoot: 'argv',
  port: 'argv',
  profile: 'argv',
  registry: 'host-only',
  root: 'argv',
  target: 'argv',
  targets: 'host-only',
  timeoutMs: 'host-only',
  tool: 'argv',
};

// (a) The argv keys are exactly the non-host-only serveApp keys, in both directions.
const argvKeysAreTheRest: Equals<ArgvKey, keyof ServeAppArgvOptions> = true;
// (b) Per argv key, the helper accepts nothing serveApp would reject.
const argvValuesAssignable: Equals<{ [K in ArgvKey]: ServeAppArgvOptions[K] extends ServeAppOptions[K] ? true : false }[ArgvKey], true> = true;
const argvOptionsAreServeAppOptions: Equals<ServeAppArgvOptions extends ServeAppOptions ? true : false, true> = true;
// autoApprove is the only key whose type differs: it is narrowed to the CLI's `--allow` vocabulary.
const onlyAutoApproveDiffers: Equals<
  { [K in ArgvKey]: Equals<ServeAppArgvOptions[K], ServeAppOptions[K]> extends true ? never : K }[ArgvKey],
  'autoApprove'
> = true;
const autoApproveIsTheAllowVocabulary: Equals<ServeAppArgvOptions['autoApprove'], readonly ServeAppAllowCapability[] | undefined> = true;
const allowVocabulary: Equals<ServeAppAllowCapability, 'call-tool' | 'download-file' | 'open-external-link' | 'request-display-mode'> = true;
const allowIsASubsetOfConsent: Equals<Exclude<ServeAppAllowCapability, McpAppConsentCapability>, never> = true;
const browserPermissionsStayInteractive: Equals<
  Exclude<McpAppConsentCapability, ServeAppAllowCapability>,
  'camera' | 'clipboard-write' | 'geolocation' | 'microphone'
> = true;

/** Every argv key set to a non-default value; `Required` makes a missing key a compile error. */
const sample: Required<ServeAppArgvOptions> = {
  app: 'hauler/dashboard',
  artifact: 'artifact',
  autoApprove: ['call-tool', 'open-external-link'],
  configPath: 'agent-bundle.config.ts',
  envFiles: ['.env.dashboard', '.env.local'],
  input: { scope: 'all', nested: { n: 1, list: [true, null, 'x'] } },
  loadEnvFiles: true,
  mode: 'development',
  open: true,
  pluginRoot: '/state',
  port: 4941,
  profile: 'claude',
  root: '/project',
  target: 'claude',
  tool: 'hauler_status',
};

/**
 * The contiguous argv tokens each key lowers to, from `sample` with
 * `loadEnvFiles: false` (the default `true` lowers to nothing; `--no-env` is
 * the only observable form). Keyed by every argv key, so a key classified
 * `argv` above fails to compile until its evidence is listed.
 */
const argvEvidence: { readonly [K in ArgvKey]: readonly string[] } = {
  app: ['hauler/dashboard'],
  artifact: ['--artifact', 'artifact'],
  autoApprove: ['--allow', 'call-tool', '--allow', 'open-external-link'],
  configPath: ['--config', 'agent-bundle.config.ts'],
  envFiles: ['--env-file', '.env.dashboard', '--env-file', '.env.local'],
  input: ['--input', '{"scope":"all","nested":{"n":1,"list":[true,null,"x"]}}'],
  loadEnvFiles: ['--no-env'],
  mode: ['--mode', 'development'],
  open: ['--open'],
  pluginRoot: ['--plugin-root', '/state'],
  port: ['--port', '4941'],
  profile: ['--profile', 'claude'],
  root: ['--root', '/project'],
  target: ['--target', 'claude'],
  tool: ['--tool', 'hauler_status'],
};

const sampleArgv: readonly string[] = [
  'serve-app', 'hauler/dashboard',
  '--root', '/project',
  '--config', 'agent-bundle.config.ts',
  '--mode', 'development',
  '--artifact', 'artifact',
  '--target', 'claude',
  '--tool', 'hauler_status',
  '--input', '{"scope":"all","nested":{"n":1,"list":[true,null,"x"]}}',
  '--port', '4941',
  '--profile', 'claude',
  '--allow', 'call-tool', '--allow', 'open-external-link',
  '--open',
  '--env-file', '.env.dashboard', '--env-file', '.env.local',
  '--plugin-root', '/state',
];

const readyLine = 'MCP App hauler/dashboard at http://127.0.0.1:4941/ (tool hauler_status; Ctrl-C stops the server)';

const containsSequence = (haystack: readonly string[], needle: readonly string[]): boolean =>
  haystack.some((_token, start) => needle.every((token, offset) => haystack[start + offset] === token));

interface ServeAppRoundTrip {
  readonly calls: readonly ServeAppOptions[];
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  /** Delivers the CLI's SIGTERM so it closes the fake host and releases its terminal runtime. */
  readonly shutdown: () => Promise<void>;
}

/** Runs `argv` through the real `serve-app` command with `serveApp` replaced by a recorder, as cli.test.ts does. */
const roundTrip = async (argv: readonly string[]): Promise<ServeAppRoundTrip> => {
  const calls: ServeAppOptions[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const closedGate = deferred();
  const served: ServedApp = {
    close: async () => { closedGate.resolve(); },
    closed: closedGate.promise,
    resourceUri: 'ui://cargo-hauler/dashboard.html',
    sandboxOrigin: 'http://127.0.0.1:4942',
    server: 'hauler',
    tool: 'hauler_status',
    url: 'http://127.0.0.1:4941/',
  };
  const terminal = captureCliTerminal();
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runCli([...argv], terminal.output, {
    serveApp: async (options) => {
      calls.push(options);
      return served;
    },
    signals: {
      once: (signal, listener) => { handlers.set(signal, listener); },
      removeListener: () => undefined,
    },
  });
  return {
    calls,
    code,
    shutdown: async () => {
      handlers.get('SIGTERM')?.();
      if (handlers.size > 0) await closedGate.promise;
    },
    stderr: terminal.stderr(),
    stdout: terminal.stdout(),
  };
};

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-serve-app-command-')));
  temporaryDirectories.push(directory);
  return directory;
};

const writeManifest = async (root: string, manifest: Readonly<Record<string, unknown>>): Promise<string> => {
  const path = join(root, 'node_modules', 'agent-bundle', 'package.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest)}\n`);
  return path;
};

const testsRoot = import.meta.dirname;
const packageRoot = resolve(testsRoot, '..');
const workspaceRoot = resolve(testsRoot, '../../..');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('ServeAppOptions classification', () => {
  it('classifies every serveApp option as lowered to argv or host-process-only', () => {
    expect(argvKeysAreTheRest).toBe(true);
    expect(argvValuesAssignable).toBe(true);
    expect(argvOptionsAreServeAppOptions).toBe(true);
    expect(onlyAutoApproveDiffers).toBe(true);
    const entries = Object.entries(classification) as readonly (readonly [keyof ServeAppOptions, 'argv' | 'host-only'])[];
    const argvKeys = entries.filter(([, kind]) => kind === 'argv').map(([key]) => key).sort();
    const hostOnlyKeys = entries.filter(([, kind]) => kind === 'host-only').map(([key]) => key).sort();
    expect(hostOnlyKeys).toEqual(['logger', 'openBrowser', 'registry', 'targets', 'timeoutMs']);
    expect(Object.keys(sample).sort()).toEqual(argvKeys);
    expect(Object.keys(argvEvidence).sort()).toEqual(argvKeys);
  });

  it('lowers every argv key of the full sample to its documented flag', () => {
    const argv = serveAppArgv({ ...sample, loadEnvFiles: false });
    const unlowered = Object.entries(argvEvidence).filter(([, tokens]) => !containsSequence(argv, tokens)).map(([key]) => key);
    expect(unlowered).toEqual([]);
    expect(serveAppArgv(sample)).not.toContain('--no-env');
  });

  it('narrows autoApprove to the --allow vocabulary the CLI accepts', () => {
    expect(autoApproveIsTheAllowVocabulary).toBe(true);
    expect(allowVocabulary).toBe(true);
    expect(allowIsASubsetOfConsent).toBe(true);
    expect(browserPermissionsStayInteractive).toBe(true);
    expect(serveAppAllowCapabilities).toEqual(['call-tool', 'download-file', 'open-external-link', 'request-display-mode']);
  });
});

describe('serveAppArgv', () => {
  it('lowers the full sample to serve-app argv in the documented flag order, deterministically', () => {
    expect(serveAppArgv(sample).slice(0, 4)).toEqual(['serve-app', 'hauler/dashboard', '--root', '/project']);
    expect(serveAppArgv(sample)).toEqual(sampleArgv);
    expect(serveAppArgv(sample)).toEqual(serveAppArgv(sample));
  });

  it('lowers the minimal options to the positional and --root only', () => {
    expect(serveAppArgv({ app: 'status/status', root: '/project' })).toEqual(['serve-app', 'status/status', '--root', '/project']);
  });

  it('lowers falsy and empty values faithfully', () => {
    const argv = serveAppArgv({ app: 'status/status', autoApprove: [], envFiles: [], input: {}, port: 0, root: '/project' });
    expect(argv).toEqual(['serve-app', 'status/status', '--root', '/project', '--input', '{}', '--port', '0']);
    expect(argv).not.toContain('--allow');
    expect(argv).not.toContain('--env-file');
    expect(serveAppArgv({ app: 'status/status', loadEnvFiles: false, open: false, root: '/project' }))
      .toEqual(['serve-app', 'status/status', '--root', '/project', '--no-open', '--no-env']);
  });
});

describe('serve-app round trip through the CLI parser', () => {
  it('parses the full sample back into the serveApp options it came from, omitting the default loadEnvFiles', async () => {
    const result = await roundTrip(serveAppArgv(sample));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${readyLine}\n`);
    const { loadEnvFiles, ...expected } = sample;
    expect(loadEnvFiles).toBe(true);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toStrictEqual(expected);
    expect(result.calls[0]).not.toHaveProperty('loadEnvFiles');
    await result.shutdown();
  });

  it('parses --no-env and --no-open back into loadEnvFiles: false and open: false', async () => {
    const options: Required<ServeAppArgvOptions> = { ...sample, envFiles: [], loadEnvFiles: false, open: false };
    const argv = serveAppArgv(options);
    expect(argv).toContain('--no-env');
    expect(argv).toContain('--no-open');
    expect(argv).not.toContain('--env-file');
    expect(argv).not.toContain('--open');
    const result = await roundTrip(argv);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const { envFiles, ...expected } = options;
    expect(envFiles).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toStrictEqual(expected);
    await result.shutdown();
  });

  it('fills the CLI defaults for the minimal options', async () => {
    const result = await roundTrip(serveAppArgv({ app: 'hauler/dashboard', root: '/project' }));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${readyLine}\n`);
    expect(result.calls).toStrictEqual([{
      app: 'hauler/dashboard',
      input: {},
      mode: 'production',
      open: false,
      profile: 'portable',
      root: '/project',
      target: 'portable',
    }]);
    await result.shutdown();
  });

  it('leaves the --env-file/--no-env conflict to the CLI, which rejects it before serving', async () => {
    const argv = serveAppArgv({ app: 'hauler/dashboard', envFiles: ['.env'], loadEnvFiles: false, root: '/project' });
    expect(argv).toEqual(['serve-app', 'hauler/dashboard', '--root', '/project', '--env-file', '.env', '--no-env']);
    const result = await roundTrip(argv);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual([{
      code: 'AB5000',
      message: 'Use either --env-file or --no-env, not both.',
      severity: 'error',
    }]);
    expect(result.calls).toEqual([]);
    await result.shutdown();
  });
});

describe('ready line', () => {
  it('parses what the CLI formats', () => {
    for (const app of ['hauler/dashboard', 'status/ui://status/dashboard.html']) {
      const fields = { app, tool: 'hauler_status', url: 'http://127.0.0.1:4941/' };
      expect(parseServeAppReadyLine(formatServeAppReadyLine(fields))).toEqual(fields);
    }
  });

  it('parses the exact CLI line, tolerating a trailing line ending', () => {
    const fields = { app: 'hauler/dashboard', tool: 'hauler_status', url: 'http://127.0.0.1:4941/' };
    expect(parseServeAppReadyLine(readyLine)).toEqual(fields);
    expect(parseServeAppReadyLine(`${readyLine}\n`)).toEqual(fields);
    expect(parseServeAppReadyLine(`${readyLine}\r\n`)).toEqual(fields);
  });

  it('ignores every other line', () => {
    expect(parseServeAppReadyLine('Building…')).toBeUndefined();
    expect(parseServeAppReadyLine('MCP App x at nowhere')).toBeUndefined();
    expect(parseServeAppReadyLine('')).toBeUndefined();
    expect(parseServeAppReadyLine(`  ${readyLine}`)).toBeUndefined();
  });
});

describe('locateFrameworkCli', () => {
  it('resolves the bin of the agent-bundle installed under root, in object and string form', async () => {
    const objectRoot = await temporaryDirectory();
    await writeManifest(objectRoot, { bin: { 'agent-bundle': './bin/agent-bundle.js' }, name: 'agent-bundle' });
    await expect(locateFrameworkCli(objectRoot)).resolves.toBe(join(objectRoot, 'node_modules/agent-bundle/bin/agent-bundle.js'));

    const stringRoot = await temporaryDirectory();
    await writeManifest(stringRoot, { bin: './bin/agent-bundle.js', name: 'agent-bundle' });
    await expect(locateFrameworkCli(stringRoot)).resolves.toBe(join(stringRoot, 'node_modules/agent-bundle/bin/agent-bundle.js'));
  });

  it('finds a manifest installed two levels above the root', async () => {
    const root = await temporaryDirectory();
    await writeManifest(root, { bin: { 'agent-bundle': './bin/agent-bundle.js' }, name: 'agent-bundle' });
    await mkdir(join(root, 'packages', 'plugin'), { recursive: true });
    await expect(locateFrameworkCli(join(root, 'packages', 'plugin')))
      .resolves.toBe(join(root, 'node_modules/agent-bundle/bin/agent-bundle.js'));
  });

  it('finds the manifest whether or not the package exports it: the walk never asks the resolver', async () => {
    const root = await temporaryDirectory();
    await writeManifest(root, {
      bin: { 'agent-bundle': './bin/agent-bundle.js' },
      exports: { '.': './dist/index.js' },
      name: 'agent-bundle',
    });
    await mkdir(join(root, 'packages', 'plugin'), { recursive: true });
    await expect(locateFrameworkCli(join(root, 'packages', 'plugin')))
      .resolves.toBe(join(root, 'node_modules/agent-bundle/bin/agent-bundle.js'));
  });

  it('returns undefined for a manifest without a bin and for a root without the framework', async () => {
    const binless = await temporaryDirectory();
    await writeManifest(binless, { name: 'agent-bundle' });
    await expect(locateFrameworkCli(binless)).resolves.toBeUndefined();

    const empty = await temporaryDirectory();
    await expect(locateFrameworkCli(empty)).resolves.toBeUndefined();
  });

  it('resolves this checkout to its own bin from the package and from the workspace root', async () => {
    const expected = await realpath(join(packageRoot, 'bin', 'agent-bundle.js'));
    for (const root of [packageRoot, workspaceRoot]) {
      const located = await locateFrameworkCli(root);
      expect(located).toBeDefined();
      expect(await realpath(located!)).toBe(expected);
    }
  });
});
