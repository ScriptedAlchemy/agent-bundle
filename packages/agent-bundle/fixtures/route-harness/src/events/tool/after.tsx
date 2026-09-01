import { Agent, agent } from '@agent-bundle/runtime';

export default async function AfterTool({ event, payload }: { readonly event: string; readonly payload: unknown }) {
  const context = await agent();
  return (
    <Agent.Result value={{ event, invocationKind: context.invocation.kind, payload: payload as never }}>
      <Agent.Markdown>{`Observed ${event}.`}</Agent.Markdown>
    </Agent.Result>
  );
}
