import { basename, resolve } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import * as React from 'react';

import { writeEvalProbe } from '../../hook/eval-probe.js';
import { normalizeClaudeHook, normalizeCodexHook } from '../../hook/normalize.js';
import { createFileRuntimeKernel, resolveImplicitRuntimeStateFile } from '../../runtime/state-file.js';

export const config = {
  runtime: 'standalone',
  targets: ['claude', 'codex'],
  timeoutMs: 30_000,
  tools: ['file.write'],
};

export default async function AfterFileEdit({
  canonical,
  native,
  signal,
}: AgentEventRouteProps) {
  try {
    const host = canonical.provenance.host;
    const normalized = host === 'claude'
      ? normalizeClaudeHook(native)
      : host === 'codex'
        ? normalizeCodexHook(native)
        : undefined;
    if (normalized === undefined) {
      throw new Error(`Unsupported event-route host ${JSON.stringify(host)}`);
    }

    const configuredStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
    const stateFile = configuredStateFile === undefined || configuredStateFile.trim() === ''
      ? await resolveImplicitRuntimeStateFile(normalized.cwd)
      : resolve(configuredStateFile);
    const snapshot = await createFileRuntimeKernel({ stateFile }).recordEdit({
      host: normalized.host,
      idempotencyKey: canonical.idempotencyKey,
      path: normalized.path,
      sessionId: normalized.sessionId,
      toolName: normalized.toolName,
    }, { signal });
    const editNoun = snapshot.stateVersion === 1 ? 'edit' : 'edits';
    await writeEvalProbe(native, 0);

    return (
      <Agent.Result>
        <Agent.Context>
          {`Recorded ${basename(normalized.path)} from ${normalized.host}. Shared state now contains ${snapshot.stateVersion} ${editNoun}.`}
        </Agent.Context>
      </Agent.Result>
    );
  } catch (error) {
    await writeEvalProbe(native, 1).catch(() => undefined);
    throw error;
  }
}
