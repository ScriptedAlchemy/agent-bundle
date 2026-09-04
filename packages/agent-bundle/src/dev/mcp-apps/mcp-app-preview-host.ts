import { spawn } from 'node:child_process';

import type { McpAppBridgeHost, McpAppBridgeHostInfo } from './mcp-app-bridge.ts';

export type OpenBrowser = (url: string) => Promise<void> | void;

/** The host identity every agent-bundle MCP App host (Workbench and `serve-app`) advertises on `ui/initialize`. */
export const mcpAppPreviewHostInfo: McpAppBridgeHostInfo = Object.freeze({ name: 'agent-bundle', version: '0.1.0' });

/** Opens `url` with the operating system's default handler and returns once the launcher spawned. */
export const openInBrowser: OpenBrowser = (url) => new Promise((resolvePromise, rejectPromise) => {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', rejectPromise);
  child.once('spawn', () => {
    child.unref();
    resolvePromise();
  });
});

/**
 * The host-side action callbacks behind an agent-bundle MCP App preview:
 * display-mode requests are honored as asked, downloads open as a
 * host-created opaque data URL, and external links open in the default
 * browser. The Workbench MCP page and `agent-bundle serve-app` share this
 * exact object so an App behaves the same under both hosts; consent for
 * each action still flows through the preview service's consent authority.
 */
export const mcpAppPreviewHost = (openBrowser: OpenBrowser): Omit<McpAppBridgeHost, 'context' | 'info'> => Object.freeze({
  onDisplayMode: (mode) => mode,
  onDownload: async (download) => {
    // This is a host-created opaque data URL; App-controlled content is
    // encoded before it crosses the browser-launch boundary.
    await openBrowser(`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(download.contents))}`);
  },
  onOpenLink: async (url) => { await openBrowser(url); },
});
