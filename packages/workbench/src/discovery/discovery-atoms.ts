import { useAtom } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom } from 'effect/unstable/reactivity';
import { useCallback, useEffect, useState } from 'react';

import {
  DiscoveryClientError,
  type HostDiscoveryReport,
  type McpProbeHost,
  type McpProbeReport,
} from './discovery-client.ts';

export type DiscoveryLoader = (signal?: AbortSignal) => Promise<HostDiscoveryReport>;
export type DiscoveryProbeLoader = (
  request: Readonly<{ readonly host: McpProbeHost; readonly serverName: string }>,
  signal?: AbortSignal,
) => Promise<McpProbeReport>;

export type DiscoveryProbeState =
  | Readonly<{ readonly state: 'consent-pending' }>
  | Readonly<{ readonly state: 'probing' }>
  | Readonly<{ readonly report: McpProbeReport; readonly state: 'settled' }>
  | Readonly<{ readonly code: string; readonly message: string; readonly state: 'failed' }>
  | undefined;

export const discoveryLoaderAtom = Atom.make<DiscoveryLoader | undefined>(undefined);
export const discoveryProbeLoaderAtom = Atom.make<DiscoveryProbeLoader | undefined>(undefined);

export const discoveryProbeKey = (
  refreshKey: number,
  host: McpProbeHost,
  serverName: string,
): string => `${String(refreshKey)}\u0000${host}\u0000${serverName}`;

export const discoveryProbeStateAtom = Atom.family(
  (key: string) => Atom.make<DiscoveryProbeState>(undefined),
);

/**
 * `AB8234` is the documented host-discovery decoder diagnostic and the code
 * the page already falls back to for an uncoded failure; the report atom uses
 * it for the client-side states that have no route diagnostic of their own.
 */
const discoveryClientErrorCode = 'AB8234';

/**
 * The atom's fail channel is always the client's typed error. A
 * `DiscoveryClientError` passes through unchanged; any other coded `Error`
 * (for example the foreground authority's `ForegroundRouteClientError` when
 * authentication was invalidated) keeps its own `code`, `message`, and numeric
 * `status`; an uncoded rejection gets the decoder code and its message — the
 * same code/message pair `errorDetails` on the page derived from a bare
 * `Error`.
 */
const toDiscoveryClientError = (error: unknown): DiscoveryClientError => {
  if (error instanceof DiscoveryClientError) return error;
  if (!(error instanceof Error)) {
    return new DiscoveryClientError(discoveryClientErrorCode, 'Host discovery request could not be completed.');
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : discoveryClientErrorCode;
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  return new DiscoveryClientError(code, error.message, status);
};

export const discoveryReportAtom = Atom.family((refreshKey: number) => Atom.make(
  (get): Effect.Effect<HostDiscoveryReport, DiscoveryClientError> => {
    const loader = get.once(discoveryLoaderAtom);
    if (loader === undefined) {
      return Effect.fail(new DiscoveryClientError(
        discoveryClientErrorCode,
        'Host discovery loading is not available in this Workbench session.',
      ));
    }
    return Effect.tryPromise({
      catch: toDiscoveryClientError,
      try: (signal) => loader(signal),
    });
  },
));

export const useDiscoveryLoader = (loader: DiscoveryLoader | undefined): boolean => {
  const [current, setCurrent] = useAtom(discoveryLoaderAtom);
  useEffect(() => {
    setCurrent((latest: DiscoveryLoader | undefined) => latest === loader ? latest : loader);
    return () => {
      setCurrent((latest: DiscoveryLoader | undefined) => latest === loader ? undefined : latest);
    };
  }, [loader, setCurrent]);
  return loader === undefined || current !== undefined;
};

export const useDiscoveryProbeLoader = (
  loader: DiscoveryProbeLoader | undefined,
): boolean => {
  const [current, setCurrent] = useAtom(discoveryProbeLoaderAtom);
  useEffect(() => {
    setCurrent((latest: DiscoveryProbeLoader | undefined) => latest === loader ? latest : loader);
    return () => {
      setCurrent((latest: DiscoveryProbeLoader | undefined) => latest === loader ? undefined : latest);
    };
  }, [loader, setCurrent]);
  return loader === undefined || current !== undefined;
};

export const useDiscoveryRefresh = (): readonly [number, () => void] => {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  return [refreshKey, refresh] as const;
};
