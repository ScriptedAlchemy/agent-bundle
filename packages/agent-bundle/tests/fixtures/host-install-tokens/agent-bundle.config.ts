// Claude-only on purpose: skill targeting is project-wide, and the arguments
// and skill-root tokens have no Codex or Cursor Skill Markdown equivalent, so
// selecting either host makes this project fail the build with AB3008.
export default {
  plugin: {
    description: 'Proves canonical Skill tokens resolving in a real Claude session.',
    name: 'host-install-token-proof',
  },
  skills: ['src/skills/token-probe'],
  targets: ['claude'],
};
