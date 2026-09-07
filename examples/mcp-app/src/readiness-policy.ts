export const readinessPolicyUri = 'policy://mcp-app-example/readiness';

/** The release rule the App shows beside a status; the Skill's `status-policy.md` is the long form. */
export const readinessPolicy = [
  'Issue `ready` only for a healthy service with current evidence.',
  'A degraded service needs an explicit mitigation decision; a blocked service cannot pass;',
  'and missing evidence requires a new check rather than an assumption.',
].join(' ');
