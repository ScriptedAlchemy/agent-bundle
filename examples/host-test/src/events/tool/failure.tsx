import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';

import { observeEvent } from '../../event-route.js';

export const config = {
  fallback: 'standalone',
  runtime: 'shared',
  targets: ['claude', 'cursor'],
} satisfies AgentEventRouteConfig;

export default async function ToolFailure(props: AgentEventRouteProps) {
  return observeEvent(props);
}
