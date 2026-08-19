import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

const execFile = promisify((await import('node:child_process')).execFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixtureRoot = join(workspaceRoot, 'fixtures', 'integration', 'packed-release');
const browserTimeout = 12_000;
const packedServerStartupBudget = 45_000;
const productTemporaryRootPrefixes = [
  'agent-bundle-hook-playground-',
  'agent-bundle-mcp-',
  'agent-bundle-playground-script-',
] as const;
let builtPackage: Promise<void> | undefined;

const expectedAgentApiToolNames = [
  'project_status',
  'skills_list',
  'skill_inspect',
  'artifacts_list',
  'artifact_inspect',
  'mcp_servers_list',
  'mcp_invoke',
  'hooks_list',
  'hook_simulate',
  'evals_list',
  'eval_run',
  'eval_get',
  'diagnostics_list',
] as const;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

const availablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  }));
  return address.port;
};

const buildPackage = (): Promise<void> => builtPackage ??= (async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
})();

const awaitReady = async (origin: string, child: ChildProcess, output: () => string): Promise<void> => {
  const startedAt = Date.now();
  const diagnostics = (): string =>
    `after ${String(Date.now() - startedAt)}ms (PID ${String(child.pid ?? 'unknown')}): ${output()}`;
  while (Date.now() - startedAt < packedServerStartupBudget) {
    if (child.exitCode !== null) throw new Error(`The packed dev server exited before readiness ${diagnostics()}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // The fixed loopback port is not ready yet.
    }
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
  }
  throw new Error(`Timed out waiting for the packed dev server ${diagnostics()}`);
};

const childExitedWithin = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      resolvePromise(exited);
    };
    const onExit = (): void => { finish(true); };
    const onError = (error: Error): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      rejectPromise(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    const timeout = setTimeout(() => { finish(false); }, timeoutMs);
    if (child.exitCode !== null) finish(true);
  });
};

const closeChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const signalAndWait = async (signal: NodeJS.Signals): Promise<boolean> => {
    if (child.exitCode !== null) return true;
    if (!child.kill(signal)) {
      if (child.exitCode !== null) return true;
      throw new Error(`The packed dev server could not receive ${signal}.`);
    }
    return childExitedWithin(child, 5_000);
  };
  const closeFailures: unknown[] = [];
  try {
    if (await signalAndWait('SIGTERM')) return;
    closeFailures.push(new Error('The packed dev server did not exit after SIGTERM.'));
  } catch (error) {
    closeFailures.push(error);
  }
  let forceExited = false;
  try { forceExited = await signalAndWait('SIGKILL'); }
  catch (error) { closeFailures.push(error); }
  if (forceExited) throw new AggregateError(closeFailures, 'The packed dev server required SIGKILL after SIGTERM.');
  closeFailures.push(new Error('The packed dev server remained alive after SIGKILL.'));
  throw new AggregateError(closeFailures, 'The packed dev server could not be stopped.');
};

const writeFakeClaude = async (root: string): Promise<string> => {
  const directory = join(root, '.packed-release-fake-claude');
  const executable = join(directory, 'claude');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(executable, '#!/bin/sh\nexec node "$(dirname "$0")/claude.mjs" "$@"\n'),
    writeFile(join(directory, 'claude.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('2.1.240 (Claude Code)\\n'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('{\"authMethod\":\"claude.ai\",\"loggedIn\":true,\"subscriptionType\":\"max\"}\\n'); process.exit(0); }",
      "const prompt = args.at(-1) ?? '';",
      "if (prompt.includes('Wait for packed native cancellation.')) setInterval(() => undefined, 1_000);",
      "writeFileSync('result.json', '{\"risk\":\"packed-native\"}\\n');",
      'process.stdout.write([',
      "  '{\"type\":\"system\",\"subtype\":\"init\",\"plugins\":[{\"name\":\"packed-release-fixture\"}],\"mcp_servers\":[{\"name\":\"fixture\"}]}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Skill\",\"input\":{\"skill\":\"packed-release-fixture:review\"}}]}}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"mcp__fixture__show-dashboard\",\"input\":{}}]}}',",
      "  '{\"type\":\"system\",\"hook_event_name\":\"SessionStart\"}',",
      "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"duration_ms\":7,\"num_turns\":2,\"result\":\"Packed native fixture completed.\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}',",
      "  '',",
      "].join('\\n'));",
      '',
    ].join('\n')),
  ]);
  await chmod(executable, 0o755);
  return directory;
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be a string.`);
  return value;
};

const firstRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Expected ${label} to contain one entry.`);
  return record(value[0], `${label}[0]`);
};

const isWithin = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path.length === 0 || (!isAbsolute(path) && !path.startsWith('..'));
};

const descendantProcessIds = async (parentProcessId: number): Promise<readonly number[]> => {
  const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const row of stdout.split('\n')) {
    const [processIdText, ancestorProcessIdText] = row.trim().split(/\s+/u);
    const processId = Number(processIdText);
    const ancestorProcessId = Number(ancestorProcessIdText);
    if (!Number.isInteger(processId) || !Number.isInteger(ancestorProcessId)) continue;
    const descendants = children.get(ancestorProcessId) ?? [];
    descendants.push(processId);
    children.set(ancestorProcessId, descendants);
  }
  const descendants = new Set<number>();
  const pending = [...(children.get(parentProcessId) ?? [])];
  while (pending.length > 0) {
    const processId = pending.pop();
    if (processId === undefined || descendants.has(processId)) continue;
    descendants.add(processId);
    pending.push(...(children.get(processId) ?? []));
  }
  return [...descendants];
};

const isAppRoute = (url: URL): boolean =>
  url.pathname.startsWith('/api/mcp/apps/') || /^\/api\/mcp\/sessions\/[^/]+\/apps$/u.test(url.pathname);

interface NetworkLedgerEntry {
  readonly at: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly respondedAt?: number;
  readonly status?: number;
  readonly url: string;
}

interface ConsoleErrorRecord {
  readonly at: number;
  readonly text: string;
  readonly url: string;
}

interface OutageLedger {
  readonly consoleErrors: readonly ConsoleErrorRecord[];
  readonly oldSessionId: string;
  readonly origin: string;
  readonly outageStartedAt: number;
  readonly postRecovery?: Readonly<{
    readonly freshMcpSession: Readonly<{ readonly closeCompletedAt: number; readonly closeStartedAt: number; readonly id: string; readonly openedAt: number }>;
    readonly navigation: readonly Readonly<{ readonly leftAt: number; readonly openedAt: number; readonly url: string }>[];
  }>;
  readonly recoveredAt: number;
  readonly requests: readonly NetworkLedgerEntry[];
}

const ledgerRequest = (input: Omit<NetworkLedgerEntry, 'origin' | 'url'> & Readonly<{ readonly origin?: string; readonly url?: string }>): NetworkLedgerEntry => {
  const origin = input.origin ?? 'http://127.0.0.1:4100';
  return Object.freeze({ ...input, origin, url: input.url ?? `${origin}${input.path}` });
};

const outageLedgerFixture = (): OutageLedger => {
  const origin = 'http://127.0.0.1:4100';
  const oldSessionId = 'old-browser-mcp-session';
  const oldSessionPath = `/api/mcp/sessions/${encodeURIComponent(oldSessionId)}`;
  const failure = (at: number, method: string, path: string, error: string): NetworkLedgerEntry =>
    ledgerRequest({ at, completedAt: at + 1, error, method, path });
  return Object.freeze({
    consoleErrors: Object.freeze([
      Object.freeze({ at: 1_003, text: 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING', url: `${origin}/api/project/events` }),
      Object.freeze({ at: 1_005, text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: `${origin}${oldSessionPath}/stream?after=0` }),
      Object.freeze({ at: 1_012, text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: `${origin}/api/project/session` }),
      Object.freeze({ at: 1_016, text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: `${origin}${oldSessionPath}` }),
    ]),
    oldSessionId,
    origin,
    outageStartedAt: 1_000,
    recoveredAt: 1_301,
    requests: Object.freeze([
      failure(1_001, 'GET', '/api/project/events', 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'),
      ledgerRequest({ at: 1_003, completedAt: 1_004, error: 'net::ERR_CONNECTION_REFUSED', method: 'GET', path: `${oldSessionPath}/stream`, url: `${origin}${oldSessionPath}/stream?after=0` }),
      failure(1_010, 'GET', '/api/project/session', 'net::ERR_CONNECTION_REFUSED'),
      ledgerRequest({ at: 1_300, completedAt: 1_301, method: 'GET', path: '/api/project/session', status: 200 }),
      failure(1_014, 'DELETE', oldSessionPath, 'net::ERR_CONNECTION_REFUSED'),
    ]),
  });
};

const postRecoveryCancellationFixture = (): OutageLedger => {
  const base = outageLedgerFixture();
  const freshMcpSessionId = 'fresh-browser-mcp-session';
  const freshMcpStreamPath = `/api/mcp/sessions/${encodeURIComponent(freshMcpSessionId)}/stream`;
  const hooksUrl = `${base.origin}/api/hooks?epochId=recovered-epoch`;
  return Object.freeze({
    ...base,
    postRecovery: Object.freeze({
      freshMcpSession: Object.freeze({ closeCompletedAt: 1_321, closeStartedAt: 1_320, id: freshMcpSessionId, openedAt: 1_310 }),
      navigation: Object.freeze([
        Object.freeze({ leftAt: 1_340, openedAt: 1_330, url: hooksUrl }),
      ]),
    }),
    requests: Object.freeze([
      ...base.requests,
      ledgerRequest({ at: 1_310, completedAt: 1_321, error: 'net::ERR_ABORTED', method: 'GET', path: freshMcpStreamPath, respondedAt: 1_311, status: 200, url: `${base.origin}${freshMcpStreamPath}?after=0` }),
      ledgerRequest({ at: 1_330, completedAt: 1_341, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/hooks', url: hooksUrl }),
    ]),
  });
};

/** Models the old `some() + count` check so its false positives stay documented. */
const legacyOutageLedgerPasses = (ledger: OutageLedger): boolean => {
  const failures = ledger.requests.filter((request) => request.error !== undefined);
  const consoleBackedFailures = failures.filter((request) => request.error !== 'net::ERR_ABORTED');
  const matchedConsoleErrors = ledger.consoleErrors.filter((consoleError) => failures.some((failure) =>
    failure.error !== 'net::ERR_ABORTED' && consoleError.text.includes(failure.error ?? '') &&
    new URL(consoleError.url).pathname === failure.path,
  ));
  const oldSessionPath = `/api/mcp/sessions/${encodeURIComponent(ledger.oldSessionId)}`;
  const oldSessionDeletes = failures.filter((failure) => failure.method === 'DELETE' && failure.path === oldSessionPath);
  return matchedConsoleErrors.length === consoleBackedFailures.length && oldSessionDeletes.length <= 1;
};

type OutagePathClass = 'old-mcp-session' | 'old-mcp-stream' | 'project-events' | 'project-session';

const outagePathClass = (path: string, oldSessionPath: string): OutagePathClass | undefined => {
  if (path === '/api/project/events') return 'project-events';
  if (path === '/api/project/session') return 'project-session';
  if (path === oldSessionPath) return 'old-mcp-session';
  if (path === `${oldSessionPath}/stream`) return 'old-mcp-stream';
  return undefined;
};

const netCode = (text: string): string | undefined => /\b(net::ERR_[A-Z_]+)\b/u.exec(text)?.[1];

const ledgerFailureAt = (request: NetworkLedgerEntry): number => request.completedAt ?? request.at;

type KnownStreamClass = 'evals' | 'logs' | 'playground';

const knownStreamClass = (path: string): KnownStreamClass | undefined => {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (path === '/api/logs/stream') return 'logs';
  if (segments.length !== 5 || segments[0] !== 'api' || segments[3]!.length === 0 || segments[4] !== 'stream') return undefined;
  if (segments[1] === 'playground' && segments[2] === 'sessions') return 'playground';
  return segments[1] === 'evals' && segments[2] === 'runs' ? 'evals' : undefined;
};

const isKnownPreOutageStreamCancellation = (request: NetworkLedgerEntry): boolean =>
  request.error === 'net::ERR_ABORTED' && request.method === 'GET' && (
    knownStreamClass(request.path) !== undefined ||
    (request.path === '/api/logs/replay' && request.status !== undefined && request.status >= 200 && request.status < 300)
  );

const hasCanonicalAfterCursor = (url: URL): boolean => {
  const parameters = [...url.searchParams.entries()];
  if (parameters.length !== 1 || parameters[0]![0] !== 'after') return false;
  const after = parameters[0]![1];
  const parsed = Number(after);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === after && url.search === `?after=${after}`;
};

const isExactOldMcpStreamReset = (request: NetworkLedgerEntry, ledger: OutageLedger, oldSessionPath: string): boolean => {
  const oldStreamPath = `${oldSessionPath}/stream`;
  if (
    request.error !== 'net::ERR_CONNECTION_RESET' || request.method !== 'GET' || request.origin !== ledger.origin ||
    request.path !== oldStreamPath || request.completedAt === undefined || request.at > request.completedAt ||
    request.completedAt < ledger.outageStartedAt || request.completedAt >= ledger.recoveredAt ||
    request.respondedAt !== undefined || request.status !== undefined
  ) return false;
  let url: URL;
  try { url = new URL(request.url); }
  catch { return false; }
  if (url.origin !== ledger.origin || url.pathname !== oldStreamPath || url.hash.length > 0 || !hasCanonicalAfterCursor(url)) return false;
  return url.href === `${ledger.origin}${oldStreamPath}${url.search}`;
};

const assertLedger: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Foreground outage ledger rejected: ${message}`);
};

