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
