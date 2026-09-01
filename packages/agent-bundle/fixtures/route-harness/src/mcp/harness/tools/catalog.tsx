import { Agent } from '@agent-bundle/runtime';
import { Suspense } from 'react';
import { z } from 'zod';

export const config = {
  description: 'Streams the harness catalog behind one Suspense boundary.',
  title: 'Catalog',
};

export const inputSchema = z.object({ genre: z.string().optional() });

export const resultSchema = z.object({ genre: z.string(), titles: z.array(z.string()) });

const titles = ['Piranesi', 'Solaris'];

/** Resolves after the shell, so the render has a boundary to replace. */
const Titles = async ({ genre }: { readonly genre: string }) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
  return <Agent.Markdown>{`## ${genre}\n\n${titles.map((title) => `- ${title}`).join('\n')}`}</Agent.Markdown>;
};

export default async function Catalog({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const genre = input.genre ?? 'all';
  return (
    <Agent.Result value={{ genre, titles }}>
      <Agent.Text>{`catalog: ${genre}`}</Agent.Text>
      <Suspense fallback={<Agent.Progress completed={0} message={`loading ${genre}`} total={titles.length} />}>
        <Titles genre={genre} />
      </Suspense>
    </Agent.Result>
  );
}
