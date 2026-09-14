import { events } from 'agent-bundle/routes';

import { observeEvent } from '../../event-route.js';

export default events.config.change({
  targets: ['claude'],
}, async (event) => {
  await observeEvent(event);
});
