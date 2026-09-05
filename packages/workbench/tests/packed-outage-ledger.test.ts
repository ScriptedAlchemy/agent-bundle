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
  const resetSessionProbe = Object.freeze({
    ...valid,
    consoleErrors: Object.freeze(valid.consoleErrors.map((consoleError) =>
      consoleError.url === `${valid.origin}/api/project/session`
        ? Object.freeze({ ...consoleError, text: 'Failed to load resource: net::ERR_CONNECTION_RESET' })
        : consoleError,
    )),
    requests: Object.freeze(valid.requests.map((request) =>
      request.path === '/api/project/session' && request.error !== undefined
        ? ledgerRequest({ ...request, error: 'net::ERR_CONNECTION_RESET' })
        : request,
    )),
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
  const navigationLiveStreamCancellation = Object.freeze({
    ...validPostRecovery,
    postRecovery: Object.freeze({
      ...validPostRecovery.postRecovery!,
      navigation: Object.freeze([
        ...validPostRecovery.postRecovery!.navigation,
        Object.freeze({
          leftAt: 1_350,
          openedAt: 1_345,
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
          openedAt: 1_345,
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
  const navigationCancellationBeforeDeparture = Object.freeze({
    ...validPostRecovery,
    postRecovery: Object.freeze({
      ...validPostRecovery.postRecovery!,
      navigation: Object.freeze(validPostRecovery.postRecovery!.navigation.map((navigation) =>
        Object.freeze({ ...navigation, leftAt: 1_345 }),
      )),
    }),
  });
  // Replaces the fixture's single project/session probe with `probeAts` refused
  // probes (each paired with its console error) and a success at `successAt`.
  const withRetryProbes = (probeAts: readonly number[], successAt: number): OutageLedger => Object.freeze({
    ...valid,
    consoleErrors: Object.freeze([
      ...valid.consoleErrors.filter((consoleError) => consoleError.url !== `${valid.origin}/api/project/session`),
      ...probeAts.map((at) => Object.freeze({ at: at + 2, text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: `${valid.origin}/api/project/session` })),
    ]),
    recoveredAt: successAt + 1,
    requests: Object.freeze([
      ...valid.requests.filter((request) => request.path !== '/api/project/session'),
      ...probeAts.map((at) => ledgerRequest({ at, completedAt: at + 1, error: 'net::ERR_CONNECTION_REFUSED', method: 'GET', path: '/api/project/session' })),
      ledgerRequest({ at: successAt, completedAt: successAt + 1, method: 'GET', path: '/api/project/session', status: 200 }),
    ]),
  });
  // One probe's `request` event delivered 34 ms late: the gap before it reads
  // 284 ms and the gap after it 222 ms, while the page kept its 250 ms delay.
  const lateDeliveredRetry = withRetryProbes([1_010, 1_260, 1_544, 1_766], 2_016);
  const burstRetry = withRetryProbes([1_010, 1_013], 1_263);
  const underpacedRetries = withRetryProbes([1_010, 1_160, 1_310], 1_460);
  const malformedLedgers = [duplicateConsole, crossOriginConsole, missingCleanup];

  expect(malformedLedgers.map(legacyOutageLedgerPasses)).toEqual([true, true, true]);
  expect(() => validateOutageLedger(valid)).not.toThrow();
  expect(() => validateOutageLedger(validOldStreamReset)).not.toThrow();
  expect(() => validateOutageLedger(validOldStreamSocketNotConnected)).not.toThrow();
  expect(() => validateOutageLedger(resetSessionProbe)).not.toThrow();
  expect(() => validateOutageLedger(preStartedOutageStreamTermination)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageCatalogCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageSessionReplayCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageSessionReadCancellation)).not.toThrow();
  expect(() => validateOutageLedger(knownPreOutageLogsReplayCancellation)).not.toThrow();
  expect(() => validateOutageLedger(validPostRecovery)).not.toThrow();
  expect(() => validateOutageLedger(navigationLiveStreamCancellation)).not.toThrow();
  expect(() => validateOutageLedger(navigationRespondedCatalogCancellation)).not.toThrow();
  expect(() => validateOutageLedger(lateDeliveredRetry)).not.toThrow();
  expect(() => validateOutageLedger(burstRetry)).toThrow(/project\/session retries began too quickly/u);
  expect(() => validateOutageLedger(underpacedRetries)).toThrow(/project\/session retries were paced below the client's 250 ms delay/u);
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
