import type { AgentProviderContext } from 'agent-bundle';

/**
 * A conventional request context provider. The harness mounts it for every
 * manifest request scope exactly as the generated entries do, so routes on
 * every surface observe `providers.libraryTooling` with the surface-specific
 * invocation kind the provider saw.
 */
export default async function libraryTooling({ invocation, signal }: AgentProviderContext) {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const input = invocation.kind === 'tool' ? invocation.props.input : undefined;
  const failProvider = typeof input === 'object'
    && input !== null
    && (input as { readonly failProvider?: unknown }).failProvider === true;
  const failCliProvider = invocation.kind === 'cli'
    && invocation.props.args.includes('{"failProvider":true}');
  if (failProvider || failCliProvider) {
    throw new Error('ffprobe is not installed');
  }
  const surface = invocation.kind === 'tool'
    ? invocation.props.operationId
    : invocation.kind === 'cli'
      ? invocation.props.command
      : invocation.kind === 'script'
        ? invocation.props.name
        : invocation.kind === 'event'
          ? invocation.props.event
          : invocation.props.view;
  return { kind: invocation.kind, surface, tool: 'ffprobe 6.1' };
}
