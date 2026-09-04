import type { HookHandler } from 'agent-bundle';

export default ((event) => ({
  additionalContext: [
    `This release preparation session is active for ${event.sessionId} from ${event.source ?? 'an unknown source'}.`,
    `Run verify-release from ${event.cwd ?? process.cwd()} to confirm the manifest is ready for packaging.`,
    'Run detect-risk to surface open high-severity release blockers before publishing.',
  ].join(' '),
  outcome: 'continue',
})) satisfies HookHandler<'sessionStart'>;
