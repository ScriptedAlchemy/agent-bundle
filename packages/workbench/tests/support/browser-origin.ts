/**
 * Stubs the browser origin the Node unit pool lacks — `ForegroundRouteClient`
 * reads `globalThis.location.origin` during the session bootstrap — then
 * removes the stub (or restores a prior descriptor) even when `run` throws.
 */
export const withBrowserOrigin = async (origin: string, run: () => Promise<void>): Promise<void> => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'location');
    else Object.defineProperty(globalThis, 'location', previous);
  }
};
