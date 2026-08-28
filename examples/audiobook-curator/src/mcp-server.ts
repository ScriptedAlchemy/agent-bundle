import { createRscMcpServer } from '@agent-bundle/rsc-runtime/plugin';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { audiobookCuratorApplication } from './application.js';

export const createAudiobookCuratorServer = () => createRscMcpServer(audiobookCuratorApplication, 'curator');

await createAudiobookCuratorServer().connect(new StdioServerTransport());
