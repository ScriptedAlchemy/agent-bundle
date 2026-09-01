declare module 'react-server-dom-rspack/client.node' {
  export function createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
    options?: Readonly<{
      temporaryReferences?: unknown;
      unstable_allowPartialStream?: boolean;
    }>,
  ): Promise<T>;
}

declare module 'react-server-dom-rspack/server.node' {
  export function renderToReadableStream(
    model: unknown,
    options?: Readonly<{
      onError?: (error: unknown) => string | undefined;
      temporaryReferences?: unknown;
    }>,
  ): ReadableStream<Uint8Array>;
}
