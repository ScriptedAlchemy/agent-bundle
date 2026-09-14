import type { AgentEventRouteProps } from 'agent-bundle';

import { capture } from './capture.js';

/**
 * Every event family records the complete native envelope plus the framework
 * context. Only `session/start` renders afterward.
 */
export const observeEvent = (event: AgentEventRouteProps) =>
  capture({ event, kind: 'event' });
