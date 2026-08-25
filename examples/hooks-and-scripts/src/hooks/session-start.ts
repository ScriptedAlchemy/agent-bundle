export default (event: { readonly source?: string }) => ({
  additionalContext: `example session from ${event.source ?? 'unknown'}`,
  outcome: 'continue' as const,
});
