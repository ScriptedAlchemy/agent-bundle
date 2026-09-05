import { createServer } from 'node:net';

/**
 * Reserves a free TCP port on `host` by binding port 0 and releasing it, for a
 * server that must be told its port before it exists — a packed CLI's `--port`,
 * or a dev-server origin that is allowlisted before the dev server starts.
 * Probe the host the server will bind: `localhost` may resolve to `::1`, where
 * a port that is free on 127.0.0.1 can still be taken.
 */
export const availablePort = async (host = '127.0.0.1'): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen({ host, port: 0 }, resolvePromise);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    probe.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  });
  return address.port;
};
