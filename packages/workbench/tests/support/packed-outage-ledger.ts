export interface NetworkLedgerEntry {
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

export interface ConsoleErrorRecord {
  readonly at: number;
  readonly text: string;
  readonly url: string;
}

export interface OutageLedger {
  readonly consoleErrors: readonly ConsoleErrorRecord[];
  readonly oldSessionId: string;
  readonly origin: string;
  readonly outageStartedAt: number;
  readonly postRecovery?: Readonly<{
    readonly freshMcpSession: Readonly<{ readonly closeCompletedAt: number; readonly closeStartedAt: number; readonly id: string; readonly openedAt: number }>;
    /** Windows in which the test itself navigated between routes, cancelling in-flight page requests. */
    readonly navigation: readonly Readonly<{ readonly leftAt: number; readonly openedAt: number }>[];
  }>;
  readonly recoveredAt: number;
  readonly requests: readonly NetworkLedgerEntry[];
}

export const ledgerRequest = (input: Omit<NetworkLedgerEntry, 'origin' | 'url'> & Readonly<{ readonly origin?: string; readonly url?: string }>): NetworkLedgerEntry => {
  const origin = input.origin ?? 'http://127.0.0.1:4100';
  return Object.freeze({ ...input, origin, url: input.url ?? `${origin}${input.path}` });
};

export const outageLedgerFixture = (): OutageLedger => {
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

export const postRecoveryCancellationFixture = (): OutageLedger => {
  const base = outageLedgerFixture();
  const freshMcpSessionId = 'fresh-browser-mcp-session';
  const freshMcpStreamPath = `/api/mcp/sessions/${encodeURIComponent(freshMcpSessionId)}/stream`;
  const hooksUrl = `${base.origin}/api/hooks?epochId=recovered-epoch`;
  return Object.freeze({
    ...base,
    postRecovery: Object.freeze({
      freshMcpSession: Object.freeze({ closeCompletedAt: 1_321, closeStartedAt: 1_320, id: freshMcpSessionId, openedAt: 1_310 }),
      navigation: Object.freeze([
        Object.freeze({ leftAt: 1_345, openedAt: 1_330 }),
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
export const legacyOutageLedgerPasses = (ledger: OutageLedger): boolean => {
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

export const assertOutageLedger: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Foreground outage ledger rejected: ${message}`);
};

/** Exhaustively validates only the one captured foreground generation and its recovery. */
export const validateOutageLedger = (ledger: OutageLedger): void => {
  const oldSessionPath = `/api/mcp/sessions/${encodeURIComponent(ledger.oldSessionId)}`;
  const sameOriginRequests = ledger.requests.filter((request) => request.origin === ledger.origin);
  const requestFailed = ledger.requests.filter((request) => request.error !== undefined);
  const foreignFailures = requestFailed.filter((request) => request.origin !== ledger.origin);
  assertOutageLedger(foreignFailures.length === 0, `cross-origin request failures: ${JSON.stringify(foreignFailures)}`);
  const preOutageFailures = requestFailed.filter((request) =>
    ledgerFailureAt(request) < ledger.outageStartedAt && !isKnownPreOutageStreamCancellation(request),
  );
  assertOutageLedger(preOutageFailures.length === 0, `unexpected pre-outage failures: ${JSON.stringify(preOutageFailures)}`);
  const postRecoveryFailures = ledger.requests.filter((request) => request.error !== undefined && ledgerFailureAt(request) >= ledger.recoveredAt);
  if (ledger.postRecovery === undefined) {
    assertOutageLedger(postRecoveryFailures.length === 0, `post-recovery failures: ${JSON.stringify(postRecoveryFailures)}`);
  } else {
    const postRecovery = ledger.postRecovery;
    const freshMcpSession = postRecovery.freshMcpSession;
    const freshMcpStreamPath = `/api/mcp/sessions/${encodeURIComponent(freshMcpSession.id)}/stream`;
    const freshMcpStreamFailures = postRecoveryFailures.filter((request) => request.path === freshMcpStreamPath);
    assertOutageLedger(freshMcpStreamFailures.length >= 1 && freshMcpStreamFailures.length <= 2,
      `fresh B MCP stream did not terminate exactly once or twice: ${JSON.stringify(freshMcpStreamFailures)}`);
    for (const failure of freshMcpStreamFailures) {
      let url: URL;
      try { url = new URL(failure.url); }
      catch { throw new Error(`Foreground outage ledger rejected: fresh B MCP stream URL is invalid: ${JSON.stringify(failure)}`); }
      assertOutageLedger(
        failure.origin === ledger.origin && url.origin === ledger.origin && url.pathname === freshMcpStreamPath && hasCanonicalAfterCursor(url) &&
        failure.method === 'GET' && failure.error === 'net::ERR_ABORTED' && failure.at >= freshMcpSession.openedAt &&
        failure.respondedAt !== undefined && failure.respondedAt <= ledgerFailureAt(failure) &&
        failure.status !== undefined && failure.status >= 200 && failure.status < 300 &&
        ledgerFailureAt(failure) >= freshMcpSession.closeStartedAt && ledgerFailureAt(failure) <= freshMcpSession.closeCompletedAt,
        `fresh B MCP stream cancellation is not action-induced: ${JSON.stringify(failure)}`,
      );
    }
    // Route changes cancel whatever the departing page still had in flight: pending API
    // reads and open live streams. Within a recorded navigation window those aborts are
    // action-induced; their shape is still validated and every other failure still rejects.
    const navigationFailures = postRecoveryFailures.filter((request) =>
      !freshMcpStreamFailures.includes(request) &&
      postRecovery.navigation.some((navigation) => {
        const failedAt = ledgerFailureAt(request);
        return failedAt >= navigation.openedAt && failedAt <= navigation.leftAt;
      }),
    );
    for (const failure of navigationFailures) {
      assertOutageLedger(
        failure.origin === ledger.origin && failure.method === 'GET' && failure.error === 'net::ERR_ABORTED' &&
        failure.path.startsWith('/api/') && (
          (failure.respondedAt === undefined && failure.status === undefined) ||
          (failure.respondedAt !== undefined && failure.respondedAt <= ledgerFailureAt(failure) &&
            failure.status !== undefined && failure.status >= 200 && failure.status < 300)
        ),
        `navigation cancellation is not an action-induced pending request or live stream: ${JSON.stringify(failure)}`,
      );
    }
    const recognizedPostRecoveryFailures = [...freshMcpStreamFailures, ...navigationFailures];
    assertOutageLedger(recognizedPostRecoveryFailures.length === postRecoveryFailures.length,
      `unknown post-recovery failure: ${JSON.stringify(postRecoveryFailures)}`);
    const postRecoveryConsoleErrors = ledger.consoleErrors.filter((consoleError) => consoleError.at >= ledger.recoveredAt);
    assertOutageLedger(postRecoveryConsoleErrors.length === 0, `post-recovery console errors: ${JSON.stringify(postRecoveryConsoleErrors)}`);
  }
  const outageFailures = requestFailed.filter((request) => {
    const at = ledgerFailureAt(request);
    return at >= ledger.outageStartedAt && at < ledger.recoveredAt;
  });

  const projectEvents = outageFailures.filter((request) => outagePathClass(request.path, oldSessionPath) === 'project-events');
  assertOutageLedger(projectEvents.length === 1 && projectEvents[0]?.method === 'GET' && projectEvents[0]?.error === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    `project stream failures: ${JSON.stringify(projectEvents)}`);
  const oldStreams = outageFailures.filter((request) => outagePathClass(request.path, oldSessionPath) === 'old-mcp-stream');
  assertOutageLedger(oldStreams.length >= 1, 'the old browser MCP stream has no termination evidence');
  assertOutageLedger(oldStreams.filter((request) => request.method === 'GET' && request.error === 'net::ERR_CONNECTION_REFUSED').length <= 1,
    `old MCP stream has duplicate refused failures: ${JSON.stringify(oldStreams)}`);
  assertOutageLedger(oldStreams.filter((request) => request.method === 'GET' && request.error === 'net::ERR_ABORTED').length <= 2,
    `old MCP stream has too many abort failures: ${JSON.stringify(oldStreams)}`);
  const oldStreamResets = oldStreams.filter((request) => request.error === 'net::ERR_CONNECTION_RESET');
  assertOutageLedger(oldStreamResets.length <= 1 && oldStreamResets.every((request) => isExactOldMcpStreamReset(request, ledger, oldSessionPath)),
    `old MCP stream has an invalid reset termination: ${JSON.stringify(oldStreamResets)}`);
  assertOutageLedger(oldStreams.every((request) => request.method === 'GET' && (
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
    assertOutageLedger(activeAtOutage.length <= 1, `multiple active ${streamClass} streams at outage start: ${JSON.stringify(activeAtOutage)}`);
    const terminations = outageFailures.filter((request) => knownStreamClass(request.path) === streamClass);
    assertOutageLedger(terminations.length <= 1 && terminations.every((request) =>
      activeAtOutage.includes(request) && request.method === 'GET' && request.error === 'net::ERR_ABORTED',
    ), `unexpected ${streamClass} stream termination: ${JSON.stringify(terminations)}`);
  }

  const oldSessionDeletes = sameOriginRequests.filter((request) => request.method === 'DELETE' && request.path === oldSessionPath);
  assertOutageLedger(oldSessionDeletes.length === 1, `expected exactly one old-session DELETE attempt: ${JSON.stringify(oldSessionDeletes)}`);
  const oldSessionDelete = oldSessionDeletes[0]!;
  const deleteSucceeded = oldSessionDelete.status !== undefined && oldSessionDelete.status >= 200 && oldSessionDelete.status < 300;
  const deleteRefused = oldSessionDelete.error === 'net::ERR_CONNECTION_REFUSED';
  assertOutageLedger((deleteSucceeded ? 1 : 0) + (deleteRefused ? 1 : 0) === 1 && oldSessionDelete.completedAt !== undefined,
    `old-session DELETE must succeed or fail exactly with ERR_CONNECTION_REFUSED: ${JSON.stringify(oldSessionDelete)}`);

  const projectSessionAttempts = sameOriginRequests.filter((request) =>
    request.method === 'GET' && request.path === '/api/project/session' && request.at >= ledger.outageStartedAt,
  ).sort((left, right) => left.at - right.at);
  const successfulSessions = projectSessionAttempts.filter((request) =>
    request.status !== undefined && request.status >= 200 && request.status < 300,
  );
  assertOutageLedger(successfulSessions.length >= 1, `the browser did not complete a B-generation project session: ${JSON.stringify(projectSessionAttempts)}`);
  const firstSuccessfulBSession = successfulSessions[0]!;
  assertOutageLedger(firstSuccessfulBSession.completedAt === ledger.recoveredAt,
    `recoveredAt does not identify the first successful B session: ${JSON.stringify(firstSuccessfulBSession)}`);
  const retryAttempts = projectSessionAttempts.filter((request) => request.at <= firstSuccessfulBSession.at);
  assertOutageLedger(retryAttempts.length >= 1, 'the outage did not issue a project/session retry');
  assertOutageLedger(retryAttempts.every((request) => request.completedAt !== undefined && (request.error === undefined) !== (request.status === undefined)),
    `project/session retry is missing or has multiple terminal states: ${JSON.stringify(retryAttempts)}`);
  assertOutageLedger(retryAttempts.slice(0, -1).every((request) => request.error === 'net::ERR_CONNECTION_REFUSED'),
    `project/session retry had a non-refused failure: ${JSON.stringify(retryAttempts)}`);
  assertOutageLedger(retryAttempts.at(-1) === firstSuccessfulBSession && firstSuccessfulBSession.status === 200,
    `project/session recovery did not finish with the first successful B session: ${JSON.stringify(retryAttempts)}`);
  for (const [index, attempt] of retryAttempts.entries()) {
    if (index > 0) assertOutageLedger(attempt.at - retryAttempts[index - 1]!.at >= 225,
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
  assertOutageLedger(maxInFlight <= 1 && inFlight === 0, `project/session retry concurrency exceeded one: ${JSON.stringify(retryAttempts)}`);
  const retryUpperBound = 2 + Math.ceil((ledger.recoveredAt - ledger.outageStartedAt) / 250);
  assertOutageLedger(retryAttempts.length <= retryUpperBound,
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
    assertOutageLedger(recognized, `unknown outage failure: ${JSON.stringify(failure)}`);
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
    assertOutageLedger(consoleUrl.origin === ledger.origin && code !== undefined && pathClass !== undefined,
      `unknown outage console error: ${JSON.stringify(consoleError)}`);
    const matchingFailureIndex = pendingConsoleBackedFailures.findIndex((failure) =>
      failure.error === code && outagePathClass(failure.path, oldSessionPath) === pathClass &&
      failure.url === consoleUrl.href &&
      Math.abs(ledgerFailureAt(failure) - consoleError.at) <= 1_000,
    );
    assertOutageLedger(matchingFailureIndex >= 0, `console error does not uniquely pair with an outage request failure: ${JSON.stringify(consoleError)}`);
    pendingConsoleBackedFailures.splice(matchingFailureIndex, 1);
  }
  assertOutageLedger(pendingConsoleBackedFailures.length === 0,
    `outage request failures lack a unique paired console error: ${JSON.stringify(pendingConsoleBackedFailures)}`);
  const nonOutageConsoleErrors = ledger.consoleErrors.filter((consoleError) => !outageConsoleErrors.includes(consoleError));
  assertOutageLedger(nonOutageConsoleErrors.length === 0, `unknown non-outage console errors: ${JSON.stringify(nonOutageConsoleErrors)}`);
};
