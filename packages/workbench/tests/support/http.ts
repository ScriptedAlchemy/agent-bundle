import type { Server } from 'node:http';

/**
 * Teardown must not wait for the browser to release its connections: Node's
 * `server.close()` blocks while any connection still has a request in flight,
 * which hangs test teardown on two-core CI runners where the page can hold a
 * request open at close time. Destroying connections first keeps `close()`
 * deterministic regardless of browser state.
 */
export const closeServer = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
};
