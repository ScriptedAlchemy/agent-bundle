import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import type { ResourceConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { Callout, DataList } from '../../../components/primitives.tsx';
import type { LibraryContext } from '../../../providers/library.ts';

export const config = {
  description: 'Read the audiobook curator workflow catalog.',
  mimeType: 'application/json',
  uri: 'audiobook-curator://catalog',
} satisfies ResourceConfig;
export const inputSchema = z.object({ uri: z.string() }).strict();
export const resultSchema = z.object({
  contents: z.array(z.object({ mimeType: z.literal('application/json'), text: z.string(), uri: z.string() }).strict()),
}).strict();

const workflowStages = ['discover', 'identify', 'curate', 'verify'] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object';

const isToolProbe = (value: unknown): value is { readonly available: boolean; readonly version?: string } =>
  isRecord(value)
  && typeof value.available === 'boolean'
  && (value.version === undefined || typeof value.version === 'string');

const isLibraryContext = (value: unknown): value is LibraryContext => {
  if (!isRecord(value) || !isRecord(value.tooling)) return false;
  if (!isToolProbe(value.tooling.ffmpeg) || !isToolProbe(value.tooling.ffprobe)) return false;
  if (typeof value.probedAt !== 'string' || !Array.isArray(value.stages)) return false;
  return value.stages.length > 0 && value.stages.every((stage) => typeof stage === 'string' && stage !== '');
};

export default async function Catalog({ input }: ToolRouteProps<typeof inputSchema>) {
  const request = await agent();
  const library = isLibraryContext(request.providers.library)
    ? request.providers.library
    : undefined;
  const stages = library?.stages ?? workflowStages;
  const tooling = library?.tooling ?? {
    ffmpeg: { available: false },
    ffprobe: { available: false },
  };
  const catalog = library ?? {
    context: {
      available: false,
      reason: 'Library request context is missing or malformed.',
    },
    stages,
    tooling,
  };
  const result = {
    contents: [{
      mimeType: 'application/json' as const,
      text: JSON.stringify(catalog),
      uri: input.uri,
    }],
  };

  return (
    <Agent.Result value={result as JsonValue}>
      <Agent.Text>
        {library === undefined
          ? 'Audiobook curator catalog unavailable.'
          : 'Audiobook curator catalog ready.'}
      </Agent.Text>
      <DataList fields={[
        { label: 'Workflow stages', value: stages.join(' → ') },
        { label: 'ffmpeg available', value: tooling.ffmpeg.available },
        { label: 'ffmpeg version', value: tooling.ffmpeg.version ?? 'unavailable' },
        { label: 'ffprobe available', value: tooling.ffprobe.available },
        { label: 'ffprobe version', value: tooling.ffprobe.version ?? 'unavailable' },
        { label: 'Probed at', value: library?.probedAt ?? 'not probed' },
      ]} />
      {library === undefined
        ? (
            <Callout tone="warning">
              Library request context is missing or malformed; tooling availability could not be probed.
            </Callout>
          )
        : (
            <Callout tone="review">
              Tooling availability reflects a request-time probe; unavailable tools are not assumed.
            </Callout>
          )}
    </Agent.Result>
  );
}
