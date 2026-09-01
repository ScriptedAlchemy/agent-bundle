import { defineConfig } from '@rstest/core';
import { agentBundleBrowserRstest } from 'agent-bundle/rstest';

export default defineConfig(await agentBundleBrowserRstest());
