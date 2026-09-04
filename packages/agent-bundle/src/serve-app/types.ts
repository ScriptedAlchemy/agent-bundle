import type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';
import type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
import type { OpenBrowser } from '../dev/mcp-apps/mcp-app-preview-host.ts';

/**
 * The public shape of a served MCP App. This module carries no Effect types
 * on purpose: it is what `agent-bundle/api` re-exports, and the package's
 * emitted declarations must stay resolvable for consumers that never
 * install `effect` themselves (`serve-mcp-app.ts` keeps the Effect-typed
 * internals).
 */

export type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';

/** The options a caller chooses freely; the launcher-side options live with the launch. */
export interface ServeMcpAppPublicOptions {
  /**
   * Consent capabilities approved on the operator's behalf as the App
   * requests them; everything else waits for a decision in the host page,
   * exactly as in the Workbench.
   */
  readonly autoApprove?: readonly McpAppConsentCapability[];
  /** Arguments for the opening tool call; defaults to `{}`. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Open the default browser on the served URL once the host is listening. */
  readonly open?: boolean;
  /** Injectable only to keep browser launching deterministic in tests. */
  readonly openBrowser?: OpenBrowser;
  /** Loopback TCP port for the host document; `0` (default) picks an ephemeral one. */
  readonly port?: number;
  /** The simulated MCP Apps host profile; defaults to `portable`. */
  readonly profile?: McpAppProfileId;
  /** Per-request timeout for the bound session, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * The tool whose result the App opens with. Defaults to the only tool that
   * declares the App's `_meta.ui.resourceUri`; required when several do.
   */
  readonly tool?: string;
}

export interface ServedMcpApp {
  /** The App's canonical `ui://` resource URI. */
  readonly resourceUri: string;
  /** Loopback origin of the sandbox proxy the App document runs on. */
  readonly sandboxOrigin: string;
  /** The generated MCP server the App is bound to. */
  readonly server: string;
  /** The tool whose call opened the App. */
  readonly tool: string;
  /** The host document URL. */
  readonly url: string;
  /** Settles once the bound MCP server connection has ended, whether by `close()` or on its own. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
