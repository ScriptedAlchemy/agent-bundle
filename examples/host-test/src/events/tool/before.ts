import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.tool.before({
  targets: ['claude', 'codex', 'cursor'],
}, async (event) => {
  await observeEvent(event);
});
