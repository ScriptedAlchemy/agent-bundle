import { expect, test } from '@rstest/core';

import {
  ledgerRequest,
  legacyOutageLedgerPasses,
  outageLedgerFixture,
  postRecoveryCancellationFixture,
  validateOutageLedger,
  type ConsoleErrorRecord,
  type NetworkLedgerEntry,
  type OutageLedger,
} from './support/packed-outage-ledger.ts';

test('outage ledger rejects the legacy duplicate, cross-origin, and missing-cleanup false positives', () => {
  const valid = outageLedgerFixture();
  const oldSessionPath = `/api/mcp/sessions/${encodeURIComponent(valid.oldSessionId)}`;
  const oldStreamPath = `${oldSessionPath}/stream`;
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
  const validOldStreamSocketNotConnected = withOldStreamReset(
    ledgerRequest({ ...resetRequest, error: 'net::ERR_SOCKET_NOT_CONNECTED' }),
    Object.freeze({ ...resetConsole, text: 'Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED' }),
  );
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
  // The fixture's single failed project/session probe, and the console error
  // it logged, failing with `code` instead of REFUSED.
  const withSessionProbeCode = (code: string): OutageLedger => Object.freeze({
    ...valid,
    consoleErrors: Object.freeze(valid.consoleErrors.map((consoleError) =>
      consoleError.url === `${valid.origin}/api/project/session`
        ? Object.freeze({ ...consoleError, text: `Failed to load resource: ${code}` })
        : consoleError,
    )),
    requests: Object.freeze(valid.requests.map((request) =>
      request.path === '/api/project/session' && request.error !== undefined
        ? ledgerRequest({ ...request, error: code })
        : request,
    )),
  });
  const resetSessionProbe = withSessionProbeCode('net::ERR_CONNECTION_RESET');
  const socketNotConnectedSessionProbe = withSessionProbeCode('net::ERR_SOCKET_NOT_CONNECTED');
  // SOCKET_NOT_CONNECTED is a dying-server probe failure and nothing else: the
  // old-session DELETE, a non-GET on the probe path, a probe that carries
  // response headers, and a probe outside the outage window all stay rejected
  // with their existing messages.
  const socketNotConnectedDelete = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze(valid.consoleErrors.map((consoleError) =>
      consoleError.url === `${valid.origin}${oldSessionPath}`
        ? Object.freeze({ ...consoleError, text: 'Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED' })
        : consoleError,
    )),
    requests: Object.freeze(valid.requests.map((request) =>
      request.method === 'DELETE' ? ledgerRequest({ ...request, error: 'net::ERR_SOCKET_NOT_CONNECTED' }) : request,
    )),
  });
  const socketNotConnectedSessionPost = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      ...valid.consoleErrors,
      Object.freeze({ at: 1_022, text: 'Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED', url: `${valid.origin}/api/project/session` }),
    ]),
    requests: Object.freeze([
      ...valid.requests,
      ledgerRequest({ at: 1_020, completedAt: 1_021, error: 'net::ERR_SOCKET_NOT_CONNECTED', method: 'POST', path: '/api/project/session' }),
    ]),
  });
  const socketNotConnectedRespondedProbe = Object.freeze({
    ...socketNotConnectedSessionProbe,
    requests: Object.freeze(socketNotConnectedSessionProbe.requests.map((request) =>
      request.error === 'net::ERR_SOCKET_NOT_CONNECTED' ? ledgerRequest({ ...request, respondedAt: request.at, status: 503 }) : request,
    )),
  });
  const socketNotConnectedPreOutageProbe = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      Object.freeze({ at: 992, text: 'Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED', url: `${valid.origin}/api/project/session` }),
      ...valid.consoleErrors,
    ]),
    requests: Object.freeze([
      ledgerRequest({ at: 990, completedAt: 991, error: 'net::ERR_SOCKET_NOT_CONNECTED', method: 'GET', path: '/api/project/session' }),
      ...valid.requests,
    ]),
  });
  // The code on the console error alone, or on the probe alone, pairs with
  // nothing: a console error still needs its own request failure and a
  // request failure its own console error.
  const socketNotConnectedConsoleWithoutFailure = Object.freeze({
    ...valid,
    consoleErrors: socketNotConnectedSessionProbe.consoleErrors,
  });
  const socketNotConnectedProbeWithoutConsole = Object.freeze({
    ...socketNotConnectedSessionProbe,
    consoleErrors: Object.freeze(valid.consoleErrors.filter((consoleError) => consoleError.url !== `${valid.origin}/api/project/session`)),
  });
  const knownPreOutageCatalogCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({
        at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/playground/catalog',
        url: `${valid.origin}/api/playground/catalog?epochId=superseded-epoch`,
      }),
      ...valid.requests,
    ]),
  });
  const knownPreOutageSessionReplayCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({
        at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET',
        path: '/api/playground/sessions/departing-session/replay',
        url: `${valid.origin}/api/playground/sessions/departing-session/replay?after=11`,
      }),
      ...valid.requests,
    ]),
  });
  const knownPreOutageSessionReadCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({
        at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET',
        path: '/api/playground/sessions/departing-session',
      }),
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
  // Leaving the Logs page before the replay answered: Chromium reports the
  // abort with neither a status nor a response instant.
  const knownPreOutageLogsReplayPreHeaderCancellation = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/logs/replay' }),
      ...valid.requests,
    ]),
  });
  const logsReplayCancellationWithoutTerminal = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/logs/replay' }),
      ...valid.requests,
    ]),
  });
  const logsReplayCancellationAfterFailure = Object.freeze({
    ...valid,
    requests: Object.freeze([
      ledgerRequest({ at: 900, completedAt: 901, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/logs/replay', respondedAt: 900, status: 500 }),
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
  // Index of a request appended after the post-recovery fixture's own entries.
  const appendedIndex = validPostRecovery.requests.length;
  const navigationLiveStreamCancellation = Object.freeze({
    ...validPostRecovery,
    postRecovery: Object.freeze({
      ...validPostRecovery.postRecovery!,
      navigation: Object.freeze([
        ...validPostRecovery.postRecovery!.navigation,
        Object.freeze({
          leftAt: 1_350,
          leftIndex: appendedIndex + 1,
          openedIndex: appendedIndex,
          respondedStream: true as const,
          url: `${valid.origin}/api/logs/stream?after=32`,
        }),
      ]),
    }),
    requests: Object.freeze([
      ...validPostRecovery.requests,
      ledgerRequest({
        at: 1_345, completedAt: 1_351, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/logs/stream',
        respondedAt: 1_346, status: 200, url: `${valid.origin}/api/logs/stream?after=32`,
      }),
    ]),
  });
  const navigationRespondedCatalogCancellation = Object.freeze({
    ...validPostRecovery,
    postRecovery: Object.freeze({
      ...validPostRecovery.postRecovery!,
      navigation: Object.freeze([
        ...validPostRecovery.postRecovery!.navigation,
        Object.freeze({
          leftAt: 1_350,
          leftIndex: appendedIndex + 1,
          openedIndex: appendedIndex,
          url: `${valid.origin}/api/playground/catalog?epochId=recovered-epoch`,
        }),
      ]),
    }),
    requests: Object.freeze([
      ...validPostRecovery.requests,
      ledgerRequest({
        at: 1_345, completedAt: 1_351, error: 'net::ERR_ABORTED', method: 'GET', path: '/api/playground/catalog',
        respondedAt: 1_346, status: 200, url: `${valid.origin}/api/playground/catalog?epochId=recovered-epoch`,
      }),
    ]),
  });
  const navigationNonGetCancellation = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze([
      ...validPostRecovery.requests,
      ledgerRequest({ at: 1_335, completedAt: 1_336, error: 'net::ERR_ABORTED', method: 'POST', path: '/api/playground/runs' }),
    ]),
  });
  // A fresh-B stream abort delivered before the test clicked Close is not the
  // close's doing, however close to the click it lands.
  const preCloseFreshStreamCancellation = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze(validPostRecovery.requests.map((request) =>
      request.path.startsWith('/api/mcp/sessions/fresh-browser-mcp-session/') ? ledgerRequest({ ...request, completedAt: 1_319 }) : request,
    )),
  });
  // The other edge: the page aborts both streams before it issues the DELETE,
  // so an abort that completes after the DELETE completed was not the close's.
  const postCloseFreshStreamCancellation = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze(validPostRecovery.requests.map((request) =>
      request.path.startsWith('/api/mcp/sessions/fresh-browser-mcp-session/') ? ledgerRequest({ ...request, completedAt: 1_322 }) : request,
    )),
  });
  const hooksNavigation = validPostRecovery.postRecovery!.navigation[0]!;
  const hooksRequest = validPostRecovery.requests.at(-1)!;
  // The CI shape: the Hooks request and its response arrived in one batch and
  // the awaiting test stamped its departure in the same millisecond. Delivery
  // order still places the request before the stamp, so the visit owns it.
  const sameMillisecondDepartedRequest = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze([
      ...validPostRecovery.requests.slice(0, -1),
      ledgerRequest({ ...hooksRequest, at: hooksNavigation.leftAt }),
    ]),
  });
  // The mirror image: a request handed over after the departure stamp is the
  // next page's, however it is timestamped, and its abort stays unexplained.
  const sameMillisecondNextPageRequest = Object.freeze({
    ...validPostRecovery,
    requests: Object.freeze([
      ...validPostRecovery.requests,
      ledgerRequest({ ...hooksRequest, at: hooksNavigation.leftAt, completedAt: hooksNavigation.leftAt + 1 }),
    ]),
  });
  const navigationCancellationBeforeDeparture = Object.freeze({
    ...validPostRecovery,
    postRecovery: Object.freeze({
      ...validPostRecovery.postRecovery!,
      navigation: Object.freeze(validPostRecovery.postRecovery!.navigation.map((navigation) =>
        Object.freeze({ ...navigation, leftAt: 1_345 }),
      )),
    }),
  });
  // Replaces the fixture's single project/session probe with `probeAts` failed
  // probes (each paired with its console error) and a success at `successAt`.
  // A probe is refused unless `codes` names its failure at the same index.
  const withRetryProbes = (probeAts: readonly number[], successAt: number, codes: readonly string[] = []): OutageLedger => Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      ...valid.consoleErrors.filter((consoleError) => consoleError.url !== `${valid.origin}/api/project/session`),
      ...probeAts.map((at, index) => Object.freeze({
        at: at + 2, text: `Failed to load resource: ${codes[index] ?? 'net::ERR_CONNECTION_REFUSED'}`, url: `${valid.origin}/api/project/session`,
      })),
    ]),
    recoveredAt: successAt + 1,
    requests: Object.freeze([
      ...valid.requests.filter((request) => request.path !== '/api/project/session'),
      ...probeAts.map((at, index) => ledgerRequest({
        at, completedAt: at + 1, error: codes[index] ?? 'net::ERR_CONNECTION_REFUSED', method: 'GET', path: '/api/project/session',
      })),
      ledgerRequest({ at: successAt, completedAt: successAt + 1, method: 'GET', path: '/api/project/session', status: 200 }),
    ]),
  });
  // The CI shape (Release gates, runs 33933481002 and 33936651225): the first
  // probe of the outage went out over a keep-alive connection the closing
  // server had already shut and failed with SOCKET_NOT_CONNECTED; every later
  // probe found the port closed, and recovery answered 200.
  const socketNotConnectedFirstRetry = withRetryProbes([1_010, 1_266, 1_518], 1_770, ['net::ERR_SOCKET_NOT_CONNECTED']);
  // One probe's `request` event delivered 34 ms late: the gap before it reads
  // 284 ms and the gap after it 222 ms, while the page kept its 250 ms delay.
  const lateDeliveredRetry = withRetryProbes([1_010, 1_260, 1_544, 1_766], 2_016);
  // The first probe's event delivered 100 ms late shortens only the first gap.
  const lateDeliveredFirstRetry = withRetryProbes([1_110, 1_260], 1_510);
  const burstRetry = withRetryProbes([1_010, 1_013], 1_263);
  const underpacedRetries = withRetryProbes([1_010, 1_160, 1_310], 1_460);
  // Two short gaps then a long one: lateness cannot be borrowed from a gap that
  // has not happened yet, so the second short gap is rejected even though the
  // three gaps average well above the client's delay.
  const borrowedRetryLateness = withRetryProbes([1_010, 1_135, 1_260], 1_735);
  const malformedLedgers = [duplicateConsole, crossOriginConsole, missingCleanup];

  expect(malformedLedgers.map(legacyOutageLedgerPasses)).toEqual([true, true, true]);
  expect(() => validateOutageLedger(valid)).not.toThrow();
  expect(() => validateOutageLedger(validOldStreamReset)).not.toThrow();
  expect(() => validateOutageLedger(validOldStreamSocketNotConnected)).not.toThrow();
  expect(() => validateOutageLedger(resetSessionProbe)).not.toThrow();
  expect(() => validateOutageLedger(socketNotConnectedSessionProbe)).not.toThrow();
  expect(() => validateOutageLedger(socketNotConnectedFirstRetry)).not.toThrow();
  expect(() => validateOutageLedger(socketNotConnectedDelete)).toThrow(/old-session DELETE must succeed or fail exactly with ERR_CONNECTION_REFUSED/u);
  expect(() => validateOutageLedger(socketNotConnectedSessionPost)).toThrow(/unknown outage failure/u);
  expect(() => validateOutageLedger(socketNotConnectedRespondedProbe)).toThrow(/project\/session retry is missing or has multiple terminal states/u);
  expect(() => validateOutageLedger(socketNotConnectedPreOutageProbe)).toThrow(/unexpected pre-outage failures/u);
  expect(() => validateOutageLedger(socketNotConnectedConsoleWithoutFailure)).toThrow(/console error does not uniquely pair with an outage request failure/u);
  expect(() => validateOutageLedger(socketNotConnectedProbeWithoutConsole)).toThrow(/outage request failures lack a unique paired console error/u);
  expect(() => validateOutageLedger(preStartedOutageStreamTermination)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageCatalogCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageSessionReplayCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageSessionReadCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageLogsReplayCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageLogsReplayPreHeaderCancellation)).not.toThrow();
  expect(() => validateOutageLedger(logsReplayCancellationWithoutTerminal)).toThrow(/unexpected pre-outage failures/u);
  expect(() => validateOutageLedger(logsReplayCancellationAfterFailure)).toThrow(/unexpected pre-outage failures/u);
  expect(() => validateOutageLedger(preCloseFreshStreamCancellation)).toThrow(/fresh B MCP stream cancellation is not action-induced/u);
  expect(() => validateOutageLedger(postCloseFreshStreamCancellation)).toThrow(/fresh B MCP stream cancellation is not action-induced/u);
  expect(() => validateOutageLedger(validPostRecovery)).not.toThrow();
  expect(() => validateOutageLedger(navigationLiveStreamCancellation)).not.toThrow();
  expect(() => validateOutageLedger(navigationRespondedCatalogCancellation)).not.toThrow();
  expect(() => validateOutageLedger(sameMillisecondDepartedRequest)).not.toThrow();
  expect(() => validateOutageLedger(sameMillisecondNextPageRequest)).toThrow(/unknown post-recovery failure/u);
  expect(() => validateOutageLedger(lateDeliveredRetry)).not.toThrow();
  expect(() => validateOutageLedger(lateDeliveredFirstRetry)).not.toThrow();
  expect(() => validateOutageLedger(burstRetry)).toThrow(/project\/session retries began too quickly \(attempt 2 arrived 122 ms before/u);
  expect(() => validateOutageLedger(underpacedRetries)).toThrow(/project\/session retries began too quickly \(attempt 3 arrived 75 ms before/u);
  expect(() => validateOutageLedger(borrowedRetryLateness)).toThrow(/project\/session retries began too quickly \(attempt 3 arrived 125 ms before/u);
  for (const malformed of malformedLedgers) expect(() => validateOutageLedger(malformed)).toThrow(/Foreground outage ledger rejected/u);
  for (const malformed of [
    resetWithAlteredQuery, resetWithResponse, resetWithUnknownSession, resetWithForeignOrigin, resetWithMismatchedConsoleUrl,
    resetWithoutConsole, duplicateOldStreamReset, postRecoveryReset,
  ]) expect(() => validateOutageLedger(malformed)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownPreOutageCancellation)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(preOutageCancelAbort)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownOutageStreamTermination)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(unknownPostRecoveryCancellation)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(navigationNonGetCancellation)).toThrow(/Foreground outage ledger rejected/u);
  expect(() => validateOutageLedger(navigationCancellationBeforeDeparture)).toThrow(/Foreground outage ledger rejected/u);
});
