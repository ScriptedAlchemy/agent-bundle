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
    /**
     * The B-generation browser MCP session: `openedAt` is the
     * `POST /api/mcp/sessions` request instant, and the close window
     * `[closeStartedAt, closeCompletedAt]` spans from the stamp the test took
     * before clicking Close (the click is issued from the test, so nothing it
     * causes can be delivered earlier) to the completion of the session's
     * `DELETE` wire entry. The page aborts both of its session streams before
     * it issues that `DELETE`, so every close-induced stream abort lands inside
     * the window while a pre-click or post-close abort does not.
     */
    readonly freshMcpSession: Readonly<{ readonly closeCompletedAt: number; readonly closeStartedAt: number; readonly id: string; readonly openedAt: number }>;
    /**
     * Exact page-owned requests cancelled when the test deliberately navigated
     * away. A request belongs to the visit when it was observed no earlier
     * than `openedAt` and no later than `leftAt`; both bounds are inclusive
     * because Playwright hands the ledger batches of network events, so a
     * request, its response, and the test's departure stamp can all share one
     * millisecond.
     */
    readonly navigation: readonly Readonly<{
      readonly leftAt: number;
      readonly openedAt: number;
      readonly respondedStream?: true;
      readonly url: string;
    }>[];
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

const isPlaygroundSessionReplayPath = (path: string): boolean => {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length === 5 && segments[0] === 'api' && segments[1] === 'playground' &&
    segments[2] === 'sessions' && segments[3]!.length > 0 && segments[4] === 'replay';
};

const isSuccessStatus = (status: number | undefined): status is number => status !== undefined && status >= 200 && status < 300;

/** The abort landed before any response headers: Chromium reports neither a status nor a response instant. */
const responseIsAbsent = (request: NetworkLedgerEntry): boolean => request.respondedAt === undefined && request.status === undefined;

const isPlaygroundSessionReadCancellation = (request: NetworkLedgerEntry): boolean => {
  const segments = request.path.split('/').filter((segment) => segment.length > 0);
  const responseIsSuccessful = request.respondedAt !== undefined && isSuccessStatus(request.status);
  return segments.length === 4 && segments[0] === 'api' && segments[1] === 'playground' &&
    segments[2] === 'sessions' && segments[3]!.length > 0 && request.url === `${request.origin}${request.path}` &&
    request.completedAt !== undefined && request.at <= request.completedAt && (responseIsAbsent(request) || responseIsSuccessful);
};

/**
 * The Logs page issues `/api/logs/replay` from its mount effect and aborts it
 * from the effect's cleanup, so leaving the page cancels the replay in
 * whichever state it is in: after a 2xx arrived (the body read is cut short)
 * or before any headers arrived (a loaded server has not answered yet, and
 * Chromium reports the abort with no status at all). Both are the same
 * deliberate navigation; an abort after a non-2xx answer is still rejected.
 */
const isLogsReplayCancellation = (request: NetworkLedgerEntry): boolean =>
  request.path === '/api/logs/replay' && request.completedAt !== undefined && request.at <= request.completedAt &&
  (responseIsAbsent(request) || isSuccessStatus(request.status));

/**
 * The playground screen retires a superseded in-flight catalog request when
 * its effect re-runs (one AbortController per effect), and route changes abort
 * pending session reads and replays the same way they abort live streams.
 */
const isKnownPreOutageClientCancellation = (request: NetworkLedgerEntry): boolean =>
  request.error === 'net::ERR_ABORTED' && request.method === 'GET' && (
    knownStreamClass(request.path) !== undefined ||
    request.path === '/api/playground/catalog' ||
    isPlaygroundSessionReadCancellation(request) ||
    isPlaygroundSessionReplayPath(request.path) ||
    isLogsReplayCancellation(request)
  );

export const hasCanonicalAfterCursor = (url: URL): boolean => {
  const parameters = [...url.searchParams.entries()];
  if (parameters.length !== 1 || parameters[0]![0] !== 'after') return false;
  const after = parameters[0]![1];
  const parsed = Number(after);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === after && url.search === `?after=${after}`;
};

/** A probe against a dying server can hit its half-open socket (RESET) instead of a closed port (REFUSED). */
const downServerProbeCodes: ReadonlySet<string> = new Set(['net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET']);

/** Chromium reports a severed old-stream socket as RESET or, when the reconnect never attached, SOCKET_NOT_CONNECTED. */
const oldStreamSeveranceCodes: ReadonlySet<string> = new Set(['net::ERR_CONNECTION_RESET', 'net::ERR_SOCKET_NOT_CONNECTED']);

