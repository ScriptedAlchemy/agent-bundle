import { meta, name, version } from 'agent-bundle/meta';

/**
 * A plain script that reports the project identity the build stamps into
 * `agent-bundle/meta`. Outside a compiled surface the published entry throws,
 * so this only runs where the generated identity module is served.
 */
export const main = (): number => {
  process.stdout.write(`${name}@${version} ${meta.packageName ?? '-'} ${meta.packageVersion ?? '-'}\n`);
  return 0;
};
