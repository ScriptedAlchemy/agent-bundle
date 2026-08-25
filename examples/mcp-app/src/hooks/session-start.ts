interface SessionStartEvent {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly source?: string;
}

export default (event: SessionStartEvent) => ({
  additionalContext: [
    `Service readiness session ${event.sessionId ?? 'is active'} from ${event.source ?? 'an unknown source'}.`,
    `Use the service-readiness Skill, then run check-service-fixture from ${event.cwd ?? process.cwd()} before release review.`,
    'Use show-status for compiler or payments-api when live service evidence is needed.',
  ].join(' '),
  outcome: 'continue' as const,
});
