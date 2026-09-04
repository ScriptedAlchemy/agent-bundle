import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';

import { observeEvent } from '../../event-route.js';

export const config = {
  fallback: 'standalone',
  runtime: 'shared',
  targets: ['claude', 'codex', 'cursor'],
} satisfies AgentEventRouteConfig;

export default async function SessionStart(props: AgentEventRouteProps) {
  return observeEvent(props, { announce: true });
}
