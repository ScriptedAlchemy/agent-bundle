/**
 * App-initiated consent capabilities an operator may approve in advance.
 * Browser hardware and clipboard permissions always require a host-page
 * decision.
 */
export const serveAppAllowCapabilities = Object.freeze([
  'call-tool',
  'download-file',
  'open-external-link',
  'request-display-mode',
] as const);

export type ServeAppAllowCapability = (typeof serveAppAllowCapabilities)[number];

/** Whether a value belongs to the pre-approvable App consent vocabulary. */
export const isServeAppAllowCapability = (value: string): value is ServeAppAllowCapability =>
  (serveAppAllowCapabilities as readonly string[]).includes(value);
