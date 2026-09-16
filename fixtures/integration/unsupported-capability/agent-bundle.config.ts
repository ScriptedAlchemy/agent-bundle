export default {
  hooks: {
    sessionStart: { handler: './src/hook.ts', targets: ['portable'] },
  },
  plugin: { name: 'unsupported-capability' },
  targets: ['portable'],
};
