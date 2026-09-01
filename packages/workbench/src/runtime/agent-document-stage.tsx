import React, { useEffect, useState } from 'react';

import { MarkdownProjector } from '../skill-markdown.tsx';
import type {
  AgentDocument,
  AgentDocumentNode,
  AgentRenderEvent,
} from './agent-document-client.ts';

export type AgentDocumentProgress = Extract<AgentRenderEvent, { readonly type: 'progress' }>;
export type AgentDocumentStreamError = Extract<AgentRenderEvent, { readonly type: 'error' }>;

export interface AgentDocumentFold {
  readonly document?: AgentDocument;
  readonly errors: readonly AgentDocumentStreamError[];
  readonly finalStatus?: AgentDocument['status'];
  readonly progress?: AgentDocumentProgress;
}

/** Applies the already-ordered render events without replaying Suspense boundaries. */
export const foldAgentDocumentEvents = (events: readonly AgentRenderEvent[]): AgentDocumentFold => {
  let document: AgentDocument | undefined;
  let finalStatus: AgentDocument['status'] | undefined;
  let progress: AgentDocumentProgress | undefined;
  const errors: AgentDocumentStreamError[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'shell':
      case 'replace':
        document = event.document;
        break;
      case 'progress':
        progress = event;
        break;
      case 'error':
        errors.push(event);
        break;
      case 'complete':
        document = event.document;
        finalStatus = event.document.status;
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  return Object.freeze({
    ...(document === undefined ? {} : { document }),
    errors: Object.freeze(errors),
    ...(finalStatus === undefined ? {} : { finalStatus }),
    ...(progress === undefined ? {} : { progress }),
  });
};

const display = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable Agent Document value]';
  }
};

const progressLabel = (progress: Readonly<{
  readonly completed: number;
  readonly message?: string;
  readonly total?: number;
}>): string => {
  const amount = progress.total === undefined
    ? String(progress.completed)
    : `${String(progress.completed)} / ${String(progress.total)}`;
  return progress.message === undefined ? amount : `${progress.message} · ${amount}`;
};

const AgentDocumentNodeView = ({ node, path }: Readonly<{
  readonly node: AgentDocumentNode;
  readonly path: string;
}>): React.ReactNode => {
  switch (node.kind) {
    case 'result':
      return <section className="agent-document-result">
        {node.metadata === undefined ? undefined : <details><summary>Result metadata</summary><pre><code>{display(node.metadata)}</code></pre></details>}
        <div className="agent-document-children">
          {node.children.map((child, index) =>
            <AgentDocumentNodeView key={`${path}-${String(index)}`} node={child} path={`${path}-${String(index)}`} />)}
        </div>
      </section>;
    case 'markdown':
      return <MarkdownProjector body={node.text} />;
    case 'text':
      return <p className="agent-document-text">{node.text}</p>;
    case 'context':
      return <section className="agent-document-context">
        <h4>Additional context</h4>
        <p>{node.text}</p>
      </section>;
    case 'json':
      return <pre className="agent-document-json"><code>{display(node.value)}</code></pre>;
    case 'progress':
      return <p className="agent-document-progress" role="status">{progressLabel(node)}</p>;
    case 'image':
      return <figure className="agent-document-image">
        <img alt="Agent-rendered image" src={`data:${node.mimeType};base64,${node.data}`} />
        <figcaption>{node.mimeType}</figcaption>
      </figure>;
    case 'audio':
      return <figure className="agent-document-audio">
        <audio controls src={`data:${node.mimeType};base64,${node.data}`} />
        <figcaption>{node.mimeType}</figcaption>
      </figure>;
    case 'resource':
      return <dl className="agent-document-resource">
        <div><dt>Name</dt><dd>{node.name}</dd></div>
        <div><dt>URI</dt><dd><code>{node.uri}</code></dd></div>
        {node.mimeType === undefined ? undefined : <div><dt>MIME type</dt><dd>{node.mimeType}</dd></div>}
      </dl>;
    case 'error':
      return <p className="agent-document-error-node" role="alert"><strong>{node.code}</strong> · {node.message}</p>;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

const eventLabel = (event: AgentRenderEvent): string => {
  switch (event.type) {
    case 'shell':
      return `Shell · #${String(event.sequence)}`;
    case 'progress':
      return `Progress · #${String(event.sequence)} · ${progressLabel(event)}`;
    case 'replace':
      return `Replace · #${String(event.sequence)} · ${event.boundaryId}`;
    case 'error':
      return `Error · #${String(event.sequence)} · ${event.error.code}`;
    case 'complete':
      return `Complete · #${String(event.sequence)} · ${event.document.status}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

export interface AgentDocumentStageProps {
  readonly events: readonly AgentRenderEvent[];
}

/** Shared Agent Document projection with an inspectable as-of-event timeline. */
export const AgentDocumentStage = ({ events }: AgentDocumentStageProps): React.ReactNode => {
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(undefined);
  useEffect(() => setSelectedIndex(undefined), [events]);
  const visibleEvents = selectedIndex === undefined ? events : events.slice(0, selectedIndex + 1);
  const folded = foldAgentDocumentEvents(visibleEvents);
  const status = folded.finalStatus ?? folded.document?.status;

  return <section aria-label="Agent Document" className="agent-document-stage">
    <header className="agent-document-heading">
      <div>
        <h2>Agent Document</h2>
        <p>{folded.document === undefined ? 'No document snapshot is available.' : `Version ${String(folded.document.version)} · ${status}`}</p>
      </div>
      {folded.progress === undefined ? undefined : <p className="agent-document-live-progress" role="status">{progressLabel(folded.progress)}</p>}
    </header>
    {folded.errors.length === 0 ? undefined : <section aria-label="Agent Document diagnostics" className="agent-document-diagnostics">
      <h3>Render diagnostics</h3>
      <ul>{folded.errors.map((event) => <li key={`${String(event.sequence)}-${event.error.code}`}>
        <strong>{event.error.code}</strong> · {event.error.message}
        {event.boundaryId === undefined ? undefined : <> · boundary {event.boundaryId}</>}
        {event.error.data === undefined ? undefined : <pre><code>{display(event.error.data)}</code></pre>}
      </li>)}</ul>
    </section>}
    {folded.document === undefined ? <p>No Agent Document was produced by this event.</p> : <>
      <AgentDocumentNodeView node={folded.document.root} path="root" />
      {folded.document.value === undefined ? undefined : <details className="agent-document-value">
        <summary>Document value</summary>
        <pre><code>{display(folded.document.value)}</code></pre>
      </details>}
    </>}
    <aside aria-label="Agent Document event timeline" className="agent-document-timeline">
      <header><h3>Event timeline</h3><button aria-pressed={selectedIndex === undefined} onClick={() => setSelectedIndex(undefined)} type="button">Latest state</button></header>
      {events.length === 0 ? <p>No render events are available.</p> : <ol>{events.map((event, index) => <li key={`${event.type}-${String(event.sequence)}`}>
        <button aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(index)} type="button">{eventLabel(event)}</button>
      </li>)}</ol>}
    </aside>
  </section>;
};
