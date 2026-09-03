import { Agent, type AgentLayoutProps } from '@agent-bundle/runtime';

/**
 * The `harness` server layout, nested inside the root layout. It stamps the
 * wrapped route's identity into document metadata for every harness route and
 * adds visible protocol content for exactly one route, so the projection
 * levels can prove the chain is applied without changing the other routes'
 * pinned MCP and CLI output.
 */
export default function HarnessLayout({ children, route }: AgentLayoutProps) {
  return (
    <Agent.Result metadata={{ layout: 'harness', route: route.id, server: route.serverId ?? null }}>
      {children}
      {route.name === 'layout-probe'
        ? <Agent.Text>{`layout: ${route.kind} ${route.name} via ${route.serverId ?? 'no server'}`}</Agent.Text>
        : undefined}
    </Agent.Result>
  );
}
