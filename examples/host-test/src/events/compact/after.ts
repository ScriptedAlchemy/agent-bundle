import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.compact.after({
  targets: ['claude', 'codex'],
}, async (event) => {
  await observeEvent(event);
});
