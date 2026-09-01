import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-server-dom-rspack/server.node';

import { ensureAgentFlightManifest } from '../flight-manifest.js';

export interface AgentFlightRenderOptions {
  readonly onError?: (error: unknown) => string | undefined;
  readonly signal?: AbortSignal;
}

const abortError = (): DOMException => new DOMException('Agent render was aborted', 'AbortError');

export const renderAgentFlight = (
  model: ReactNode,
  options: AgentFlightRenderOptions = {},
): ReadableStream<Uint8Array> => {
  if (options.signal?.aborted) throw abortError();
  ensureAgentFlightManifest();
  const flight = renderToReadableStream(model, {
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  if (options.signal === undefined) return flight;
  return flight.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: options.signal });
};
