import React from 'react';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

import type { LibraryAuditReceipt } from '../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).libraryAudit;

/**
 * The rendered command of this CLI (#102 stage 3): the audit is the
 * long-running surface, so an interactive terminal gets in-place progress
 * and a piped run gets one Markdown summary document. `--json` keeps the
 * canonical receipt (the same value the plain command printed), and the
 * receipt's own `exitCode` stays authoritative through the result policy.
 */
export const config = {
  description: 'Audit metadata, artwork, chapters, duplicate candidates, and multipart groups.',
  exitCode: 'result',
  positionals: ['sources'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  concurrency: z.number().int().min(1).max(8).optional(),
  report: z.string().min(1).max(4096),
  sources: z.array(z.string().min(1).max(4096)).min(1).max(64),
  strict: z.boolean().optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function LibraryAudit({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const total = input.sources.length;
  await context.progress.report({ completed: 0, message: 'Auditing sources', total });
  const receipt = await operation.handler(input, { signal }) as LibraryAuditReceipt;
  await context.progress.report({ completed: total, message: 'Audit complete', total });
  const { summary } = receipt;
  const issues =
    summary.missingAlbum + summary.missingArtwork + summary.missingAuthor +
    summary.missingChapters + summary.missingTitle + summary.probeFailures;
  return (
    <Agent.Result value={receipt as unknown as JsonValue}>
      <Agent.Markdown>
        {[
          `## Library audit`,
          '',
          `Audited **${String(summary.files)}** files (${String(summary.bytes)} bytes) across **${String(total)}** sources.`,
          '',
          `- metadata issues: **${String(issues)}**`,
          `- duplicate candidates: **${String(receipt.duplicateCandidates.length)}**`,
          `- multipart candidates: **${String(receipt.multipartCandidates.length)}**`,
          '',
          receipt.reviewNote,
        ].join('\n')}
      </Agent.Markdown>
    </Agent.Result>
  );
}