/** Exhaustively validates only the one captured foreground generation and its recovery. */
const validateOutageLedger = (ledger: OutageLedger): void => {
  const oldSessionPath = `/api/mcp/sessions/${encodeURIComponent(ledger.oldSessionId)}`;
  const sameOriginRequests = ledger.requests.filter((request) => request.origin === ledger.origin);
  const requestFailed = ledger.requests.filter((request) => request.error !== undefined);
  const foreignFailures = requestFailed.filter((request) => request.origin !== ledger.origin);
  assertLedger(foreignFailures.length === 0, `cross-origin request failures: ${JSON.stringify(foreignFailures)}`);
  const preOutageFailures = requestFailed.filter((request) =>
    ledgerFailureAt(request) < ledger.outageStartedAt && !isKnownPreOutageStreamCancellation(request),
  );
  assertLedger(preOutageFailures.length === 0, `unexpected pre-outage failures: ${JSON.stringify(preOutageFailures)}`);
  const postRecoveryFailures = ledger.requests.filter((request) => request.error !== undefined && ledgerFailureAt(request) >= ledger.recoveredAt);
  if (ledger.postRecovery === undefined) {
    assertLedger(postRecoveryFailures.length === 0, `post-recovery failures: ${JSON.stringify(postRecoveryFailures)}`);
  } else {
    const freshMcpSession = ledger.postRecovery.freshMcpSession;
    const freshMcpStreamPath = `/api/mcp/sessions/${encodeURIComponent(freshMcpSession.id)}/stream`;
    const freshMcpStreamFailures = postRecoveryFailures.filter((request) => request.path === freshMcpStreamPath);
    assertLedger(freshMcpStreamFailures.length >= 1 && freshMcpStreamFailures.length <= 2,
      `fresh B MCP stream did not terminate exactly once or twice: ${JSON.stringify(freshMcpStreamFailures)}`);
    for (const failure of freshMcpStreamFailures) {
      let url: URL;
      try { url = new URL(failure.url); }
      catch { throw new Error(`Foreground outage ledger rejected: fresh B MCP stream URL is invalid: ${JSON.stringify(failure)}`); }
      assertLedger(
        failure.origin === ledger.origin && url.origin === ledger.origin && url.pathname === freshMcpStreamPath && hasCanonicalAfterCursor(url) &&
        failure.method === 'GET' && failure.error === 'net::ERR_ABORTED' && failure.at >= freshMcpSession.openedAt &&
        failure.respondedAt !== undefined && failure.respondedAt <= ledgerFailureAt(failure) &&
        failure.status !== undefined && failure.status >= 200 && failure.status < 300 &&
        ledgerFailureAt(failure) >= freshMcpSession.closeStartedAt && ledgerFailureAt(failure) <= freshMcpSession.closeCompletedAt,
        `fresh B MCP stream cancellation is not action-induced: ${JSON.stringify(failure)}`,
      );
    }
    const navigationFailures: NetworkLedgerEntry[] = [];
    for (const navigation of ledger.postRecovery.navigation) {
      const failures = postRecoveryFailures.filter((request) =>
        request.url === navigation.url && request.at >= navigation.openedAt && request.at < navigation.leftAt && ledgerFailureAt(request) >= navigation.leftAt,
      );
      assertLedger(failures.length <= 1, `multiple action-induced navigation cancellations: ${JSON.stringify({ failures, navigation })}`);
      for (const failure of failures) {
        assertLedger(
          failure.origin === ledger.origin && failure.method === 'GET' && failure.error === 'net::ERR_ABORTED' &&
          failure.respondedAt === undefined && failure.status === undefined,
          `navigation cancellation did not remain a pending exact request: ${JSON.stringify({ failure, navigation })}`,
        );
      }
      navigationFailures.push(...failures);
    }
    const recognizedPostRecoveryFailures = [...freshMcpStreamFailures, ...navigationFailures];
    assertLedger(recognizedPostRecoveryFailures.length === postRecoveryFailures.length,
      `unknown post-recovery failure: ${JSON.stringify(postRecoveryFailures)}`);
    const postRecoveryConsoleErrors = ledger.consoleErrors.filter((consoleError) => consoleError.at >= ledger.recoveredAt);
    assertLedger(postRecoveryConsoleErrors.length === 0, `post-recovery console errors: ${JSON.stringify(postRecoveryConsoleErrors)}`);
  }
  const outageFailures = requestFailed.filter((request) => {
    const at = ledgerFailureAt(request);
    return at >= ledger.outageStartedAt && at < ledger.recoveredAt;
  });

  const projectEvents = outageFailures.filter((request) => outagePathClass(request.path, oldSessionPath) === 'project-events');
  assertLedger(projectEvents.length === 1 && projectEvents[0]?.method === 'GET' && projectEvents[0]?.error === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    `project stream failures: ${JSON.stringify(projectEvents)}`);
  const oldStreams = outageFailures.filter((request) => outagePathClass(request.path, oldSessionPath) === 'old-mcp-stream');
  assertLedger(oldStreams.length >= 1, 'the old browser MCP stream has no termination evidence');
  assertLedger(oldStreams.filter((request) => request.method === 'GET' && request.error === 'net::ERR_CONNECTION_REFUSED').length <= 1,
    `old MCP stream has duplicate refused failures: ${JSON.stringify(oldStreams)}`);
  assertLedger(oldStreams.filter((request) => request.method === 'GET' && request.error === 'net::ERR_ABORTED').length <= 2,
    `old MCP stream has too many abort failures: ${JSON.stringify(oldStreams)}`);
  const oldStreamResets = oldStreams.filter((request) => request.error === 'net::ERR_CONNECTION_RESET');
  assertLedger(oldStreamResets.length <= 1 && oldStreamResets.every((request) => isExactOldMcpStreamReset(request, ledger, oldSessionPath)),
    `old MCP stream has an invalid reset termination: ${JSON.stringify(oldStreamResets)}`);
  assertLedger(oldStreams.every((request) => request.method === 'GET' && (
    request.error === 'net::ERR_CONNECTION_REFUSED' || request.error === 'net::ERR_ABORTED' ||
    isExactOldMcpStreamReset(request, ledger, oldSessionPath)
  )),
    `old MCP stream has an unrecognized failure: ${JSON.stringify(oldStreams)}`);

  const streamClasses: readonly KnownStreamClass[] = ['playground', 'logs', 'evals'];
  for (const streamClass of streamClasses) {
    const activeAtOutage = sameOriginRequests.filter((request) =>
      request.at < ledger.outageStartedAt &&
      (request.completedAt === undefined || request.completedAt >= ledger.outageStartedAt) &&
      knownStreamClass(request.path) === streamClass,
    );
    assertLedger(activeAtOutage.length <= 1, `multiple active ${streamClass} streams at outage start: ${JSON.stringify(activeAtOutage)}`);
    const terminations = outageFailures.filter((request) => knownStreamClass(request.path) === streamClass);
    assertLedger(terminations.length <= 1 && terminations.every((request) =>
      activeAtOutage.includes(request) && request.method === 'GET' && request.error === 'net::ERR_ABORTED',
    ), `unexpected ${streamClass} stream termination: ${JSON.stringify(terminations)}`);
  }

  const oldSessionDeletes = sameOriginRequests.filter((request) => request.method === 'DELETE' && request.path === oldSessionPath);
  assertLedger(oldSessionDeletes.length === 1, `expected exactly one old-session DELETE attempt: ${JSON.stringify(oldSessionDeletes)}`);
  const oldSessionDelete = oldSessionDeletes[0]!;
  const deleteSucceeded = oldSessionDelete.status !== undefined && oldSessionDelete.status >= 200 && oldSessionDelete.status < 300;
  const deleteRefused = oldSessionDelete.error === 'net::ERR_CONNECTION_REFUSED';
  assertLedger((deleteSucceeded ? 1 : 0) + (deleteRefused ? 1 : 0) === 1 && oldSessionDelete.completedAt !== undefined,
    `old-session DELETE must succeed or fail exactly with ERR_CONNECTION_REFUSED: ${JSON.stringify(oldSessionDelete)}`);

  const projectSessionAttempts = sameOriginRequests.filter((request) =>
    request.method === 'GET' && request.path === '/api/project/session' && request.at >= ledger.outageStartedAt,
  ).sort((left, right) => left.at - right.at);
  const successfulSessions = projectSessionAttempts.filter((request) =>
    request.status !== undefined && request.status >= 200 && request.status < 300,
  );
  assertLedger(successfulSessions.length >= 1, `the browser did not complete a B-generation project session: ${JSON.stringify(projectSessionAttempts)}`);
  const firstSuccessfulBSession = successfulSessions[0]!;
  assertLedger(firstSuccessfulBSession.completedAt === ledger.recoveredAt,
    `recoveredAt does not identify the first successful B session: ${JSON.stringify(firstSuccessfulBSession)}`);
  const retryAttempts = projectSessionAttempts.filter((request) => request.at <= firstSuccessfulBSession.at);
  assertLedger(retryAttempts.length >= 1, 'the outage did not issue a project/session retry');
  assertLedger(retryAttempts.every((request) => request.completedAt !== undefined && (request.error === undefined) !== (request.status === undefined)),
    `project/session retry is missing or has multiple terminal states: ${JSON.stringify(retryAttempts)}`);
  assertLedger(retryAttempts.slice(0, -1).every((request) => request.error === 'net::ERR_CONNECTION_REFUSED'),
    `project/session retry had a non-refused failure: ${JSON.stringify(retryAttempts)}`);
  assertLedger(retryAttempts.at(-1) === firstSuccessfulBSession && firstSuccessfulBSession.status === 200,
    `project/session recovery did not finish with the first successful B session: ${JSON.stringify(retryAttempts)}`);
  for (const [index, attempt] of retryAttempts.entries()) {
    if (index > 0) assertLedger(attempt.at - retryAttempts[index - 1]!.at >= 225,
      `project/session retries began too quickly: ${JSON.stringify(retryAttempts)}`);
  }
  const retryTimeline = retryAttempts.flatMap((request) => [
    Object.freeze({ at: request.at, delta: 1 }),
    Object.freeze({ at: request.completedAt!, delta: -1 }),
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let inFlight = 0;
  let maxInFlight = 0;
  for (const event of retryTimeline) {
    inFlight += event.delta;
    maxInFlight = Math.max(maxInFlight, inFlight);
  }
  assertLedger(maxInFlight <= 1 && inFlight === 0, `project/session retry concurrency exceeded one: ${JSON.stringify(retryAttempts)}`);
  const retryUpperBound = 2 + Math.ceil((ledger.recoveredAt - ledger.outageStartedAt) / 250);
  assertLedger(retryAttempts.length <= retryUpperBound,
    `project/session retries exceeded the bounded cadence (${String(retryUpperBound)}): ${JSON.stringify(retryAttempts)}`);

  for (const failure of outageFailures) {
    const pathClass = outagePathClass(failure.path, oldSessionPath);
    const recognized =
      (pathClass === 'project-events' && failure.method === 'GET' && failure.error === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING') ||
      (pathClass === 'project-session' && failure.method === 'GET' && failure.error === 'net::ERR_CONNECTION_REFUSED') ||
      (pathClass === 'old-mcp-stream' && failure.method === 'GET' && (
        failure.error === 'net::ERR_CONNECTION_REFUSED' || failure.error === 'net::ERR_ABORTED' ||
        isExactOldMcpStreamReset(failure, ledger, oldSessionPath)
      )) ||
      (pathClass === 'old-mcp-session' && failure.method === 'DELETE' && failure.error === 'net::ERR_CONNECTION_REFUSED') ||
      (knownStreamClass(failure.path) !== undefined && failure.method === 'GET' && failure.error === 'net::ERR_ABORTED');
    assertLedger(recognized, `unknown outage failure: ${JSON.stringify(failure)}`);
  }

  const pendingConsoleBackedFailures = outageFailures.filter((failure) => failure.error !== 'net::ERR_ABORTED').sort((left, right) => ledgerFailureAt(left) - ledgerFailureAt(right));
  const outageConsoleErrors = ledger.consoleErrors.filter((consoleError) =>
    consoleError.at >= ledger.outageStartedAt && consoleError.at < ledger.recoveredAt,
  ).sort((left, right) => left.at - right.at);
  for (const consoleError of outageConsoleErrors) {
    let consoleUrl: URL;
    try { consoleUrl = new URL(consoleError.url); }
    catch { throw new Error(`Foreground outage ledger rejected: console URL is invalid: ${JSON.stringify(consoleError)}`); }
    const code = netCode(consoleError.text);
    const pathClass = outagePathClass(consoleUrl.pathname, oldSessionPath);
    assertLedger(consoleUrl.origin === ledger.origin && code !== undefined && pathClass !== undefined,
      `unknown outage console error: ${JSON.stringify(consoleError)}`);
    const matchingFailureIndex = pendingConsoleBackedFailures.findIndex((failure) =>
      failure.error === code && outagePathClass(failure.path, oldSessionPath) === pathClass &&
      failure.url === consoleUrl.href &&
      Math.abs(ledgerFailureAt(failure) - consoleError.at) <= 1_000,
    );
    assertLedger(matchingFailureIndex >= 0, `console error does not uniquely pair with an outage request failure: ${JSON.stringify(consoleError)}`);
    pendingConsoleBackedFailures.splice(matchingFailureIndex, 1);
  }
  assertLedger(pendingConsoleBackedFailures.length === 0,
    `outage request failures lack a unique paired console error: ${JSON.stringify(pendingConsoleBackedFailures)}`);
  const nonOutageConsoleErrors = ledger.consoleErrors.filter((consoleError) => !outageConsoleErrors.includes(consoleError));
  assertLedger(nonOutageConsoleErrors.length === 0, `unknown non-outage console errors: ${JSON.stringify(nonOutageConsoleErrors)}`);
};

test('outage ledger rejects the legacy duplicate, cross-origin, and missing-cleanup false positives', () => {
  const valid = outageLedgerFixture();
  const oldStreamPath = `/api/mcp/sessions/${encodeURIComponent(valid.oldSessionId)}/stream`;
  const resetRequest = ledgerRequest({
    at: 999,
    completedAt: 1_008,
    error: 'net::ERR_CONNECTION_RESET',
    method: 'GET',
    path: oldStreamPath,
    url: `${valid.origin}${oldStreamPath}?after=1`,
  });
  const resetConsole = Object.freeze({ at: 1_008, text: 'Failed to load resource: net::ERR_CONNECTION_RESET', url: resetRequest.url });
  const withOldStreamReset = (request: NetworkLedgerEntry, consoleError: ConsoleErrorRecord): OutageLedger => Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([...valid.consoleErrors, consoleError]),
    requests: Object.freeze([...valid.requests, request]),
  });
  const validOldStreamReset = withOldStreamReset(resetRequest, resetConsole);
  const resetWithAlteredQuery = withOldStreamReset(
    ledgerRequest({ ...resetRequest, url: `${valid.origin}${oldStreamPath}?after=01` }),
    Object.freeze({ ...resetConsole, url: `${valid.origin}${oldStreamPath}?after=01` }),
  );
  const resetWithResponse = withOldStreamReset(
    ledgerRequest({ ...resetRequest, respondedAt: 1_000, status: 200 }),
    resetConsole,
  );
  const resetWithUnknownSession = withOldStreamReset(
    ledgerRequest({
      ...resetRequest,
      path: '/api/mcp/sessions/unknown-browser-mcp-session/stream',
      url: `${valid.origin}/api/mcp/sessions/unknown-browser-mcp-session/stream?after=1`,
    }),
    Object.freeze({ ...resetConsole, url: `${valid.origin}/api/mcp/sessions/unknown-browser-mcp-session/stream?after=1` }),
  );
  const resetWithForeignOrigin = withOldStreamReset(
    ledgerRequest({ ...resetRequest, origin: 'http://127.0.0.2:4100', url: `http://127.0.0.2:4100${oldStreamPath}?after=1` }),
    Object.freeze({ ...resetConsole, url: `http://127.0.0.2:4100${oldStreamPath}?after=1` }),
  );
  const resetWithMismatchedConsoleUrl = withOldStreamReset(
    resetRequest,
    Object.freeze({ ...resetConsole, url: `${valid.origin}${oldStreamPath}?after=2` }),
  );
  const resetWithoutConsole = Object.freeze({
    ...validOldStreamReset,
    consoleErrors: Object.freeze(validOldStreamReset.consoleErrors.slice(0, -1)),
  });
  const duplicateOldStreamReset = Object.freeze({
    ...validOldStreamReset,
    consoleErrors: Object.freeze([...validOldStreamReset.consoleErrors, Object.freeze({ ...resetConsole, at: 1_009, url: `${valid.origin}${oldStreamPath}?after=2` })]),
    requests: Object.freeze([...validOldStreamReset.requests, ledgerRequest({ ...resetRequest, at: 998, completedAt: 1_009, url: `${valid.origin}${oldStreamPath}?after=2` })]),
  });
  const postRecoveryReset = withOldStreamReset(
    ledgerRequest({ ...resetRequest, at: 1_301, completedAt: 1_302 }),
    Object.freeze({ ...resetConsole, at: 1_302 }),
  );
  const validPostRecovery = postRecoveryCancellationFixture();
  const duplicateConsole = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      valid.consoleErrors[0]!,
      Object.freeze({ ...valid.consoleErrors[0]!, at: 1_004 }),
      valid.consoleErrors[2]!,
      valid.consoleErrors[3]!,
    ]),
  });
  const crossOriginConsole = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      Object.freeze({ ...valid.consoleErrors[0]!, url: 'http://127.0.0.2:4100/api/project/events' }),
      ...valid.consoleErrors.slice(1),
    ]),
  });
  const missingCleanup = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze(valid.consoleErrors.slice(0, -1)),
    requests: Object.freeze(valid.requests.slice(0, -1)),
  });
  const unknownPreOutageCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/unknown/stream', status: 200 }),
      ...valid.requests,
    ]),
  });
  const preOutageCancelAbort = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'POST', path: '/api/playground/runs/native-a/cancel' }),
      ...valid.requests,
    ]),
  });
  const knownPreOutageLogsReplayCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/logs/replay', status: 200 }),
      ...valid.requests,
    ]),
  });
  const preStartedOutageStreamTermination = Object.freeze({
    ...valid,
    requests: Object.freeze(valid.requests.map((request) =>
      request.path === '/api/project/events' || request.path.endsWith('/stream')
        ? ledgerRequest({ ...request, at: 999 })
        : request,
    )),
  });
  const unknownOutageStreamTermination = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 999, completedAt: 1_004, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/unknown/stream' }),
      ...valid.requests,
    ]),
  });
  const unknownPostRecoveryCancellation = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze([
      ...validPostRecovery.requests,
      ledgerRequest({ at: 1_350, completedAt: 1_351, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/unknown/stream' }),
    ]),
  });
  const malformedLedgers = [duplicateConsole, crossOriginConsole, missingCleanup];

  expect(malformedLedgers.map(legacyOutageLedgerPasses)).toEqual([true, true, true]);
  expect(() => validateOutageLedger(valid)).not.toThrow();
  expect(() => validateOutageLedger(validOldStreamReset)).not.toThrow();
  expect(() => validateOutageLedger(preStartedOutageStreamTermination)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageLogsReplayCancellation)).not.toThrow();
  expect(() => validateOutageLedger(validPostRecovery)).not.toThrow();
  for (const malformed of malformedLedgers) expect(() => validateOutageLedger(malformed)).toThrow(/Foreground outage ledger rejected/u);
  for (const malformed of [
    resetWithAlteredQuery, resetWithResponse, resetWithUnknownSession, resetWithForeignOrigin, resetWithMismatchedConsoleUrl,
    resetWithoutConsole, duplicateOldStreamReset, postRecoveryReset,
  ]) expect(() => validateOutageLedger(malformed)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownPreOutageCancellation)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(preOutageCancelAbort)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownOutageStreamTermination)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownPostRecoveryCancellation)).toThrow(/Foreground outage ledger rejected/u);
});