const isExactOldMcpStreamSeverance = (request: NetworkLedgerEntry, ledger: OutageLedger, oldSessionPath: string): boolean => {
  const oldStreamPath = `${oldSessionPath}/stream`;
  if (
    request.error === undefined || !oldStreamSeveranceCodes.has(request.error) || request.method !== 'GET' || request.origin !== ledger.origin ||
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
    ledgerFailureAt(request) < ledger.outageStartedAt && !isKnownPreOutageClientCancellation(request),
  );
  assertOutageLedger(preOutageFailures.length === 0, `unexpected pre-outage failures: ${JSON.stringify(preOutageFailures)}`);
  const postRecoveryFailures = ledger.requests.filter((request) => request.error !== undefined && ledgerFailureAt(request) >= ledger.recoveredAt);
  if (ledger.postRecovery === undefined) {
    assertOutageLedger(postRecoveryFailures.length === 0, `post-recovery failures: ${JSON.stringify(postRecoveryFailures)}`);
  } else {
    const postRecovery = ledger.postRecovery;
    const freshMcpSession = postRecovery.freshMcpSession;
    const freshMcpStreamPath = `/api/mcp/sessions/${encodeURIComponent(freshMcpSession.id)}/stream`;
    // The MCP page keeps two readers on one session: the transport opens
    // `stream?after=0` as soon as the POST returns (AgentBundleRemoteTransport
    // #start) and the session controller subscribes to `stream?after=N` once
    // the trace refresh has settled (McpSessionController #subscribeTrace).
    // Closing the session aborts both — the controller's subscription, then
    // the transport's stream — before the DELETE goes out, so a close leaves
    // one or two same-path aborts, each carrying the 2xx headers it had
    // already received, inside the close window.
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
        failure.respondedAt !== undefined && failure.respondedAt <= ledgerFailureAt(failure) && isSuccessStatus(failure.status) &&
        ledgerFailureAt(failure) >= freshMcpSession.closeStartedAt && ledgerFailureAt(failure) <= freshMcpSession.closeCompletedAt,
        `fresh B MCP stream cancellation is not action-induced: ${JSON.stringify(failure)}`,
      );
    }
    const navigationFailures = new Set<NetworkLedgerEntry>();
    for (const navigation of postRecovery.navigation) {
      // Inclusive on both ends (see OutageLedger.postRecovery.navigation): a
      // request delivered in the same millisecond the test stamped its
      // departure still belongs to the visit it was issued from.
      const failures = postRecoveryFailures.filter((request) =>
        request.url === navigation.url && request.at >= navigation.openedAt && request.at <= navigation.leftAt &&
        ledgerFailureAt(request) >= navigation.leftAt,
      );
      assertOutageLedger(failures.length <= 1,
        `multiple action-induced navigation cancellations: ${JSON.stringify({ failures, navigation })}`);
      for (const failure of failures) {
        const responseIsSuccessful = failure.respondedAt !== undefined && failure.respondedAt >= failure.at &&
          failure.respondedAt <= ledgerFailureAt(failure) && isSuccessStatus(failure.status);
        let validResponse = responseIsAbsent(failure) || responseIsSuccessful;
        if (navigation.respondedStream === true) {
          let url: URL;
          try { url = new URL(failure.url); }
          catch { throw new Error(`Foreground outage ledger rejected: responded navigation stream URL is invalid: ${JSON.stringify(failure)}`); }
          validResponse = failure.path === '/api/logs/stream' && url.origin === ledger.origin &&
            url.pathname === '/api/logs/stream' && hasCanonicalAfterCursor(url) &&
            responseIsSuccessful;
        }
        assertOutageLedger(
          failure.origin === ledger.origin && failure.method === 'GET' && failure.error === 'net::ERR_ABORTED' && validResponse,
          `navigation cancellation did not match its exact pending-or-stream response contract: ${JSON.stringify({ failure, navigation })}`,
        );
      }
      for (const failure of failures) navigationFailures.add(failure);
    }
    // Two adjacent routes may list the same URL, and the departure stamp of one
    // is the arrival stamp of the next, so one abort can satisfy two records;
    // what must hold is that every post-recovery failure is claimed by some
    // contract. Report only the unclaimed ones — a dump of every failure reads
    // as if the recognized ones were at fault.
    const unrecognizedPostRecoveryFailures = postRecoveryFailures.filter((request) =>
      !freshMcpStreamFailures.includes(request) && !navigationFailures.has(request),
    );
    assertOutageLedger(unrecognizedPostRecoveryFailures.length === 0,
      `unknown post-recovery failure: ${JSON.stringify(unrecognizedPostRecoveryFailures)}`);
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
  const oldStreamSeverances = oldStreams.filter((request) => request.error !== undefined && oldStreamSeveranceCodes.has(request.error));
  assertOutageLedger(oldStreamSeverances.length <= 1 && oldStreamSeverances.every((request) => isExactOldMcpStreamSeverance(request, ledger, oldSessionPath)),
    `old MCP stream has an invalid severance termination: ${JSON.stringify(oldStreamSeverances)}`);
  assertOutageLedger(oldStreams.every((request) => request.method === 'GET' && (
    request.error === 'net::ERR_CONNECTION_REFUSED' || request.error === 'net::ERR_ABORTED' ||
    isExactOldMcpStreamSeverance(request, ledger, oldSessionPath)
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
  const deleteSucceeded = isSuccessStatus(oldSessionDelete.status);
  const deleteRefused = oldSessionDelete.error === 'net::ERR_CONNECTION_REFUSED';
  assertOutageLedger((deleteSucceeded ? 1 : 0) + (deleteRefused ? 1 : 0) === 1 && oldSessionDelete.completedAt !== undefined,
    `old-session DELETE must succeed or fail exactly with ERR_CONNECTION_REFUSED: ${JSON.stringify(oldSessionDelete)}`);

  const projectSessionAttempts = sameOriginRequests.filter((request) =>
    request.method === 'GET' && request.path === '/api/project/session' && request.at >= ledger.outageStartedAt,
  ).sort((left, right) => left.at - right.at);
  const successfulSessions = projectSessionAttempts.filter((request) => isSuccessStatus(request.status));
  assertOutageLedger(successfulSessions.length >= 1, `the browser did not complete a B-generation project session: ${JSON.stringify(projectSessionAttempts)}`);
  const firstSuccessfulBSession = successfulSessions[0]!;
  assertOutageLedger(firstSuccessfulBSession.completedAt === ledger.recoveredAt,
    `recoveredAt does not identify the first successful B session: ${JSON.stringify(firstSuccessfulBSession)}`);
  const retryAttempts = projectSessionAttempts.filter((request) => request.at <= firstSuccessfulBSession.at);
  assertOutageLedger(retryAttempts.length >= 1, 'the outage did not issue a project/session retry');
  assertOutageLedger(retryAttempts.every((request) => request.completedAt !== undefined && (request.error === undefined) !== (request.status === undefined)),
    `project/session retry is missing or has multiple terminal states: ${JSON.stringify(retryAttempts)}`);
  assertOutageLedger(retryAttempts.slice(0, -1).every((request) => request.error !== undefined && downServerProbeCodes.has(request.error)),
    `project/session retry had a non-connection failure: ${JSON.stringify(retryAttempts)}`);
  assertOutageLedger(retryAttempts.at(-1) === firstSuccessfulBSession && firstSuccessfulBSession.status === 200,
    `project/session recovery did not finish with the first successful B session: ${JSON.stringify(retryAttempts)}`);
  // `at` is stamped when Playwright delivers the `request` event to Node, not
  // when the page issued the probe, and a delivery can only run late: one
  // held-back event shortens the next measured gap by exactly what it
  // lengthened its own (a 284 ms / 222 ms pair on a loaded host). The client
  // waits 250 ms after every failed probe, so the cadence is asserted as a mean
  // over the retry sequence, where delivery latency cancels, while a burst —
  // two probes issued without the delay — still fails on its own gap.
  const retryGaps = retryAttempts.slice(1).map((attempt, index) => attempt.at - retryAttempts[index]!.at);
  assertOutageLedger(retryGaps.every((gap) => gap >= 125),
    `project/session retries began too quickly: ${JSON.stringify(retryAttempts)}`);
  assertOutageLedger(retryGaps.reduce((sum, gap) => sum + gap, 0) >= 225 * retryGaps.length,
    `project/session retries were paced below the client's 250 ms delay: ${JSON.stringify(retryAttempts)}`);
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
      (pathClass === 'project-session' && failure.method === 'GET' && failure.error !== undefined && downServerProbeCodes.has(failure.error)) ||
      (pathClass === 'old-mcp-stream' && failure.method === 'GET' && (
        failure.error === 'net::ERR_CONNECTION_REFUSED' || failure.error === 'net::ERR_ABORTED' ||
        isExactOldMcpStreamSeverance(failure, ledger, oldSessionPath)
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
