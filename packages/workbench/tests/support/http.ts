import type { Server } from 'node:http';

/**
 * Teardown must not wait for the browser to release its connections: Node's
 * `server.close()` blocks while any connection still has a request in flight,
 * which hangs test teardown on two-core CI runners where the page can hold a
 * request open at close time. Start `close()` first so the listener stops
 * accepting new connections (a reconnecting browser could otherwise slip in a
 * fresh request after the sweep), then destroy the held connections while the
 * close completion is pending — the order Node's HTTP docs prescribe for
 * `closeAllConnections()`.
 */
export const closeServer = async (server: Server): Promise<void> => {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  server.closeAllConnections();
  await closed;
};

/**
 * Records the request paths a loopback fixture server receives and lets a test
 * await the Nth arrival through a promise the route handler settles.
 *
 * The browser issues a fixture request (an iframe fetching its bootstrap
 * document) only after the in-page event a test waits on, so asserting the
 * recorded paths synchronously after that wait races the network, and polling
 * the array on a timer trades the race for a budget. Awaiting `arrived(n)`
 * does neither: it settles inside the handler that records the nth request,
 * or on the microtask queue when `n` requests have already been recorded.
 * Checks that a step made *no* new request stay synchronous reads of `paths`.
 */
export interface RequestRecorder {
  /** Resolves with the paths recorded so far once at least `count` have arrived — immediately if they already have. */
  readonly arrived: (count: number) => Promise<readonly string[]>;
  /** Every recorded path, in arrival order (live view). */
  readonly paths: readonly string[];
  /** Called by the route handler with the request path. */
  readonly record: (path: string) => void;
}

/** Creates a {@link RequestRecorder}; pending `arrived` waiters settle in FIFO order as their counts are reached. */
export const requestRecorder = (): RequestRecorder => {
  const paths: string[] = [];
  let waiters: readonly Readonly<{ count: number; resolve: (paths: readonly string[]) => void }>[] = [];
  return {
    arrived: (count) => new Promise((resolve) => {
      if (paths.length >= count) {
        resolve([...paths]);
        return;
      }
      waiters = [...waiters, { count, resolve }];
    }),
    paths,
    record: (path) => {
      paths.push(path);
      const settled = waiters.filter((waiter) => waiter.count <= paths.length);
      waiters = waiters.filter((waiter) => waiter.count > paths.length);
      for (const waiter of settled) waiter.resolve([...paths]);
    },
  };
};
