import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { expect, it } from '@rstest/core';

import {
  createInspectorLauncher,
  InspectorLauncherError,
  parseInspectorStdoutUrl,
  type InspectorLauncherOptions,
  type InspectorSpawn,
  type InspectorSpawnOptions,
} from '../src/dev/inspector-launcher.ts';

const startupTimeoutKey = Symbol.for('agent-bundle.inspector-launcher.startup-timeout-ms');
const terminateGraceKey = Symbol.for('agent-bundle.inspector-launcher.terminate-grace-ms');
const tokenUrl = 'http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=inspector-token';
const inspectorToken = 'a4f15a21448a409c76c5b9aebb214b18bbc507037062c804ba970c74fc5e9b3a';
const inspectorTokenUrl = `http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=${inspectorToken}`;
/** Verbatim `@modelcontextprotocol/inspector` 2.5.0 stdout banner: no `/` before `?`. */
const inspectorBanner = [
  'Starting MCP inspector...',
  '',
  '  MCP Inspector Web is up and running at:',
  `   http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=${inspectorToken}`,
  '',
  '   Sandbox (MCP Apps): http://127.0.0.1:6275/sandbox',
  '',
  `   Auth token: ${inspectorToken}`,
  '',
  '   Secrets: OS keychain',
  '',
].join('\n');

interface SpawnInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly options: InspectorSpawnOptions;
}

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  autoCloseOnKill = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
    this.signals.push(signal);
    if (!this.autoCloseOnKill) return true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', 0, signal));
    return true;
  };
}

const withSeams = (
  options: InspectorLauncherOptions,
  seams: { readonly startupTimeoutMs?: number; readonly terminateGraceMs?: number } = {},
): InspectorLauncherOptions => Object.assign(options, {
  ...(seams.startupTimeoutMs === undefined ? {} : { [startupTimeoutKey]: seams.startupTimeoutMs }),
  ...(seams.terminateGraceMs === undefined ? {} : { [terminateGraceKey]: seams.terminateGraceMs }),
});

const fakeSpawn = (): {
  readonly children: FakeChild[];
  readonly invocations: SpawnInvocation[];
  readonly spawn: InspectorSpawn;
} => {
  const children: FakeChild[] = [];
  const invocations: SpawnInvocation[] = [];
  return Object.freeze({
    children,
    invocations,
    spawn: (command, args, options) => {
      invocations.push(Object.freeze({ args: Object.freeze([...args]), command, options }));
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
};

/** Splits `text` right after the first occurrence of `marker`. */
const splitAfter = (text: string, marker: string): readonly [string, string] => {
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`marker not found: ${marker}`);
  const at = index + marker.length;
  return [text.slice(0, at), text.slice(at)];
};

/** 'pending' unless `promise` settles before the macrotask queue turns over. */
const settlement = (promise: Promise<unknown>): Promise<'pending' | 'settled'> => Promise.race([
  promise.then(() => 'settled' as const, () => 'settled' as const),
  new Promise<'pending'>((resolvePromise) => {
    setImmediate(() => resolvePromise('pending'));
  }),
]);

it('stays idle until launch is requested and never auto-spawns', () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });

  expect(launcher.status()).toEqual({ state: 'idle' });
  expect(spawned.invocations).toEqual([]);
});

it('parses the first token-bearing inspector URL from stdout and is idempotent', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    env: { PATH: '/bin', EXTRA: 'keep' },
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });

  const pending = launcher.launch();
  expect(launcher.status()).toEqual({ state: 'starting' });
  expect(spawned.invocations).toHaveLength(1);
  expect(spawned.invocations[0]).toMatchObject({
    args: ['--yes', '@modelcontextprotocol/inspector'],
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    options: {
      cwd: resolve('/work/project'),
      env: { EXTRA: 'keep', MCP_AUTO_OPEN_ENABLED: 'false', PATH: '/bin' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });

  const second = launcher.launch();
  spawned.children[0]!.stdout.write(`MCP Inspector is up at ${tokenUrl}\n`);
  await expect(Promise.all([pending, second])).resolves.toEqual([{ url: tokenUrl }, { url: tokenUrl }]);
  expect(spawned.invocations).toHaveLength(1);
  expect(launcher.status()).toEqual({ state: 'running', url: tokenUrl });
  await expect(launcher.launch()).resolves.toEqual({ url: tokenUrl });
  expect(spawned.invocations).toHaveLength(1);
});

it('prefers a token query URL and falls back to the first localhost URL', () => {
  expect(parseInspectorStdoutUrl([
    'proxy http://localhost:6277',
    `open ${tokenUrl}`,
    '',
  ].join('\n'))).toBe(tokenUrl);
  expect(parseInspectorStdoutUrl('listening on http://127.0.0.1:6274/inspector\n')).toBe(
    'http://127.0.0.1:6274/inspector',
  );
  expect(parseInspectorStdoutUrl('https://localhost:6274/?sessionToken=abc\n')).toBe(
    'https://localhost:6274/?sessionToken=abc',
  );
  expect(parseInspectorStdoutUrl('http://example.com/nope\n')).toBeUndefined();
  expect(parseInspectorStdoutUrl('http://localhost:6274/?MCP_PROXY_AUTH_')).toBeUndefined();
});

