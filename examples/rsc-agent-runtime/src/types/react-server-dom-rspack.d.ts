type RscTemporaryReferenceSet = unknown;

type RscOptions = {
  onError?: (error: unknown) => string | undefined;
  temporaryReferences?: RscTemporaryReferenceSet;
};

type RscClientOptions = {
  temporaryReferences?: RscTemporaryReferenceSet;
};

declare module 'react-server-dom-rspack/client.node' {
  export function createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
    options?: RscClientOptions,
  ): Promise<T>;
}

declare module 'react-server-dom-rspack/server.node' {
  export function renderToReadableStream(
    model: unknown,
    options?: RscOptions,
  ): ReadableStream<Uint8Array>;
}
