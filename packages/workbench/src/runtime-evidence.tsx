import React from 'react';

import type { DevRuntimeDiagnostic, DevRuntimeInspectionEnvelope, DevRuntimeTraceSpan } from '../../agent-bundle/src/contracts/runtime.ts';
import { McpProtocolEvidence } from './mcp/mcp-page.tsx';

export type RuntimeEvidenceInput =
  | Readonly<{ readonly kind: 'protocol'; readonly protocol?: DevRuntimeInspectionEnvelope['protocol']; readonly trace: readonly DevRuntimeTraceSpan[] }>
  | Readonly<{ readonly diagnostics: readonly DevRuntimeDiagnostic[]; readonly kind: 'diagnostics' }>
  | Readonly<{
    /** Presentation-only span disclosure; details always render when absent. */
    readonly expansion?: Readonly<{
      readonly expandedIds: readonly string[];
      readonly onToggle: (spanId: string) => void;
    }>;
    readonly kind: 'trace';
    readonly trace: readonly DevRuntimeTraceSpan[];
  }>;

export interface RuntimeEvidenceProps {
  readonly evidence: RuntimeEvidenceInput;
}

export const RuntimeEvidence = ({ evidence }: RuntimeEvidenceProps): React.ReactNode => {
  if (evidence.kind === 'protocol') return <section aria-label="Runtime protocol evidence" className="inspector-runtime-evidence">
    <McpProtocolEvidence ariaLabel="Provider MCP protocol" protocol={evidence.protocol} trace={evidence.trace} />
  </section>;
  if (evidence.kind === 'diagnostics') return <section aria-label="Runtime diagnostics evidence" className="inspector-runtime-evidence">
    <h3>Provider diagnostics</h3>
    {evidence.diagnostics.length === 0 ? <p>No provider diagnostics.</p> : <ol>{evidence.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}><strong>{diagnostic.phase}</strong> <span>{diagnostic.severity}</span> <code>{diagnostic.code}</code> {diagnostic.message}</li>)}</ol>}
  </section>;
  const expansion = evidence.expansion;
  const expandedIds = expansion === undefined ? undefined : new Set(expansion.expandedIds);
  return <section aria-label="Runtime render trace" className="inspector-runtime-evidence">
    <h3>Render trace</h3>
    {evidence.trace.length === 0 ? <p>No render evidence yet.</p> : <ol>{evidence.trace.map((span) => {
      const expanded = expandedIds === undefined || expandedIds.has(span.id);
      return <li data-runtime-trace-parent={span.parentId} key={span.id}>
        <strong>{span.phase}</strong> <span>{span.status}</span>{span.durationMs === undefined ? undefined : <span>{span.durationMs} ms</span>}
        {span.details === undefined || expansion === undefined ? undefined :
          <button aria-expanded={expanded} onClick={() => expansion.onToggle(span.id)} type="button">{expanded ? 'Hide span details' : 'Show span details'}</button>}
        {span.details === undefined || !expanded ? undefined : <pre>{JSON.stringify(span.details, null, 2)}</pre>}
      </li>;
    })}</ol>}
  </section>;
};
