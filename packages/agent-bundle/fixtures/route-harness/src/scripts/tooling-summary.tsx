import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

export const resultSchema = z.object({
  arguments: z.number().int().nonnegative(),
  keys: z.array(z.string()),
  libraryTooling: z.unknown().optional(),
}).strict();

export default async function ToolingSummary({ argv, signal }: {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
}) {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const { providers } = await agent();
  const value = {
    arguments: argv.length,
    keys: Object.keys(providers).sort(),
    libraryTooling: providers['libraryTooling'] as JsonValue,
  };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`Summarized ${String(argv.length)} arguments.`}</Agent.Text>
    </Agent.Result>
  );
}
