import packageManifest from '../package.json' with { type: 'json' };

/** Host-native project slug; package.json remains authoritative for release version. */
export const projectName = 'rsc-agent-runtime-demo';
export const projectVersion = packageManifest.version;
