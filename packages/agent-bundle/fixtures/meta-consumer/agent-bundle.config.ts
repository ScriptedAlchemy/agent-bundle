// A project whose source imports `agent-bundle/meta` (issue #386). Plain
// object export, like every other repository fixture. `plugin.version` is
// omitted on purpose: the resolved version, `packageName`, and
// `packageVersion` all derive from the sibling package.json, which is the
// identity the Rstest presets must hand to source under test.
export default {
  plugin: {
    description: 'Source that reads its own release identity from agent-bundle/meta.',
    name: 'meta-consumer',
  },
  targets: ['claude'],
};
