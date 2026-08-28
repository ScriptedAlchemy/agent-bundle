/**
 * Browser-safe vocabulary for the subscription-backed native host CLIs Agent
 * Bundle can drive. Every server-side host set, request union, and Workbench
 * selector derives from this list so adding a native host is one edit.
 */
export const NATIVE_HOSTS = Object.freeze(['claude', 'codex'] as const);

export type NativeHost = (typeof NATIVE_HOSTS)[number];

export const NATIVE_HOST_LABELS: Readonly<Record<NativeHost, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
});
