import { basename, resolve } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import * as React from 'react';

import { writeEvalProbe } from '../../hook/eval-probe.js';
import { editedPath } from '../../hook/normalize.js';
import type { CanonicalPostToolUse } from '../../runtime/contracts.js';
import { createFileRuntimeKernel, resolveImplicitRuntimeStateFile } from '../../runtime/state-file.js';

export const config = {
  runtime: 'standalone',
  targets: ['claude', 'codex'],
  timeoutMs: 30_000,
  tools: ['file.write'],
};

const requiredField = <Value,>(field: string, mapped: { readonly value: Value } | undefined): Value => {
  if (mapped === undefined) {
    throw new Error(`Native hook input requires ${field}`);
  }
  return mapped.value;
};

/**
 * The shared fields come from `canonical.payload`, which the framework
 * projects the same way from Claude's and Codex's PostToolUse envelopes; only
 * the edited-path reading stays host-specific (see `editedPath`).
 */
const normalizedEvent = (
  { idempotencyKey, payload, provenance }: AgentEventRouteProps<'tool/after'>['canonical'],
): CanonicalPostToolUse => {
  const host = provenance.host;
  if (host !== 'claude' && host !== 'codex') {
    throw new Error(`Unsupported event-route host ${JSON.stringify(host)}`);
  }
  const cwd = requiredField('cwd', payload.cwd);
  const toolName = requiredField('tool_name', payload.toolName);
  return {
    cwd,
    host,
    idempotencyKey,
    path: editedPath(host, cwd, toolName, requiredField('tool_input', payload.toolInput)),
    sessionId: requiredField('session_id', payload.sessionId),
    toolName,
  };
};

export default async function AfterFileEdit({
  canonical,
  native,
  signal,
}: AgentEventRouteProps<'tool/after'>) {
  try {
    const normalized = normalizedEvent(canonical);

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
