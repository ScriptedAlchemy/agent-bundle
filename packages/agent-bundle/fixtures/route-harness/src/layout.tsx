import { Agent, agent, type AgentLayoutProps } from '@agent-bundle/runtime';

/**
 * The project-wide layout: every rendered route (generated MCP routes,
 * rendered CLI commands, projected MCP commands, rendered scripts) composes
 * through it. It renders a container `Agent.Result` — no `value` — so the
 * runtime merges the route's own valued result into it, and records the
 * request scope it observed to prove layouts run inside `runAgentRequest`.
 */
export default async function Layout({ children, route }: AgentLayoutProps) {
  const context = await agent();
  return (
    <Agent.Result metadata={{ invocation: context.invocation.kind, shell: 'route-harness', wrapped: route.kind }}>
      {children}
    </Agent.Result>
  );
}