e2e('runs every Agent API tool from the installed tarball', { timeout: 360_000 }, async ({ page }) => {
  await buildPackage();
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-release-'));
  const forbiddenStagedPackage = join(consumer, 'staged-package');
  const project = join(consumer, 'project');
  const agentApiToken = 'packed-release-token';
  let child: ChildProcess | undefined;
  let phase = 'package setup';
  const trackedProcessIds = new Set<number>();
  const observedOperationDescendantProcessIds = new Set<number>();
  const productTemporaryRootsBefore = new Set<string>();
  let cleanupFailure: AggregateError | undefined;
  let primaryFailure: Error | undefined;
  try {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', consumer], {
      cwd: packageRoot,
      env: installedEnvironment(),
    });
    const [packed] = JSON.parse(stdout) as Array<{ readonly filename: string }>;
    const tarball = join(consumer, packed.filename);
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
    await execFile('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: consumer,
      env: installedEnvironment(),
    });
    const installedPackageRoot = await realpath(join(consumer, 'node_modules', 'agent-bundle'));
    const installedCli = await realpath(join(consumer, 'node_modules', '.bin', 'agent-bundle'));
    expect(isWithin(consumer, installedPackageRoot)).toBe(true);
    expect(isWithin(workspaceRoot, installedPackageRoot)).toBe(false);
    expect(installedCli).toBe(join(installedPackageRoot, 'dist', 'cli.js'));
    expect(isWithin(workspaceRoot, installedCli)).toBe(false);
    const installedManifest = record(JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8')), 'installed package manifest');
    const runtimeDependencies = record(installedManifest.dependencies, 'installed package runtime dependencies');
    for (const dependency of Object.keys(runtimeDependencies)) {
      const installedDependency = await realpath(join(consumer, 'node_modules', dependency));
      expect(isWithin(consumer, installedDependency)).toBe(true);
      expect(isWithin(workspaceRoot, installedDependency)).toBe(false);
    }
    await expect(access(forbiddenStagedPackage)).rejects.toMatchObject({ code: 'ENOENT' });
    await cp(fixtureRoot, project, {
      filter: (source) => source !== join(fixtureRoot, '.agent-bundle') && source !== join(fixtureRoot, 'node_modules'),
      recursive: true,
    });
    await expect(access(join(project, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    const configSource = join(project, 'agent-bundle.config.ts');
    const skillSource = join(project, 'skills', 'review', 'SKILL.md');
    const [originalConfig, originalSkill] = await Promise.all([
      readFile(configSource, 'utf8'),
      readFile(skillSource, 'utf8'),
    ]);
    const fakeClaudeDirectory = await writeFakeClaude(project);
    const installedBinDirectory = join(consumer, 'node_modules', '.bin');
    const childPathEntries = [fakeClaudeDirectory, installedBinDirectory, dirname(process.execPath), '/usr/bin', '/bin'];
    expect(childPathEntries.some((entry) => isWithin(workspaceRoot, entry))).toBe(false);

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    let commandOutput = '';
    let commandStderr = '';
    const startInstalledServer = (serverPort: number): ChildProcess => {
      const nextChild = spawn(installedCli, [
        'dev', '--agent-api', '--no-open', '--port', String(serverPort), '--root', project,
      ], {
        cwd: consumer,
        env: {
          ...installedEnvironment(),
          AGENT_BUNDLE_AGENT_API_TOKEN: agentApiToken,
          PATH: childPathEntries.join(delimiter),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      nextChild.stdout?.on('data', (chunk: Buffer) => { commandOutput += chunk.toString(); });
      nextChild.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        commandOutput += text;
        commandStderr += text;
      });
      return nextChild;
    };
    child = startInstalledServer(port);
    await awaitReady(origin, child, () => commandOutput);
    for (const root of await readdir(tmpdir())) {
      if (productTemporaryRootPrefixes.some((prefix) => root.startsWith(prefix))) productTemporaryRootsBefore.add(root);
    }
    phase = 'browser startup status';
    const consoleErrorRecords: ConsoleErrorRecord[] = [];
    const pageErrors: Error[] = [];
    const appRouteRequests: Array<Record<string, unknown>> = [];
    const failedAppRouteRequests: Array<Record<string, unknown>> = [];
    const browserRequests: Array<{
      at: number;
      completedAt?: number;
      error?: string;
      method: string;
      origin: string;
      path: string;
      phase: string;
      respondedAt?: number;
      status?: number;
      url: string;
    }> = [];
    const browserRequestByPlaywrightRequest = new WeakMap<object, typeof browserRequests[number]>();
    const nativeRequests: Array<Record<string, unknown>> = [];
    let logsReplayResponses = 0;
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrorRecords.push(Object.freeze({ at: Date.now(), text: message.text(), url: message.location().url }));
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('response', (response) => {
      const url = new URL(response.url());
      const tracked = browserRequestByPlaywrightRequest.get(response.request());
      if (tracked !== undefined) {
        tracked.respondedAt = Date.now();
        tracked.status = response.status();
      }
      if (url.pathname === '/api/logs/replay') logsReplayResponses += 1;
      if (!isAppRoute(url)) return;
      const request = response.request();
      appRouteRequests.push(Object.freeze({
        frameUrl: request.frame().url(),
        isNavigation: request.isNavigationRequest(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        timing: request.timing(),
        path: url.pathname,
        url: response.url(),
      }));
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      const tracked = browserRequestByPlaywrightRequest.get(request);
      if (tracked !== undefined) {
        tracked.completedAt = Date.now();
        tracked.error = request.failure()?.errorText;
      }
      if (!isAppRoute(url)) return;
      failedAppRouteRequests.push(Object.freeze({
        error: request.failure()?.errorText,
        frameUrl: request.frame().url(),
        isNavigation: request.isNavigationRequest(),
        method: request.method(),
        resourceType: request.resourceType(),
        timing: request.timing(),
        path: url.pathname,
        url: request.url(),
      }));
    });
    page.on('requestfinished', (request) => {
      const tracked = browserRequestByPlaywrightRequest.get(request);
      if (tracked !== undefined) tracked.completedAt = Date.now();
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      const tracked = {
        at: Date.now(), method: request.method(), origin: url.origin, path: url.pathname, phase, url: request.url(),
      };
      browserRequests.push(tracked);
      browserRequestByPlaywrightRequest.set(request, tracked);
      if (request.method() !== 'POST' || url.pathname !== '/api/playground/runs') return;
      try {
        const body: unknown = JSON.parse(request.postData() ?? 'null');
        if (
          typeof body === 'object' && body !== null && !Array.isArray(body) &&
          (body as { readonly operation?: unknown }).operation === 'native.prompt'
        ) {
          nativeRequests.push(body as Record<string, unknown>);
        }
      } catch {
        // The test only records well-formed native Playground requests.
      }
    });
    const waitForBrowserRequestsAfter = async (startIndex: number): Promise<void> => {
      await expect.poll(() => browserRequests.slice(startIndex).filter((request) =>
        request.completedAt === undefined,
      ).map((request) => `${request.method} ${request.url}`), { timeout: browserTimeout }).toEqual([]);
    };
    await page.goto(`${origin}#overview`);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    const client = new Client({ name: 'packed-release-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: { token: async () => agentApiToken },
    });
    let appProxyOrigin: string | undefined;
    let clientClosed = false;
    try {
      phase = 'Agent API catalog tools';
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expectedAgentApiToolNames);

      const called = new Set<string>();
      const call = async (name: typeof expectedAgentApiToolNames[number], args?: Record<string, unknown>) => {
        called.add(name);
        return client.callTool({ ...(args === undefined ? {} : { arguments: args }), name });
      };
      const status = await call('project_status');
      let statusDto = record(status.structuredContent, 'project status').status;
      expect(statusDto).toEqual(expect.any(Object));
      let active = record(statusDto, 'project status DTO').artifact;
      for (let attempt = 0; attempt < 120 && record(active, 'project artifact').state !== 'active'; attempt += 1) {
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
        const next = await client.callTool({ name: 'project_status' });
        statusDto = record(next.structuredContent, 'project status').status;
        active = record(statusDto, 'project status DTO').artifact;
      }
      if (record(active, 'project artifact').state !== 'active') {
        throw new Error(`The public project status never reported an active artifact: ${JSON.stringify(statusDto)}; CLI output: ${commandOutput}`);
      }

      const skillsList = await call('skills_list', { target: 'portable' });
      const skillsPayload = record(skillsList.structuredContent, 'skills list');
      if (skillsPayload.skills === undefined) {
        throw new Error(`The packed skills list did not expose skills after active publication: ${JSON.stringify({ skills: skillsPayload, status: statusDto })}; CLI output: ${commandOutput}`);
      }
      const skills = record(skillsPayload.skills, 'skills list.skills').skills;
      const skill = firstRecord(skills, 'skills list.skills.skills');
      const skillId = string(skill.id, 'skill id');
      const inspectedSkill = await call('skill_inspect', { skill_id: skillId, target: 'portable' });
      expect(record(inspectedSkill.structuredContent, 'inspected skill').skill).toEqual(expect.objectContaining({ id: skillId }));
      const expectGeneratedSkill = async (
        label: string,
        expectedEpoch: string,
        expectedBodyMarker: string,
        epoch?: string,
      ): Promise<void> => {
        const inspected = await call('skill_inspect', {
          skill_id: skillId,
          target: 'portable',
          ...(epoch === undefined ? {} : { epoch }),
        });
        const inspectedSkill = record(record(inspected.structuredContent, `${label} inspection`).skill, `${label} skill`);
        expect(string(record(inspectedSkill.base, `${label} skill base`).epochId, `${label} skill epoch`))
          .toBe(expectedEpoch);
        expect(string(inspectedSkill.body, `${label} skill body`)).toContain(expectedBodyMarker);
      };

      const artifacts = await call('artifacts_list');
      const epoch = firstRecord(record(artifacts.structuredContent, 'artifact list').epochs, 'artifact list.epochs');
      const epochId = string(epoch.id, 'epoch id');
      const inspectedArtifact = await call('artifact_inspect', { epoch: epochId });
      expect(record(inspectedArtifact.structuredContent, 'artifact inspection').artifact).toEqual(expect.any(Object));

      const servers = await call('mcp_servers_list', { epoch: epochId, target: 'portable' });
      expect(record(servers.structuredContent, 'MCP server list').servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'fixture', target: 'portable' }),
      ]));
      const invoked = await call('mcp_invoke', {
        arguments: {}, epoch: epochId, server: 'fixture', target: 'portable', tool: 'show-dashboard',
      });
      expect(record(invoked.structuredContent, 'MCP invocation').result).toEqual(expect.objectContaining({
        content: [expect.objectContaining({ text: 'packed dashboard ready' })],
      }));

      const hooksList = await call('hooks_list', { epoch: epochId, target: 'claude' });
      const hook = firstRecord(record(hooksList.structuredContent, 'hook list').hooks, 'hook list.hooks');
      const hookId = string(record(hook.binding, 'hook binding').hook, 'hook id');
      const simulated = await call('hook_simulate', {
        epoch: epochId,
        hook: hookId,
        input: { cwd: '/workspace', sessionId: 'packed-release', source: 'packed-release', transcriptPath: '/workspace/transcript.json' },
        target: 'claude',
      });
      expect(record(record(simulated.structuredContent, 'hook simulation').simulation, 'hook simulation result').canonicalResult)
        .toEqual(expect.objectContaining({ outcome: 'continue' }));

      phase = 'Skills and Artifacts pages';
      await page.goto(`${origin}#skills`);
      await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
      await page.goto(`${origin}#artifacts`);
      await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'Artifact tree' })).toBeVisible({ timeout: browserTimeout });

      phase = 'Hooks page simulation';
      const hookListing = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/hooks');
      await page.goto(`${origin}#hooks`);
      phase = 'Hooks page heading';
      await expect(page.getByRole('heading', { name: 'Hooks' })).toBeVisible({ timeout: browserTimeout });
      phase = 'Hooks catalog';
      const hookListingResponse = await hookListing;
      if (!hookListingResponse.ok()) throw new Error(`The Hooks page list route failed with ${hookListingResponse.status()}: ${await hookListingResponse.text()}`);
      await expect.poll(async () => page.locator('#hook-binding option').count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      await page.locator('#hook-binding').selectOption({ index: 0 });
      phase = 'Hooks input';
      await page.locator('#hook-canonical-input').fill(JSON.stringify({
        cwd: '/workspace', sessionId: 'packed-browser', source: 'packed-browser', transcriptPath: '/workspace/transcript.json',
      }));
      phase = 'Hooks submit';
      const hookSimulation = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/hooks/simulations');
      await page.getByRole('button', { name: 'Run simulation' }).click();
      phase = 'Hooks result';
      const hookSimulationResponse = await hookSimulation;
      if (!hookSimulationResponse.ok()) throw new Error(`The Hooks page simulation failed with ${hookSimulationResponse.status()}: ${await hookSimulationResponse.text()}`);
      expect(await hookSimulationResponse.json()).toMatchObject({
        simulation: { canonicalResult: { additionalContext: 'packed:packed-browser', outcome: 'continue' } },
      });
      await expect(page.getByRole('heading', { name: 'Canonical result' })).toBeVisible({ timeout: browserTimeout });

      phase = 'MCP, Inspector, and App pages';
      await page.goto(`${origin}#mcp`);
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#mcp-target').selectOption('portable');
      await page.locator('#mcp-server-name').fill('fixture');
      const openedOldBrowserMcpSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Open MCP session' }).click();
      const oldBrowserMcpSessionResponse = record(await (await openedOldBrowserMcpSession).json(), 'old browser MCP session response');
      const oldBrowserMcpSessionId = string(record(oldBrowserMcpSessionResponse.session, 'old browser MCP session').id, 'old browser MCP session id');
      await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: 'show-dashboard', exact: true }).click();
      await page.getByRole('button', { name: 'Call show-dashboard' }).click();
      const mcpHistory = page.getByRole('region', { name: 'Invocation history' });
      await expect(mcpHistory).toContainText('packed dashboard ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: /Open App preview for mcp-page-1/u }).click();
      const appPreview = page.locator('iframe[title="MCP App preview: show-dashboard"]');
      await expect(appPreview).toBeVisible({ timeout: browserTimeout });
      const appPreviewSource = await appPreview.getAttribute('src');
      if (appPreviewSource === null) throw new Error('The packed MCP App preview does not expose a proxy source.');
      appProxyOrigin = new URL(appPreviewSource, origin).origin;
      expect(appProxyOrigin).not.toBe(origin);
      await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
      const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
      if (appFrame === undefined) throw new Error('The packed MCP App proxy did not create an App frame.');
      await expect(appFrame.locator('#view')).toHaveText('packed release dashboard', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Inspector' }).click();
      await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
      const inspector = page.locator('[aria-label="MCP Inspector presentation"]');
      await expect(inspector.getByText('show-dashboard', { exact: true })).toBeVisible({ timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Playground' }).click();
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });

      phase = 'Logs, Evals, and Comparisons pages';
      await page.goto(`${origin}#logs`);
      phase = 'Logs page heading';
      await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
      const initialEvalsRequestIndex = browserRequests.length;
      await page.goto(`${origin}#evals`);
      phase = 'Evals page heading';
      await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
      phase = 'Evals suite catalog';
      await expect(page.getByLabel('Suite')).toContainText('packed-deterministic', { timeout: browserTimeout });
      await waitForBrowserRequestsAfter(initialEvalsRequestIndex);
      const initialComparisonsRequestIndex = browserRequests.length;
      await page.goto(`${origin}#comparisons`);
      phase = 'Comparisons page heading';
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      await waitForBrowserRequestsAfter(initialComparisonsRequestIndex);

      phase = 'Playground direct skill';
      await page.goto(`${origin}#playground`);
      await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#playground-target').selectOption('portable');
      await page.locator('#playground-skill-id').fill(skillId);
      await page.getByRole('button', { name: 'Start run' }).click();
      await expect(page.getByText('skill.inspected')).toBeVisible({ timeout: browserTimeout });

      phase = 'Playground direct hook';
      await page.locator('#playground-operation').selectOption('hook.simulate');
      await page.locator('#playground-target').selectOption('claude');
      await page.locator('#playground-hook').fill(hookId);
      await page.locator('#playground-hook-input').fill(JSON.stringify({
        cwd: '/workspace', sessionId: 'packed-playground', source: 'packed-playground', transcriptPath: '/workspace/transcript.json',
      }));
      await page.getByRole('button', { name: 'Start run' }).click();
      await expect(page.getByText('hook.simulated')).toBeVisible({ timeout: browserTimeout });

      phase = 'Playground direct MCP';
      await page.locator('#playground-operation').selectOption('mcp.call-tool');
      await page.locator('#playground-target').selectOption('portable');
      await page.locator('#playground-mcp-server').fill('fixture');
      await page.locator('#playground-mcp-tool').fill('show-dashboard');
      await page.locator('#playground-mcp-arguments').fill('{}');
      await page.getByRole('button', { name: 'Start run' }).click();
      await expect(page.getByText('mcp.tool.called')).toBeVisible({ timeout: browserTimeout });

      phase = 'Playground direct script';
      await page.locator('#playground-operation').selectOption('script.run');
      await page.locator('#playground-target').selectOption('portable');
      await expect(page.locator('#playground-script-id option[value="script:review"]')).toBeAttached({ timeout: browserTimeout });
      await page.locator('#playground-script-id').selectOption('script:review');
      const scriptAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Run script' }).click();
      const scriptRun = record(record(await (await scriptAdmitted).json(), 'direct script admission').run, 'direct script run');
      const scriptSession = record(scriptRun.session, 'direct script session');
      const scriptSessionId = string(scriptSession.id, 'direct script session id');
      await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.playground-trace')).toContainText('packed release script stdout', { timeout: browserTimeout });
      const scriptCompletedCard = page.locator('details.playground-event-card').filter({
        has: page.getByText('script.completed', { exact: true }),
      }).last();
      await expect(scriptCompletedCard).toBeVisible({ timeout: browserTimeout });
      const scriptCompletedCheckbox = scriptCompletedCard.getByRole('checkbox');
      const scriptCompletedLabel = await scriptCompletedCheckbox.getAttribute('aria-label');
      const scriptCompletedReference = /^Select (events\.jsonl#\d+) for the draft eval case$/u.exec(scriptCompletedLabel ?? '')?.[1];
      if (scriptCompletedReference === undefined) throw new Error('The completed direct script trace did not expose a persisted raw event reference.');
      const exportedScriptResponse = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/sessions/${encodeURIComponent(scriptSessionId)}/export` &&
        response.request().method() === 'GET' && response.ok(),
      );
      await page.getByRole('button', { name: 'Export trace' }).click();
      const exportedScriptTrace = record(record(await (await exportedScriptResponse).json(), 'direct script export response').export, 'direct script export');
      expect(string(record(exportedScriptTrace.session, 'direct script exported session').id, 'direct script exported session id')).toBe(scriptSessionId);
      expect(exportedScriptTrace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'script.completed', rawEventRef: scriptCompletedReference }),
      ]));
      await expect(page.getByRole('heading', { name: 'Exported trace' })).toBeVisible({ timeout: browserTimeout });
      const exportedScriptSection = page.getByRole('heading', { name: 'Exported trace' }).locator('..');
      await expect(exportedScriptSection).toContainText(scriptSessionId);
      await expect(exportedScriptSection).toContainText(scriptCompletedReference);
      const scriptSelectedCheckbox = scriptCompletedCheckbox;
      await scriptSelectedCheckbox.check();
      await expect(page.getByRole('button', { name: 'Promote to draft eval case' })).toBeEnabled({ timeout: browserTimeout });
      const promotedScriptResponse = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/sessions/${encodeURIComponent(scriptSessionId)}/draft-eval` &&
        response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Promote to draft eval case' }).click();
      const promotedScriptResult = await promotedScriptResponse;
      expect(promotedScriptResult.request().postDataJSON()).toEqual({ rawEventRefs: [scriptCompletedReference] });
      const promotedScriptDraft = record(record(await promotedScriptResult.json(), 'direct script draft response').draftEvalCase, 'direct script draft');
      const promotedScriptAssertion = firstRecord(promotedScriptDraft.assertions, 'direct script draft assertions');
      expect(record(promotedScriptAssertion.evidence, 'direct script draft evidence').rawEventRef).toBe(scriptCompletedReference);
      expect(record(promotedScriptAssertion.expectation, 'direct script draft expectation').kind).toBe('script.completed');
      await expect(page.getByRole('heading', { name: 'Draft eval case' })).toBeVisible({ timeout: browserTimeout });
      const promotedScriptSection = page.getByRole('heading', { name: 'Draft eval case' }).locator('..');
      await expect(promotedScriptSection).toContainText(scriptCompletedReference);
      await expect(promotedScriptSection).toContainText('script.completed');

      const activeEpochFrom = (toolResult: Awaited<ReturnType<typeof client.callTool>>, label: string) => {
        const resultStatus = record(record(toolResult.structuredContent, `${label} result`).status, `${label} status`);
        const artifactStatus = record(resultStatus.artifact, `${label} artifact`);
        return { artifactStatus, epochId: string(record(artifactStatus.activeEpoch, `${label} active epoch`).id, `${label} epoch id`) };
      };
      const rebuildFromOverview = async (label: string): Promise<void> => {
        const rebuilt = page.waitForResponse((response) =>
          response.url() === `${origin}/api/project/rebuild` && response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Rebuild' }).click();
        const response = await rebuilt;
        if (!response.ok()) throw new Error(`${label} rebuild returned HTTP ${response.status()}: ${await response.text()}`);
      };
      const settleNativeSelection = (): Promise<void> => page.evaluate(async () => {
        await new Promise<void>((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise())));
      });
      const selectNativePrompt = async (prompt: string): Promise<void> => {
        await page.locator('#playground-operation').selectOption('native.prompt');
        await expect(page.locator('#playground-native-host')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-target').selectOption('claude');
        await settleNativeSelection();
        await expect(page.locator('#playground-native-case option').nth(1)).toBeAttached({ timeout: browserTimeout });
        await page.locator('#playground-native-case').selectOption({ index: 1 });
        await settleNativeSelection();
        await page.locator('#playground-native-host').selectOption('claude');
        await settleNativeSelection();
        await expect(page.locator('#playground-native-fixture')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-fixture').selectOption({ index: 1 });
        await settleNativeSelection();
        await expect(page.locator('#playground-native-model-pin')).toBeEnabled({ timeout: browserTimeout });
        await page.locator('#playground-native-model-pin').selectOption({ index: 1 });
        await page.locator('#playground-native-prompt').fill(prompt);
        await expect(page.getByRole('button', { name: 'Start native prompt' })).toBeEnabled({ timeout: browserTimeout });
      };

      phase = 'Playground native epoch A admission';
      await selectNativePrompt('Wait for packed native cancellation.');
      const nativeAAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      const nativeAAdmission = record(await (await nativeAAdmitted).json(), 'native epoch A admission');
      const nativeARunId = string(record(nativeAAdmission.run, 'native epoch A run').id, 'native epoch A run id');
      await expect(page.getByText('native.host.started')).toBeVisible({ timeout: browserTimeout });
      if (child?.pid === undefined) throw new Error('The packed dev server process did not expose a PID.');
      const nativeOperationDescendants = await descendantProcessIds(child.pid);
      expect(nativeOperationDescendants).not.toHaveLength(0);
      for (const processId of nativeOperationDescendants) {
        expect(processId).not.toBe(child.pid);
        observedOperationDescendantProcessIds.add(processId);
        trackedProcessIds.add(processId);
      }
      const nativeRequestA = nativeRequests.at(-1);
      if (nativeRequestA === undefined) throw new Error('The packed epoch-A native operation did not issue a request.');
      const nativeEpochA = string(nativeRequestA.epochId, 'epoch-A native request epoch id');
      const nativePinA = string(nativeRequestA.modelPinId, 'epoch-A native request model pin id');
      expect(nativeEpochA).toBe(epochId);

      phase = 'good edit rebuild B';
      const epochBMarker = 'Epoch B changed the packed review guidance.';
      await writeFile(skillSource, `${originalSkill}\n\n${epochBMarker}\n`);
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
      await rebuildFromOverview('epoch B');
      const epochBStatus = activeEpochFrom(await call('project_status'), 'epoch B');
      expect(epochBStatus.artifactStatus.state).toBe('active');
      const epochB = epochBStatus.epochId;
      expect(epochB).not.toBe(epochId);
      const sameClientOnB = await call('skills_list', { target: 'portable' });
      expect(record(sameClientOnB.structuredContent, 'same client epoch B skills').skills).toEqual(expect.any(Object));
      await expectGeneratedSkill('same client epoch B', epochB, epochBMarker);

      phase = 'artifact epoch diff';
      await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#artifact-diff-base').fill(epochId);
      await page.getByRole('button', { name: 'Compare epochs' }).click();
      await expect(page.getByRole('heading', { name: 'Epoch diff' })).toBeVisible({ timeout: browserTimeout });
      const changedRows = page.locator('.artifact-diff-group').filter({
        has: page.getByRole('heading', { name: /^Changed \([1-9][0-9]*\)$/u }),
      }).locator('tbody tr');
      await expect(changedRows).not.toHaveCount(0, { timeout: browserTimeout });
      const changedCells = await changedRows.first().locator('th, td').allTextContents();
      expect(changedCells).toHaveLength(5);
      expect(changedCells[0]).toContain('SKILL.md');
      expect(changedCells[1]).not.toBe(changedCells[3]);
      expect(changedCells[2]).not.toBe(changedCells[4]);

      phase = 'pinned epoch-A native cancellation';
      await page.getByRole('link', { name: 'Playground', exact: true }).click();
      await expect(page.getByText(nativeEpochA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText(nativePinA, { exact: true })).toBeVisible({ timeout: browserTimeout });
      const nativeACancelled = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === `/api/playground/runs/${encodeURIComponent(nativeARunId)}/cancel` &&
          url.search.length === 0 && response.request().method() === 'POST' && response.status() === 200;
      });
      const cancelRun = page.getByRole('button', { name: 'Cancel run', exact: true });
      await cancelRun.click();
      await expect(page.getByRole('button', { name: 'Cancelling…', exact: true })).toBeVisible({ timeout: browserTimeout });
      expect(await (await nativeACancelled).json()).toEqual({ cancelled: true });
      await expect(page.getByRole('button', { name: 'Cancelling…', exact: true })).toBeHidden({ timeout: browserTimeout });
      await expect(cancelRun).toBeDisabled({ timeout: browserTimeout });
      await expect(page.getByText('operation.cancelled')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('epoch.bound')).toBeVisible({ timeout: browserTimeout });

      phase = 'invalid edit retains stale epoch B';
      const invalidConfig = originalConfig.replace('ui://packed-release/dashboard.html', 'https://packed-release.example/dashboard.html');
      if (invalidConfig === originalConfig) throw new Error('The packed fixture did not contain the resource URI used for the invalid rebuild.');
      await writeFile(configSource, invalidConfig);
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
      await rebuildFromOverview('invalid epoch B');
      const staleStatus = activeEpochFrom(await call('project_status'), 'stale epoch B');
      expect(staleStatus.artifactStatus.state).toBe('stale');
      expect(staleStatus.epochId).toBe(epochB);
      const staleDiagnostics = await client.callTool({ name: 'diagnostics_list' });
      const staleDiagnosticRows = record(staleDiagnostics.structuredContent, 'stale diagnostics').diagnostics;
      expect(Array.isArray(staleDiagnosticRows)).toBe(true);
      expect(staleDiagnosticRows).not.toHaveLength(0);
      await expectGeneratedSkill('stale epoch B', epochB, epochBMarker);

      phase = 'repaired edit rebuild C';
      const epochCMarker = 'Epoch C repaired the packed review guidance.';
      await Promise.all([
        writeFile(configSource, originalConfig),
        writeFile(skillSource, `${originalSkill}\n\n${epochCMarker}\n`),
      ]);
      await rebuildFromOverview('epoch C');
      const epochCStatus = activeEpochFrom(await call('project_status'), 'epoch C');
      expect(epochCStatus.artifactStatus.state).toBe('active');
      const epochC = epochCStatus.epochId;
      expect(epochC).not.toBe(epochB);
      const retainedEpochA = await call('skills_list', { epoch: epochId, target: 'portable' });
      expect(record(retainedEpochA.structuredContent, 'retained epoch-A skills').skills).toEqual(expect.any(Object));
      await expectGeneratedSkill('same client epoch C', epochC, epochCMarker);

      phase = 'Playground native fake-host epoch C';
      await page.getByRole('link', { name: 'Playground', exact: true }).click();
      await selectNativePrompt('Complete the packed native fixture.');
      const nativeCAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/playground/runs` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Start native prompt' }).click();
      expect(record(await (await nativeCAdmitted).json(), 'native epoch C admission').run).toEqual(expect.any(Object));
      await expect(page.getByText('native.response')).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('Packed native fixture completed.', { exact: true })).toBeVisible({ timeout: browserTimeout });
      const nativeRequestC = nativeRequests.at(-1);
      if (nativeRequestC === undefined) throw new Error('The packed epoch-C native operation did not issue a request.');
      expect(string(nativeRequestC.epochId, 'epoch-C native request epoch id')).toBe(epochC);

      phase = 'Logs after rebuilds';
      const logsReplay = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/logs/replay');
      await page.getByRole('link', { name: 'Logs', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
      const logsReplayResponse = await logsReplay;
      if (!logsReplayResponse.ok()) throw new Error(`The packed Logs replay route returned HTTP ${logsReplayResponse.status()}: ${await logsReplayResponse.text()}`);
      const logsReplayPayload = record(record(await logsReplayResponse.json(), 'packed Logs replay').replay, 'packed Logs replay result');
      const logRecords = logsReplayPayload.records;
      if (!Array.isArray(logRecords) || logRecords.length === 0) {
        throw new Error(`The packed Logs replay is empty after B/C rebuilds: ${JSON.stringify(logRecords)}`);
      }
      await expect.poll(async () => page.locator('.logs-entries > li').count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      const hookLog = logRecords.map((value, index) => record(value, `packed log record ${index}`)).find((value) =>
        value.producer === 'hook' && value.kind === 'hook.simulate.completed',
      );
      if (hookLog === undefined) throw new Error('The packed Logs replay did not retain a completed Hook simulation record.');
      const hookLogText = JSON.stringify(hookLog);
      expect(hookLogText).not.toContain('/workspace');
      expect(hookLogText).not.toContain(agentApiToken);
      if (typeof hookLog.sequence !== 'number') throw new Error('The completed Hook log record does not have a numeric sequence.');
      const hookLogSequence = String(hookLog.sequence);
      const hookLogEntry = page.locator('.logs-entries > li').filter({ hasText: `#${hookLogSequence}` });
      await expect(hookLogEntry).toContainText('hook.simulate.completed', { timeout: browserTimeout });
      await hookLogEntry.locator('summary').click();
      await expect(hookLogEntry.locator('.logs-details')).toContainText('outcome');
      await expect(hookLogEntry.locator('.logs-details')).not.toContainText('/workspace');

      phase = 'Logs live Agent API update and filters';
      const logsUrlBeforeLiveUpdate = page.url();
      const logEntriesBeforeLiveUpdate = await page.locator('.logs-entries > li').count();
      const logReplaysBeforeLiveUpdate = logsReplayResponses;
      const liveHookSimulation = await call('hook_simulate', {
        epoch: epochC,
        hook: hookId,
        input: {
          cwd: '/workspace',
          sessionId: 'packed-live-logs',
          source: 'packed-live-logs',
          transcriptPath: '/workspace/packed-live-logs.json',
        },
        target: 'claude',
      });
      expect(record(record(liveHookSimulation.structuredContent, 'live Hook simulation').simulation, 'live Hook simulation result').canonicalResult)
        .toEqual(expect.objectContaining({ outcome: 'continue' }));
      await expect.poll(async () => page.locator('.logs-entries > li').count(), { timeout: browserTimeout })
        .toBeGreaterThan(logEntriesBeforeLiveUpdate);
      expect(page.url()).toBe(logsUrlBeforeLiveUpdate);
      expect(logsReplayResponses).toBe(logReplaysBeforeLiveUpdate);

      const expectedLiveLogProducer = 'hook';
      await page.locator('#logs-producer').selectOption(expectedLiveLogProducer);
      await page.locator('#logs-level').selectOption('info');
      await page.locator('#logs-kind').selectOption('hook.simulate.completed');
      await page.locator('#logs-context').selectOption(hookId);
      const matchingLiveHookEntries = page.locator('.logs-entries > li');
      await expect.poll(async () => matchingLiveHookEntries.count(), { timeout: browserTimeout }).toBeGreaterThan(0);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-source').allTextContents())]).toEqual(['hook']);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-level').allTextContents())]).toEqual(['info']);
      expect([...new Set(await matchingLiveHookEntries.locator('.logs-entry-kind').allTextContents())]).toEqual(['hook.simulate.completed']);
      await expect(matchingLiveHookEntries.first()).toContainText(`hookId ${hookId}`);
      await expect(matchingLiveHookEntries.first().locator('.logs-details')).toContainText('outcome');
      await page.locator('#logs-level').selectOption('error');
      await expect.poll(async () => matchingLiveHookEntries.count(), { timeout: browserTimeout }).toBe(0);
      await expect(page.getByText('No production log record matches this filter.')).toBeVisible({ timeout: browserTimeout });

      phase = 'Agent API Eval tools';
      const listed = await call('evals_list');
      const suites = record(record(listed.structuredContent, 'eval list').suites, 'eval suites').suites;
      expect(suites).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'packed-deterministic' }),
        expect.objectContaining({ name: 'packed-native' }),
      ]));
      const started = await call('eval_run', {
        case_ids: ['deterministic-review'], suites: ['packed-deterministic'], trials: 1,
      });
      const startedPayload = record(started.structuredContent, 'eval start');
      if (startedPayload.run === undefined) {
        const agentEvalList = await client.callTool({ name: 'evals_list' });
        const diagnostics = await client.callTool({ name: 'diagnostics_list' });
        const bootstrap = await fetch(`${origin}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
        const session = record(await bootstrap.json(), 'browser session');
        const list = await fetch(`${origin}/api/evals/runs`, {
          headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
        });
        const listedRuns = record(await list.json(), 'public eval runs').runs;
        const runProbes = await Promise.all((Array.isArray(listedRuns) ? listedRuns : []).map(async (listedRun) => {
          const runId = string(record(listedRun, 'public eval run').id, 'public eval run id');
          const [run, events] = await Promise.all([
            fetch(`${origin}/api/evals/runs/${encodeURIComponent(runId)}`, {
              headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
            }),
            fetch(`${origin}/api/evals/runs/${encodeURIComponent(runId)}/events?after=0`, {
              headers: { 'x-agent-bundle-session': string(session.token, 'browser session token') },
            }),
          ]);
          return {
            events: { body: await events.text(), status: events.status },
            run: { body: await run.text(), status: run.status },
            runId,
          };
        }));
        throw new Error(`The packed deterministic eval did not start: ${JSON.stringify({
          agentEvalList: agentEvalList.structuredContent,
          diagnostics: diagnostics.structuredContent,
          postFailureRuns: runProbes,
          started: startedPayload,
        })}; CLI stderr: ${commandStderr}`);
      }
      const run = record(startedPayload.run, 'started eval');
      const runId = string(run.id, 'run id');
      await expect.poll(async () => {
        const read = await client.callTool({ arguments: { run_id: runId }, name: 'eval_get' });
        const result = record(record(read.structuredContent, 'eval read').run, 'recorded eval result');
        return record(result.run, 'recorded eval').completedAt;
      }, { timeout: browserTimeout }).toEqual(expect.any(String));
      const completedAgentEval = record(record((await client.callTool({ arguments: { run_id: runId }, name: 'eval_get' })).structuredContent, 'completed eval read').run, 'completed recorded eval');
      const completedAgentRun = record(completedAgentEval.run, 'completed agent eval run');
      expect(completedAgentRun.completedAt).toEqual(expect.any(String));
      const completedAgentSummary = record(completedAgentRun.summary, 'completed agent eval summary');
      expect(completedAgentSummary).toEqual({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });
      expect(completedAgentEval.trials).toEqual(expect.arrayContaining([
        expect.objectContaining({ caseId: 'deterministic-review', host: 'portable', model: 'deterministic', outcome: 'pass' }),
      ]));
      called.add('eval_get');

      phase = 'Evals live evidence and comparisons';
      const evalsBrowserRequestIndex = browserRequests.length;
      await page.getByRole('link', { name: 'Evals', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
      await page.getByLabel('Suite').selectOption('packed-deterministic');
      await page.getByLabel('Harness').selectOption('deterministic');
      const uiEvalAdmitted = page.waitForResponse((response) =>
        response.url() === `${origin}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202,
      );
      await page.getByRole('button', { name: 'Run deterministic suite' }).click();
      const uiEval = record(await (await uiEvalAdmitted).json(), 'browser eval admission').run;
      const uiEvalRunId = string(record(uiEval, 'browser eval run').id, 'browser eval run id');
      phase = 'Evals UI completion';
      try {
        await expect(page.getByText(`Run ${uiEvalRunId} finished:`)).toBeVisible({ timeout: browserTimeout });
      } catch (error) {
        throw new Error(`The packed browser eval did not render its finalized run: ${JSON.stringify({
          errors: await page.locator('.request-error').allTextContents(),
          summaries: await page.locator('.eval-summary').allTextContents(),
          timeline: await page.locator('.eval-timeline strong').allTextContents(),
        })}`, { cause: error });
      }
      phase = 'Evals durable evidence';
      await expect(page.getByRole('heading', { name: 'Durable event timeline' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('heading', { name: 'Host / model matrix' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.eval-counts')).toHaveText('1 passed · 0 failed · 0 inconclusive', { timeout: browserTimeout });
      await expect(page.locator('.eval-timeline .eval-event-sequence')).not.toHaveCount(0, { timeout: browserTimeout });
      await expect(page.locator('.eval-timeline')).toContainText('run.completed');
      await expect(page.locator('.eval-host-models')).toContainText('portable');
      await expect(page.locator('.eval-host-models')).toContainText('deterministic');
      await expect(page.locator('.eval-host-models')).toContainText('Pass');
      await expect(page.locator('.eval-trial-provenance').first()).toContainText('agent-bundle@0.1.0');
      await expect(page.locator('.eval-trial-provenance').first()).toContainText('automatic');
      await page.getByRole('button', { name: 'Preview safe text' }).first().click();
      await expect(page.locator('.eval-raw-result')).toContainText('The deterministic packed fixture passed.', { timeout: browserTimeout });
      await waitForBrowserRequestsAfter(evalsBrowserRequestIndex);
      phase = 'Evals comparison run availability';
      await page.getByRole('link', { name: 'Comparisons', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      await expect.poll(async () => page.locator('#comparison-base option').count(), { timeout: browserTimeout }).toBeGreaterThanOrEqual(2);
      phase = 'Evals comparison matrix';
      await page.locator('#comparison-base').selectOption(runId);
      await page.locator('#comparison-candidate').selectOption(uiEvalRunId);
      await page.getByRole('button', { name: 'Compare runs' }).click();
      await expect(page.locator('.comparison-matrix table')).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.comparison-matrix')).toContainText(
        'CLI agent-bundle@0.1.0 · Invocation automatic · Semantic grader none',
      );

      phase = 'foreground restart/reconnect';
      const comparisonsHashBeforeRestart = new URL(page.url()).hash;
      expect(comparisonsHashBeforeRestart).toBe('#comparisons');
      if (child === undefined) throw new Error('The packed dev server child was not created.');
      const stoppedChild = child;
      if (stoppedChild.pid !== undefined) {
        trackedProcessIds.add(stoppedChild.pid);
        for (const processId of await descendantProcessIds(stoppedChild.pid)) trackedProcessIds.add(processId);
      }
      const outageStartedAt = Date.now();
      const recoveredBrowserSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/project/session` && response.request().method() === 'GET' && response.ok(),
      );
      await closeChild(stoppedChild);
      phase = 'foreground restart/reconnect disconnected state';
      await expect(page.getByRole('heading', { name: 'Foreground connection unavailable' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText('Waiting for the foreground server to recover.')).toBeVisible({ timeout: browserTimeout });
      phase = 'foreground restart/reconnect browser recovery';
      child = startInstalledServer(port);
      await awaitReady(origin, child, () => commandOutput);
      await expect(page.locator('.connection')).toContainText('Foreground server connected', { timeout: browserTimeout });
      const recoveredBrowserSessionResponse = await recoveredBrowserSession;
      const recoveredBrowserSessionPayload = record(await recoveredBrowserSessionResponse.json(), 'recovered browser session');
      const browserGenerationBToken = string(recoveredBrowserSessionPayload.token, 'recovered browser session token');
      const recoveredBrowserSessionRequest = browserRequestByPlaywrightRequest.get(recoveredBrowserSessionResponse.request());
      if (recoveredBrowserSessionRequest?.completedAt === undefined) throw new Error('The recovered browser session was not recorded as a completed request.');
      const recoveredAt = recoveredBrowserSessionRequest.completedAt;
      expect(new URL(page.url()).hash).toBe(comparisonsHashBeforeRestart);
      await expect(page.getByRole('heading', { name: 'Comparisons' })).toBeVisible({ timeout: browserTimeout });
      const rebuiltWithRecoveredSession = page.waitForResponse((response) =>
        response.url() === `${origin}/api/project/rebuild` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await page.getByRole('button', { name: 'Rebuild' }).click();
      const rebuiltWithRecoveredSessionResponse = await rebuiltWithRecoveredSession;
      expect(rebuiltWithRecoveredSessionResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      phase = 'foreground restart/reconnect Agent API recovery';
      const recoveredStatus = await client.callTool({ name: 'project_status' });
      const recoveredEpochStatus = activeEpochFrom(recoveredStatus, 'recovered project status');
      expect(recoveredEpochStatus.artifactStatus).toEqual(expect.objectContaining({ state: 'active' }));
      const recoveredEpochId = recoveredEpochStatus.epochId;

      phase = 'foreground restart/reconnect fresh B browser MCP session';
      await page.getByRole('link', { name: 'MCP playground', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeVisible({ timeout: browserTimeout });
      await page.locator('#mcp-epoch').selectOption(recoveredEpochId);
      await expect(page.locator('#mcp-epoch')).toHaveValue(recoveredEpochId);
      await page.locator('#mcp-target').selectOption('portable');
      await page.locator('#mcp-server-name').fill('fixture');
      const openedBrowserMcpSessionB = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions` && response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Open MCP session' }).click();
      const browserMcpSessionBResponse = await openedBrowserMcpSessionB;
      expect(browserMcpSessionBResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      const browserMcpSessionB = record(await browserMcpSessionBResponse.json(), 'B browser MCP session response');
      const browserMcpSessionBRecord = record(browserMcpSessionB.session, 'B browser MCP session');
      const browserMcpSessionBId = string(browserMcpSessionBRecord.id, 'B browser MCP session id');
      const browserMcpSessionBRequest = browserRequestByPlaywrightRequest.get(browserMcpSessionBResponse.request());
      if (browserMcpSessionBRequest === undefined) throw new Error('The fresh B browser MCP session admission was not recorded.');
      const browserMcpSessionBOpenedAt = browserMcpSessionBRequest.at;
      expect(browserMcpSessionBId).not.toBe(oldBrowserMcpSessionId);
      expect(record(browserMcpSessionBRecord.binding, 'B browser MCP session binding').epochId).toBe(recoveredEpochId);
      await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
      await page.getByRole('button', { name: 'show-dashboard', exact: true }).click();
      const browserMcpSessionBOperation = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions/${encodeURIComponent(browserMcpSessionBId)}/operations` &&
        response.request().method() === 'POST' && response.ok(),
      );
      await page.getByRole('button', { name: 'Call show-dashboard' }).click();
      await browserMcpSessionBOperation;
      await expect(page.getByRole('region', { name: 'Invocation history' })).toContainText('packed dashboard ready', { timeout: browserTimeout });
      const closedBrowserMcpSessionB = page.waitForResponse((response) =>
        response.url() === `${origin}/api/mcp/sessions/${encodeURIComponent(browserMcpSessionBId)}` &&
        response.request().method() === 'DELETE' && response.ok(),
      );
      const browserMcpSessionBCloseStartedAt = Date.now();
      await page.getByRole('button', { name: 'Close MCP session' }).click();
      const closedBrowserMcpSessionBResponse = await closedBrowserMcpSessionB;
      expect(closedBrowserMcpSessionBResponse.request().headers()['x-agent-bundle-session']).toBe(browserGenerationBToken);
      await expect(page.locator('.mcp-page-phase')).toContainText('Session closed', { timeout: browserTimeout });
      const browserMcpSessionBCloseCompletedAt = Date.now();

      phase = 'mobile overflow floor';
      await page.setViewportSize({ height: 844, width: 390 });
      const mobileNavigationRequestIndex = browserRequests.length;
      const mobileRoutes: readonly Readonly<{ heading: string; label: string }>[] = [
        { heading: 'Project overview', label: 'Overview' }, { heading: 'Skills', label: 'Skills' }, { heading: 'Hooks', label: 'Hooks' },
        { heading: 'MCP playground', label: 'MCP playground' }, { heading: 'Artifacts', label: 'Artifacts' }, { heading: 'Playground', label: 'Playground' },
        { heading: 'Logs', label: 'Logs' }, { heading: 'Evals', label: 'Evals' }, { heading: 'Comparisons', label: 'Comparisons' },
      ];
      const postRecoveryNavigationUrls = new Map<string, readonly string[]>([
        ['Hooks', [`${origin}/api/hooks?epochId=${encodeURIComponent(recoveredEpochId)}`]],
        ['Playground', [`${origin}/api/playground/catalog?epochId=${encodeURIComponent(recoveredEpochId)}`]],
        ['Logs', [`${origin}/api/logs/replay?after=0`]],
        ['Evals', [`${origin}/api/evals/suites`, `${origin}/api/evals/runs`]],
        ['Comparisons', [`${origin}/api/evals/runs`]],
      ]);
      const postRecoveryNavigation: Array<Readonly<{ leftAt: number; openedAt: number; url: string }>> = [];
      let activeMobileRoute: Readonly<{ openedAt: number; urls?: readonly string[] }> | undefined;
      const leaveActiveMobileRoute = (leftAt: number): void => {
        if (activeMobileRoute === undefined) return;
        for (const url of activeMobileRoute.urls ?? []) postRecoveryNavigation.push(Object.freeze({
          leftAt, openedAt: activeMobileRoute.openedAt, url,
        }));
        activeMobileRoute = undefined;
      };
      for (const route of mobileRoutes) {
        const openedAt = Date.now();
        leaveActiveMobileRoute(openedAt);
        await page.getByRole('link', { name: route.label, exact: true }).click();
        await expect(page.getByRole('heading', { name: route.heading })).toBeVisible({ timeout: browserTimeout });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        activeMobileRoute = Object.freeze({ openedAt, urls: postRecoveryNavigationUrls.get(route.label) });
      }
      leaveActiveMobileRoute(Date.now());
      await page.getByRole('link', { name: 'Overview', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
      await waitForBrowserRequestsAfter(mobileNavigationRequestIndex);

      phase = 'foreground outage ledger quiet fence';
      const requestFailuresBeforeQuietFence = browserRequests.filter((request) => request.error !== undefined);
      const quietFenceBaseline = Object.freeze({
        consoleErrors: consoleErrorRecords.length,
        pageErrors: pageErrors.length,
        requestFailures: requestFailuresBeforeQuietFence.length,
      });
      await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 1_000); });
      const requestFailuresAfterQuietFence = browserRequests.filter((request) => request.error !== undefined);
      assertLedger(consoleErrorRecords.length === quietFenceBaseline.consoleErrors && pageErrors.length === quietFenceBaseline.pageErrors &&
        requestFailuresAfterQuietFence.length === quietFenceBaseline.requestFailures,
      `quiet fence observed new console, page, or requestfailed events: ${JSON.stringify({
        after: { consoleErrors: consoleErrorRecords.length, pageErrors: pageErrors.length, requestFailures: requestFailuresAfterQuietFence.length },
        before: quietFenceBaseline,
        newRequestFailures: requestFailuresAfterQuietFence.slice(requestFailuresBeforeQuietFence.length),
      })}`);
      validateOutageLedger({
        consoleErrors: consoleErrorRecords,
        oldSessionId: oldBrowserMcpSessionId,
        origin,
        outageStartedAt,
        postRecovery: Object.freeze({
          freshMcpSession: Object.freeze({
            closeCompletedAt: browserMcpSessionBCloseCompletedAt,
            closeStartedAt: browserMcpSessionBCloseStartedAt,
            id: browserMcpSessionBId,
            openedAt: browserMcpSessionBOpenedAt,
          }),
          navigation: Object.freeze(postRecoveryNavigation),
        }),
        recoveredAt,
        requests: browserRequests,
      });

      phase = 'browser console and page errors';
      const diagnostics = await call('diagnostics_list');
      expect(record(diagnostics.structuredContent, 'diagnostic list').diagnostics).toEqual(expect.any(Array));
      expect([...called]).toEqual(expectedAgentApiToolNames);
      if (pageErrors.length > 0) {
        const iframeSources = await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => Object.freeze({
          src: frame.getAttribute('src'),
          title: frame.getAttribute('title'),
        })));
        throw new Error(`Chrome reported errors: ${JSON.stringify({
          appRouteRequests,
          consoleErrors: consoleErrorRecords,
          failedAppRouteRequests,
          frames: page.frames().map((frame) => Object.freeze({
            parentUrl: frame.parentFrame()?.url(),
            url: frame.url(),
          })),
          iframeSources,
          pageErrors: pageErrors.map((error) => error.message),
        })}`);
      }
      expect(appRouteRequests).not.toHaveLength(0);
      expect(appRouteRequests.every((request) => typeof request.status === 'number' && request.status < 400)).toBe(true);
      expect(appRouteRequests.some((request) => request.method === 'POST' && /^\/api\/mcp\/sessions\/[^/]+\/apps$/u.test(string(request.path, 'App route path')) && request.status === 200)).toBe(true);
      expect(appRouteRequests.some((request) => request.method === 'GET' && /^\/api\/mcp\/apps\/[^/]+$/u.test(string(request.path, 'App route path')))).toBe(false);
      expect(failedAppRouteRequests).toEqual([]);

      phase = 'packed installed-product shutdown';
      await client.close();
      clientClosed = true;
      if (child === undefined) throw new Error('The packed dev server child was not created.');
      if (child.pid !== undefined) {
        trackedProcessIds.add(child.pid);
        for (const processId of await descendantProcessIds(child.pid)) trackedProcessIds.add(processId);
      }
      expect(observedOperationDescendantProcessIds.size).toBeGreaterThan(0);
      await closeChild(child);
      expect(child.exitCode).not.toBeNull();
      for (const shutdownOrigin of new Set([origin, appProxyOrigin].filter((value): value is string => value !== undefined))) {
        await expect.poll(async () => {
          try {
            await fetch(shutdownOrigin);
            return false;
          } catch {
            return true;
          }
        }, { timeout: browserTimeout }).toBe(true);
      }
      await expect(access(join(project, '.agent-bundle', 'dev.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      const leakedProductTemporaryRoots = (await readdir(tmpdir())).filter((root) =>
        productTemporaryRootPrefixes.some((prefix) => root.startsWith(prefix)) && !productTemporaryRootsBefore.has(root),
      );
      expect(leakedProductTemporaryRoots).toEqual([]);
      const nativeWorkspaceEntries = await readdir(join(project, '.agent-bundle'));
      expect(nativeWorkspaceEntries.filter((entry) => entry.startsWith('native-playground-'))).toEqual([]);
      for (const processId of trackedProcessIds) {
        await expect.poll(() => {
          try {
            process.kill(processId, 0);
            return false;
          } catch {
            return true;
          }
        }, { timeout: browserTimeout }).toBe(true);
      }
      expect(commandOutput).not.toContain(agentApiToken);
      expect(commandOutput).not.toContain('"authMethod"');
    } finally {
      if (!clientClosed) await client.close();
    }
  } catch (error) {
    primaryFailure = new Error(`Packed dogfood phase ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    const cleanupFailures: unknown[] = [];
    if (child !== undefined) {
      try { await closeChild(child); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await rm(consumer, { force: true, recursive: true }); }
    catch (error) { cleanupFailures.push(error); }
    try { await access(consumer); cleanupFailures.push(new Error(`Packed consumer temporary directory still exists: ${consumer}`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) cleanupFailure = new AggregateError(cleanupFailures, 'Packed release cleanup failed.');
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'Packed release test and cleanup both failed.', { cause: primaryFailure });
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
