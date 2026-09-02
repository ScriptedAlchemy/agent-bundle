import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: {
    description: 'Coordinate related agents across linked worktrees without a daemon.',
    name: 'worktree-proximity',
    version: '1.0.0',
  },
  runtime: { node: '22.19.0' },
  targets: ['claude', 'codex'],
});
