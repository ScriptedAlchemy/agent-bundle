import { useAtom } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom } from 'effect/unstable/reactivity';
import { useEffect } from 'react';

import type { AgentRenderEvent } from './agent-document-client.ts';

type AgentDocumentLoader = (runId: string, signal?: AbortSignal) => Promise<readonly AgentRenderEvent[]>;

export const agentDocumentLoaderAtom = Atom.make<AgentDocumentLoader | undefined>(undefined);

export const agentDocumentEventsAtom = Atom.family((runId: string) => Atom.make((get) => {
  const loader = get.once(agentDocumentLoaderAtom);
  if (loader === undefined) {
    return Effect.fail('Agent Document loading is not available in this Workbench session.');
  }
  return Effect.tryPromise({
    catch: (error) => error instanceof Error ? error.message : 'Agent Document request could not be completed.',
    try: (signal) => loader(runId, signal),
  });
}));

export const useAgentDocumentLoader = (loader: AgentDocumentLoader | undefined): boolean => {
  const [current, setCurrent] = useAtom(agentDocumentLoaderAtom);
  useEffect(() => {
    setCurrent((latest: AgentDocumentLoader | undefined) => latest === loader ? latest : loader);
    return () => {
      setCurrent((latest: AgentDocumentLoader | undefined) => latest === loader ? undefined : latest);
    };
  }, [loader, setCurrent]);
  return loader === undefined || current !== undefined;
};
