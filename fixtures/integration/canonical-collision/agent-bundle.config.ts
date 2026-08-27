export default {
  plugin: { name: 'canonical-collision', version: '1.0.0' },
  scripts: {
    bundle: './src/bundle.ts',
    'dir/../bundle': './src/bundle.ts',
  },
  targets: ['portable'],
};
