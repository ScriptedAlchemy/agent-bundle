interface SessionStartEvent {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly transcriptPath?: string;
}

export default (event: SessionStartEvent) => ({
  additionalContext: [
    `This release preparation session is active for ${event.sessionId ?? 'this session'} from ${event.source ?? 'an unknown source'}.`,
    `Run verify-release from ${event.cwd ?? process.cwd()} to confirm the manifest is ready for packaging.`,
    'Run detect-risk to surface open high-severity release blockers before publishing.',
  ].join(' '),
  outcome: 'continue' as const,
});
