import { Agent } from '@agent-bundle/runtime';
import { Suspense } from 'react';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Throws from the route or from a nested Suspense boundary, for thrown-error projection proof.',
};

export const inputSchema = z.object({
  mode: z.enum(['ok', 'throw', 'reject-boundary']).default('ok'),
});

export const resultSchema = z.object({ mode: z.string(), settled: z.literal(true) });

/** Rejects after the shell has streamed, so the failure is a settled boundary rather than the root. */
const Rejecting = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
  throw new Error('fault: boundary rejected');
};

/**
 * The route-harness fixture for #492: a thrown (not represented) error. `throw`
 * rejects the route's own default export before any document exists;
 * `reject-boundary` streams a shell whose nested Suspense child rejects.
 * Neither renders `Agent.Error` — that represented path is `unavailable.tsx`.
 */
export default async function Fault({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  if (input.mode === 'throw') throw new Error('fault: route threw');
  return (
    <Agent.Result value={{ mode: input.mode, settled: true }}>
      <Agent.Text>{`fault: ${input.mode}`}</Agent.Text>
      {input.mode === 'reject-boundary'
        ? (
          <Suspense fallback={<Agent.Progress completed={0} message="faulting" />}>
            <Rejecting />
          </Suspense>
        )
        : null}
    </Agent.Result>
  );
}
