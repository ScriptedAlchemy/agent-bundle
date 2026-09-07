import { formatByteSize } from '../core/strings.ts';
import type {
  DoctorDurableStateReport,
  DoctorInstallComparison,
  DoctorLifecycle,
  DoctorReport,
} from './doctor.ts';
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

/** Human-readable install summary shared by the CLI and standalone artifact installer. */
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
 * Human-readable uninstall summary shared by the CLI and standalone artifact
 * installer. `--plan` output lists every exact path the run would remove, so an
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

const describeLifecycle = (lifecycle: DoctorLifecycle): string => {
  const observations = (['placed', 'registered', 'enabled', 'active'] as const).map((stage) => {
    const observation = lifecycle[stage];
    return observation.status === 'observed'
      ? `${stage}=${observation.value ? 'yes' : 'no'}`
      : `${stage}=unavailable`;
  });
  return `${lifecycle.stage} (${observations.join(', ')})`;
};

const describeInstallComparison = (comparison: DoctorInstallComparison): string => {
  const installed = (comparison.installedContentHash === undefined
    ? ''
    : `; installed ${comparison.installedVersion ?? 'unknown version'} ` +
      `content ${shortContentHash(comparison.installedContentHash)}, ` +
      `artifact content ${shortContentHash(comparison.artifactContentHash)}`) +
    (comparison.enabled === false ? '; disabled by the host' : '');
  switch (comparison.status) {
    case 'current':
      return `current${installed}`;
    case 'stale':
      return `stale (same version, different content)${installed}`;
    case 'version-mismatch':
      return `version mismatch${installed}`;
    case 'foreign':
      return `foreign install${installed}`;
    case 'load-failed':
      return `load failed (installed ${comparison.installedVersion ?? 'unknown version'}, refused by the host: ` +
        `${(comparison.errors ?? []).join(' | ')})`;
    case 'not-installed':
      return 'not installed';
    case 'unknown':
      return 'unknown (host inventory unavailable)';
    default: {
      const exhaustive: never = comparison.status;
      throw new TypeError(`Unknown install comparison ${String(exhaustive)}.`);
    }
  }
};

/** Human-readable doctor report shared by the `agent-bundle` CLI and package-bound installer bins. */
export const formatDoctorReport = (result: DoctorReport): string => {
  const out: string[] = [];
  for (const host of result.hosts) {
    const detail = host.probe.version ?? host.probe.evidence;
    out.push(`${host.host}: ${host.probe.status}${detail === undefined ? '' : ` (${detail})`}\n`);
    out.push(
      `  inventory: ${host.inventory.status}` +
      `${host.inventory.status === 'known' ? ` (${host.inventory.findings.length} finding(s))` : ''}\n`,
    );
    if (host.bundle !== undefined) {
      const identity = host.bundle.name === undefined
        ? ''
        : ` ${host.bundle.name}${host.bundle.version === undefined ? '' : `@${host.bundle.version}`}`;
      out.push(`  bundle:${identity} ${host.bundle.state}\n`);
      if (host.bundle.comparison !== undefined) {
        out.push(`  installed copy: ${describeInstallComparison(host.bundle.comparison)}\n`);
      }
      for (const validation of host.bundle.hostValidation ?? []) {
        out.push(
          `  host validation (${validation.copy} ${validation.pluginDirectory}` +
          `${validation.scope === undefined ? '' : `, scope ${validation.scope}`}): ${validation.status}\n`,
        );
      }
      if (host.bundle.lifecycle !== undefined) {
        out.push(`  lifecycle: ${describeLifecycle(host.bundle.lifecycle)}\n`);
      }
    }
    if (host.receipts.length > 0) {
      out.push(`  receipts: ${host.receipts.length} store receipt(s)\n`);
      for (const receipt of host.receipts) {
        out.push(`    ${receipt.plugin}@${receipt.version} (${receipt.mode}, ${receipt.scope}): ${receipt.state}\n`);
      }
    }
    const reports = [
      ...host.inventory.findings.flatMap((finding) => finding.durableStates ?? (
        finding.durableState === undefined ? [] : [finding.durableState]
      )),
      host.bundle?.durableState,
    ].filter((report): report is DoctorDurableStateReport => report !== undefined);
    const uniqueReports = [...new Map(reports.map((report) => [report.directory, report])).values()];
    for (const report of uniqueReports) {
      out.push(
        `  state root: ${report.directory} (${report.exists ? 'exists' : 'missing'}, ` +
        `${report.writable ? 'writable' : 'not writable'}, ${report.stateSource}); ` +
        `ownership: ${report.ownership}${report.ownershipReason === undefined ? '' : ` (${report.ownershipReason})`}, ` +
        `${report.purgeable ? 'purgeable' : 'retained'}${
          report.servers.length === 0 ? '' : `, servers: ${report.servers.join(', ')}`
        }\n`,
      );
    }
    const legacyReports = host.inventory.findings
      .map((finding) => finding.legacyDurableState)
      .filter((report): report is DoctorDurableStateReport => report !== undefined);
    for (const report of [...new Map(legacyReports.map((entry) => [entry.directory, entry])).values()]) {
      out.push(`  legacy state: ${report.directory} (exists, ${report.writable ? 'writable' : 'not writable'})\n`);
    }
    if (uniqueReports.length > 0) {
      const stores = uniqueReports.reduce((total, report) => total + report.summary.stores, 0);
      const bytes = uniqueReports.reduce((total, report) => total + report.summary.bytes, 0);
      out.push(
        `  durable state: ${stores} ${stores === 1 ? 'store' : 'stores'}, ${formatByteSize(bytes)}\n`,
      );
    }
    // The operator `.env` layer (#469): present files and their variable counts, never a value.
    const operatorEnvFiles = [
      ...host.inventory.findings.map((finding) => finding.operatorEnv),
      host.bundle?.operatorEnv,
    ].flatMap((report) => report?.files ?? []).filter((file) => file.state !== 'absent');
    const uniqueEnvFiles = [...new Map(operatorEnvFiles.map((file) => [file.path, file])).values()];
    if (uniqueEnvFiles.length > 0) {
      out.push(`  operator env: ${uniqueEnvFiles.map((file) =>
        `${file.path} (${file.state === 'present' ? `${String(file.variables ?? 0)} variable${file.variables === 1 ? '' : 's'}` : file.state})`).join(', ')}\n`);
    }
  }
  if (result.web !== undefined) {
    out.push(`${result.web.line}\n`);
  }
  out.push(
    `runtime endpoints: ${result.endpoints.status}; ${result.endpoints.summary.live} live, ` +
    `${result.endpoints.summary.staleSockets} stale socket(s), ` +
    `${result.endpoints.summary.staleLocks} stale lock(s)\n`,
  );
  for (const entry of result.diagnostics) {
    out.push(`${entry.code}: ${entry.message}\nRecovery: ${entry.recovery}\n`);
  }
  out.push(
    `Doctor summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ` +
    `${result.summary.infos} info(s)\n`,
  );
  return out.join('');
};
