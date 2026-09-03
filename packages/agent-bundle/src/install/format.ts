import type { InstallResult } from './install.ts';

const shortContentHash = (hash: string): string => hash.slice(0, 12);

const installVerb = (state: InstallResult['state'], mode: InstallResult['mode']): string => {
  switch (state) {
    case 'adopted':
      return 'Adopted';
    case 'replaced':
      return 'Replaced';
    case 'already-installed':
      // Marketplace mode has not installed anything into Cursor yet; the Customize step is still pending.
      return mode === 'marketplace' ? 'Already staged' : 'Already installed';
    case 'installed':
      return 'Installed';
    case 'staged':
      return 'Staged';
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unknown install state ${String(exhaustive)}.`);
    }
  }
};

/** Human-readable install summary shared by the CLI and generated installer bins. */
export const formatInstallResult = (result: InstallResult): string => {
  const destination = result.destination ?? result.bundleRoot;
  const mode = result.mode === undefined ? '' : ` (${result.mode} mode)`;
  const content = result.previousContentHash !== undefined && result.contentHash !== undefined
    ? ` (content ${shortContentHash(result.previousContentHash)} -> ${shortContentHash(result.contentHash)})`
    : result.contentHash === undefined
      ? ''
      : ` (content ${shortContentHash(result.contentHash)})`;
  const lines = [
    `${installVerb(result.state, result.mode)} ${result.plugin}@${result.version} for ${result.host}${mode} at ${destination}${content}`,
  ];
  if (result.marketplace !== undefined && result.host === 'cursor') {
    lines.push(`Marketplace: ${result.marketplace}${result.commit === undefined ? '' : ` @ ${result.commit}`}`);
  }
  if (result.nextSteps !== undefined && result.nextSteps.length > 0) {
    lines.push('Next steps:');
    lines.push(...result.nextSteps.map((step, index) => `  ${index + 1}. ${step}`));
  }
  return `${lines.join('\n')}\n`;
};
