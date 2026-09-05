/**
 * A serialized loopback HTTP origin — `http://127.0.0.1:<port>` or
 * `http://[::1]:<port>` with nothing after the authority. The one shape the
 * dev lock publishes, the host MCP proxy dials, and a generated hook wrapper
 * may post a trace receipt to.
 */
export const isLoopbackHttpOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
      && parsed.origin === value;
  } catch {
    return false;
  }
};
