import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';

import { observeEvent } from '../../event-route.js';

export const config = {
  fallback: 'standalone',
  runtime: 'shared',
  targets: ['claude'],
} satisfies AgentEventRouteConfig;

export default async function ConfigChange(props: AgentEventRouteProps) {
  return observeEvent(props);
}
