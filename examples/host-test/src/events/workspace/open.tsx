import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';

import { observeEvent } from '../../event-route.js';

export const config = {
  fallback: 'standalone',
  runtime: 'shared',
  targets: ['cursor'],
} satisfies AgentEventRouteConfig;

export default async function WorkspaceOpen(props: AgentEventRouteProps) {
  return observeEvent(props);
}
