import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.tool.failure({
  targets: ['claude', 'cursor'],
}, async (event) => {
  await observeEvent(event);
});
