import type { InstallResult } from './install.ts';
import type { UninstallResult } from './uninstall.ts';

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

const uninstallVerb = (state: UninstallResult['state']): string => {
  switch (state) {
    case 'not-installed':
      return 'Not installed';
    case 'planned':
      return 'Would uninstall';
    case 'uninstalled':
      return 'Uninstalled';
    default: {
      const exhaustive: never = state;
      throw new TypeError(`Unknown uninstall state ${String(exhaustive)}.`);
    }
  }
};

const registrationLabel = (registration: UninstallResult['registrations'][number]): string =>
  registration.id ?? registration.name ?? registration.kind;

/**
 * Human-readable uninstall summary shared by the CLI and generated installer
 * bins. `--plan` output lists every exact path the run would remove, so an
 * operator can audit the mutation before allowing it.
 */
export const formatUninstallResult = (result: UninstallResult): string => {
  const where = result.destination === undefined ? '' : ` at ${result.destination}`;
  const lines = [
    `${uninstallVerb(result.state)} ${result.plugin}@${result.version} for ${result.host} (${result.mode} mode)${where}` +
      `${result.forced ? ' [--force]' : ''}`,
    `Receipt: ${result.receipt.status} (${result.receipt.path})`,
  ];
  for (const registration of result.registrations) {
    lines.push(`Registration ${registration.kind} ${registrationLabel(registration)}: ${registration.action}` +
      `${registration.detail === undefined ? '' : ` — ${registration.detail}`}`);
  }
  if (result.state !== 'not-installed') {
    const verb = result.state === 'planned' ? 'Would remove' : 'Removed';
    lines.push(`${verb} ${result.removed.files.length} file(s):`);
    lines.push(...result.removed.files.map((path) => `  ${path}`));
    lines.push(`${verb} ${result.removed.directories.length} director${result.removed.directories.length === 1 ? 'y' : 'ies'}` +
      `${result.state === 'planned' ? ' (when empty)' : ''}:`);
    lines.push(...result.removed.directories.map((path) => `  ${path}`));
  }
  lines.push(`Data (${result.data.policy}): ${result.data.outcome} — ${result.data.detail}`);
  lines.push(...result.data.paths.map((path) => `  ${path}`));
  if (result.retained.length > 0) {
    lines.push(`Retained ${result.retained.length} unowned entr${result.retained.length === 1 ? 'y' : 'ies'} under ${result.destination ?? 'the destination'}:`);
    lines.push(...result.retained.map((entry) => `  ${entry}`));
  }
  if (result.remnantReceipt !== undefined) {
    lines.push(`Remnant receipt${result.state === 'planned' ? ' (would be written)' : ''}: ${result.remnantReceipt} — owns no files; ` +
      'keeps the created host directories receipt-owned for a later purge.');
  }
  if (result.nextSteps !== undefined && result.nextSteps.length > 0) {
    lines.push('Next steps:');
    lines.push(...result.nextSteps.map((step, index) => `  ${index + 1}. ${step}`));
  }
  return `${lines.join('\n')}\n`;
};
