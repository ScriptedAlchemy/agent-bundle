import { useAtom } from '@effect/atom-react';
import { Effect } from 'effect';
import { Atom } from 'effect/unstable/reactivity';
import { useEffect } from 'react';

import { AgentDocumentClientError, type AgentRenderEvent } from './agent-document-client.ts';

type AgentDocumentLoader = (runId: string, signal?: AbortSignal) => Promise<readonly AgentRenderEvent[]>;

/**
 * `AB8206` is the documented Workbench runtime client failure; the Agent
 * Document atoms use it for the client-side states that have no route
 * diagnostic of their own (loader unavailable, non-Error rejection).
 */
const runtimeClientErrorCode = 'AB8206';

/**
 * The atom's fail channel is always the client's typed error. An
 * `AgentDocumentClientError` passes through unchanged; any other coded
 * `Error` (the production loader rethrows `RuntimeClientError`, and the
 * foreground authority raises `ForegroundRouteClientError`) keeps its own
 * `code`, `message`, and numeric `status`; an uncoded rejection gets the
 * runtime client code and its message, so the panel renders the same text it
 * did when the channel carried bare strings.
 */
const toAgentDocumentClientError = (error: unknown): AgentDocumentClientError => {
  if (error instanceof AgentDocumentClientError) return error;
  if (!(error instanceof Error)) {
    return new AgentDocumentClientError(runtimeClientErrorCode, 'Agent Document request could not be completed.');
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : runtimeClientErrorCode;
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  return new AgentDocumentClientError(code, error.message, status);
};

export const agentDocumentLoaderAtom = Atom.make<AgentDocumentLoader | undefined>(undefined);

export const agentDocumentEventsAtom = Atom.family((runId: string) => Atom.make(
  (get): Effect.Effect<readonly AgentRenderEvent[], AgentDocumentClientError> => {
    const loader = get.once(agentDocumentLoaderAtom);
    if (loader === undefined) {
      return Effect.fail(new AgentDocumentClientError(
        runtimeClientErrorCode,
        'Agent Document loading is not available in this Workbench session.',
      ));
    }
    return Effect.tryPromise({
      catch: toAgentDocumentClientError,
      try: (signal) => loader(runId, signal),
    });
  },
));

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
