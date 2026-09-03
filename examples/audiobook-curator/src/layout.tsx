import { Agent, type AgentLayoutProps } from '@agent-bundle/runtime';
import React from 'react';

/**
 * The curator's shared document shell. Every rendered surface — the 16 MCP
 * tools, the catalog resource, the curate prompt, the rendered CLI commands,
 * and the projected `curator <tool>` commands — composes through this one
 * layout, so no route imports a wrapper to obtain the server's standard
 * document structure.
 *
 * The layout renders a container `Agent.Result` (no `value`); the runtime
 * merges each route's own `<Agent.Result value={receipt}>` into it, so the
 * structured receipt (`structuredContent`), the MCP content, and the CLI
 * Markdown are exactly what the route declared. What the shell adds is stable
 * provenance on the document itself: which route produced it and on which
 * surface. The MCP projector emits that root metadata as `CallToolResult._meta`
 * (so MCP hosts receive `_meta.curator`), and the Workbench document stage and
 * `--ndjson` consumers can attribute every document by it.
 */
export default function CuratorLayout({ children, route }: AgentLayoutProps) {
  return (
    <Agent.Result metadata={{ curator: { route: route.id, server: route.serverId ?? null, surface: route.kind } }}>
      {children}
    </Agent.Result>
  );
}
