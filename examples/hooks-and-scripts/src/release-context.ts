export const releaseContext = (
  sessionId: string,
  cwd: string,
  source: string,
): string => [
  `This release preparation session is active for ${sessionId} from ${source}.`,
  `Run verify-release from ${cwd} to confirm the manifest is ready for packaging.`,
  'Run detect-risk to surface open high-severity release blockers before publishing.',
].join(' ');
