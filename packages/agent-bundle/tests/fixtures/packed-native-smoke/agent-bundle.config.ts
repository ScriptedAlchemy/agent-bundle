export default {
  marketplace: true,
  plugin: {
    description: 'Exercises native Eval hosts from an installed Agent Bundle tarball.',
    name: 'packed-native-smoke',
  },
  skills: ['src/skills/review'],
  targets: ['claude', 'codex'],
};
