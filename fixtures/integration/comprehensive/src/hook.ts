export default (event: { readonly source?: string }) => ({
  additionalContext: `hook:${event.source ?? 'unknown'}`,
  outcome: 'continue' as const,
});
