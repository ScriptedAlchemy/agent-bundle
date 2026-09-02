import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import type { AudibleCacheReceipt } from '../../../audible.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { Callout, DataList } from '../../../components/primitives.js';
import { defaultAudibleOperations, audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleCache;

export const config = {"annotations":{"openWorldHint":true,"readOnlyHint":false},"description":"Cache a reviewed Audible edition and retained source evidence."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleCacheReceipt;
  const headline = `Cached Audible ${receipt.region}/${receipt.asin} product evidence${receipt.chapters === undefined ? ' without chapter metadata' : ' with chapter metadata'}.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <DataList fields={[
        { label: 'Audible edition', value: `${receipt.region}/${receipt.asin}` },
        { label: 'Product evidence', value: receipt.product },
        ...(receipt.chapters === undefined ? [] : [{ label: 'Chapter evidence', value: receipt.chapters }]),
        ...(receipt.artwork === undefined ? [] : [{ label: 'Artwork evidence', value: receipt.artwork }]),
      ]} />
      {receipt.chapterError === undefined
        ? null
        : <Callout tone="warning">{`Chapter metadata was not cached: ${receipt.chapterError}`}</Callout>}
    </CuratorDocument>
  );
}
