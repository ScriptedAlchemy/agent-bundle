export default {
  plugin: { name: 'canonical-collision' },
  scripts: {
    bundle: './src/bundle.ts',
    'dir/../bundle': './src/bundle.ts',
  },
  targets: ['portable'],
};
