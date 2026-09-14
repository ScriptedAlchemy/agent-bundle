import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.permission.denied({
  targets: ['claude'],
}, async (event) => {
  await observeEvent(event);
});
