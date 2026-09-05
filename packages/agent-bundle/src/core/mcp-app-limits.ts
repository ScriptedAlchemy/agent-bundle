/**
 * The largest MCP App HTML document the framework's hosts render: the
 * Workbench bridge (`dev/mcp-apps/mcp-app-bridge.ts`) and the `serve-app`
 * host refuse a resource above this many UTF-8 bytes, and the browser test
 * harness (`rstest/browser-setup-module.ts`) rejects a compiled view above
 * it. The compiler's `AB4772` size advisory judges emitted views against the
 * same number, which is why the constant lives in `core/`: `build/**` never
 * imports `dev/**`.
 */
export const MAX_APP_HTML_BYTES = 2_097_152;
