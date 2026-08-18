export default (event: { readonly source?: string }) => ({
  additionalContext: `packed:${event.source ?? 'unknown'}`,
  outcome: 'continue' as const,
});
