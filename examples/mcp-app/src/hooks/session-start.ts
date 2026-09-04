import type { HookHandler } from 'agent-bundle';

export default ((event) => ({
  additionalContext: [
    `Service readiness session ${event.sessionId} from ${event.source ?? 'an unknown source'}.`,
    `Use the service-readiness Skill, then run check-service-fixture from ${event.cwd ?? process.cwd()} before release review.`,
    'Use show-status for compiler or payments-api when live service evidence is needed.',
  ].join(' '),
  outcome: 'continue',
})) satisfies HookHandler<'sessionStart'>;
