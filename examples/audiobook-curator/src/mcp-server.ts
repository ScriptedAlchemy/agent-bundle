import { createRscMcpServer } from '@agent-bundle/rsc-runtime/plugin';

import { audiobookCuratorApplication } from './application.js';

export const createAudiobookCuratorServer = () => createRscMcpServer(audiobookCuratorApplication, 'curator');

/**
 * Default-exported server factory: `agent-bundle build` detects it and wraps
 * this entry in the framework stdio lifecycle shell (console-to-stderr guard,
 * SIGINT/SIGTERM handling, stdin-EOF exit, bounded shutdown, heartbeat).
 */
export default createAudiobookCuratorServer;