it('does not choose a URL that ends the buffer, whether or not it already carries a token key', () => {
  // A later chunk may still extend the token value, so an undelimited URL is not evidence yet.
  expect(parseInspectorStdoutUrl('https://localhost:6274/?sessionToken=abc')).toBeUndefined();
  expect(parseInspectorStdoutUrl('listening on http://127.0.0.1:6274/inspector')).toBeUndefined();
});

it('selects the tokenized URL from the Inspector 2.5.0 banner and skips the sandbox URL', () => {
  expect(parseInspectorStdoutUrl(inspectorBanner)).toBe(inspectorTokenUrl);
});

it('joins a URL split across stdout chunks before resolving', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });

  const pending = launcher.launch();
  spawned.children[0]!.stdout.write('http://localhost:6274/?MCP_PROXY_AUTH_');
  spawned.children[0]!.stdout.write('TOKEN=split-token\n');
  await expect(pending).resolves.toEqual({
    url: 'http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=split-token',
  });
});

it('keeps a 2.5.0 launch pending while the token key is split across stdout chunks', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });
  const [head, tail] = splitAfter(inspectorBanner, 'MCP_INSPECTOR_API_');

  const pending = launcher.launch();
  spawned.children[0]!.stdout.write(head);
  await expect(settlement(pending)).resolves.toBe('pending');
  expect(launcher.status()).toEqual({ state: 'starting' });

  spawned.children[0]!.stdout.write(tail);
  await expect(pending).resolves.toEqual({ url: inspectorTokenUrl });
  expect(launcher.status()).toEqual({ state: 'running', url: inspectorTokenUrl });
});

it('keeps a 2.5.0 launch pending while the token value is split across stdout chunks', async () => {
  // A chunk that ends inside the token value already looks like a complete token URL; only
  // the delimiter that follows the URL proves the value is whole.
  const [head, tail] = splitAfter(inspectorBanner, 'MCP_INSPECTOR_API_TOKEN=a4f15a21');
  expect(parseInspectorStdoutUrl(head)).toBeUndefined();

  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });

  const pending = launcher.launch();
  spawned.children[0]!.stdout.write(head);
  await expect(settlement(pending)).resolves.toBe('pending');
  expect(launcher.status()).toEqual({ state: 'starting' });

  spawned.children[0]!.stdout.write(tail);
  await expect(pending).resolves.toEqual({ url: inspectorTokenUrl });
  expect(launcher.status()).toEqual({ state: 'running', url: inspectorTokenUrl });
});

it('kills the child and rejects when the startup budget elapses', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher(withSeams({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  }, { startupTimeoutMs: 20, terminateGraceMs: 10 }));

  await expect(launcher.launch()).rejects.toEqual(expect.objectContaining({
    code: 'INSPECTOR_STARTUP_TIMEOUT',
    name: InspectorLauncherError.name,
  }));
  expect(spawned.children[0]!.signals).toContain('SIGTERM');
  expect(launcher.status()).toEqual({ state: 'exited' });
});

it('rejects when the child exits before a URL is published', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  });

  const pending = launcher.launch();
  spawned.children[0]!.emit('close', 1, null);
  await expect(pending).rejects.toEqual(expect.objectContaining({
    code: 'INSPECTOR_EXITED',
    name: InspectorLauncherError.name,
  }));
  expect(launcher.status()).toEqual({ state: 'exited' });
});

it('ignores a superseded child exit after a timed-out launch is retried', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher(withSeams({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  }, { startupTimeoutMs: 20, terminateGraceMs: 5 }));

  const first = launcher.launch();
  spawned.children[0]!.autoCloseOnKill = false;
  await expect(first).rejects.toEqual(expect.objectContaining({
    code: 'INSPECTOR_STARTUP_TIMEOUT',
    name: InspectorLauncherError.name,
  }));

  const retried = launcher.launch();
  expect(spawned.invocations).toHaveLength(2);
  spawned.children[0]!.emit('close', 1, null);
  spawned.children[1]!.stdout.write(`${tokenUrl}\n`);
  await expect(retried).resolves.toEqual({ url: tokenUrl });
  expect(launcher.status()).toEqual({ state: 'running', url: tokenUrl });
});

it('closes the child tree idempotently and can launch again afterwards', async () => {
  const spawned = fakeSpawn();
  const launcher = createInspectorLauncher(withSeams({
    projectRoot: '/work/project',
    spawn: spawned.spawn,
  }, { terminateGraceMs: 10 }));

  const pending = launcher.launch();
  spawned.children[0]!.stdout.write(`${tokenUrl}\n`);
  await pending;
  await launcher.close();
  await launcher.close();
  expect(spawned.children[0]!.signals[0]).toBe('SIGTERM');
  expect(launcher.status()).toEqual({ state: 'idle' });

  const relaunched = launcher.launch();
  expect(spawned.invocations).toHaveLength(2);
  spawned.children[1]!.stdout.write(`${tokenUrl}\n`);
  await expect(relaunched).resolves.toEqual({ url: tokenUrl });
});
