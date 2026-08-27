export default {
  hooks: {
    sessionStart: { handler: './src/hook.ts', targets: ['portable'] },
  },
  plugin: { name: 'unsupported-capability', version: '1.0.0' },
  targets: ['portable'],
};
