export default {
  marketplace: true,
  plugin: {
    description: 'Exercises native Eval hosts from an installed Agent Bundle tarball.',
    name: 'packed-native-smoke',
    version: '1.0.0',
  },
  skills: ['src/skills/review'],
  targets: ['claude', 'codex'],
};
