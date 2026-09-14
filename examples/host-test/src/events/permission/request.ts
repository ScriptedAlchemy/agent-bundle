import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.permission.request({
  targets: ['claude', 'codex'],
}, async (event) => {
  await observeEvent(event);
});
