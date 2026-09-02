import { useAtom } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom } from 'effect/unstable/reactivity';
import { useCallback, useEffect, useState } from 'react';

import type { HostDiscoveryReport } from './discovery-client.ts';

export type DiscoveryLoader = (signal?: AbortSignal) => Promise<HostDiscoveryReport>;

export const discoveryLoaderAtom = Atom.make<DiscoveryLoader | undefined>(undefined);

export const discoveryReportAtom = Atom.family((refreshKey: number) => Atom.make((get) => {
  const loader = get.once(discoveryLoaderAtom);
  if (loader === undefined) {
    return Effect.fail(new Error('Host discovery loading is not available in this Workbench session.'));
  }
  return Effect.tryPromise({
    catch: (error) => error instanceof Error
      ? error
      : new Error('Host discovery request could not be completed.'),
    try: (signal) => loader(signal),
  });
}));

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

export const useDiscoveryRefresh = (): readonly [number, () => void] => {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  return [refreshKey, refresh] as const;
};
