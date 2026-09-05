/**
 * The browser projection of an Agent Document (#600): the route JSX rendered
 * through the production runtime arrives as the `shell | progress | replace |
 * error | complete` render-event stream, and this module folds that stream and
 * renders the semantic node tree with rich browser components. It is the
 * default result pane of every route workspace; the MCP and CLI lowered forms
 * are secondary tabs beside it.
 *
 * `RenderedAgentDocument` is designed around `events`, not a final document,
 * so a backend that streams can feed it progressively: Suspense boundaries
 * appear as the shell, progress shows live, and `replace` swaps them in.
 */
import React from 'react';

import { MarkdownProjector } from '../skill-markdown.tsx';
import { allowedExternalResourceUrl } from '../skills-model.ts';
import type {
  AgentDocument,
  AgentDocumentNode,
  AgentRenderEvent,
} from '../runtime/agent-document-client.ts';

export type AgentDocumentProgress = Extract<AgentRenderEvent, { readonly type: 'progress' }>;
export type AgentDocumentStreamError = Extract<AgentRenderEvent, { readonly type: 'error' }>;

export interface AgentDocumentFold {
  /** True once a `complete` event arrived; until then the document is a shell or a partial replacement. */
  readonly complete: boolean;
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
  let complete = false;
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
        complete = true;
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  return Object.freeze({
    complete,
    ...(document === undefined ? {} : { document }),
    errors: Object.freeze(errors),
    ...(finalStatus === undefined ? {} : { finalStatus }),
    ...(progress === undefined ? {} : { progress }),
  });
};

export const displayAgentDocumentValue = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unserializable Agent Document value]';
  }
};

export const agentDocumentProgressLabel = (progress: Readonly<{
  readonly completed: number;
  readonly message?: string;
  readonly total?: number;
}>): string => {
  const amount = progress.total === undefined
    ? String(progress.completed)
    : `${String(progress.completed)} / ${String(progress.total)}`;
  return progress.message === undefined ? amount : `${progress.message} · ${amount}`;
};

const agentDocumentImageUrl = (reference: string): string | undefined =>
  /^data:/iu.test(reference) ? reference : undefined;

const agentDocumentLinkUrl = (reference: string): string | undefined =>
  reference.startsWith('#') ? reference : allowedExternalResourceUrl(reference);

export interface AgentDocumentNodeRendererProps<Node extends AgentDocumentNode = AgentDocumentNode> {
  readonly node: Node;
  readonly path: string;
  /** Renders a child node through the registry; `result` nodes use it for their children. */
  readonly renderChild: (node: AgentDocumentNode, path: string) => React.ReactNode;
}

export type AgentDocumentNodeRenderer<Kind extends AgentDocumentNode['kind']> =
  (props: AgentDocumentNodeRendererProps<Extract<AgentDocumentNode, { readonly kind: Kind }>>) => React.ReactNode;

export type AgentDocumentNodeRenderers = Readonly<{ readonly [Kind in AgentDocumentNode['kind']]: AgentDocumentNodeRenderer<Kind> }>;

const ProgressBar = ({ completed, total }: Readonly<{ readonly completed: number; readonly total?: number }>): React.ReactNode =>
  total === undefined || total <= 0
    ? <progress className="agent-document-progress-bar" />
    : <progress className="agent-document-progress-bar" max={total} value={Math.min(completed, total)} />;

/**
 * The browser renderer registry: one rich component per semantic node kind.
 * Kinds lower to Markdown/text for MCP and CLI; here they get real DOM.
 */
export const agentDocumentNodeRenderers: AgentDocumentNodeRenderers = Object.freeze({
  audio: ({ node }) => <figure className="agent-document-audio">
    <audio controls src={`data:${node.mimeType};base64,${node.data}`} />
    <figcaption>{node.mimeType}</figcaption>
  </figure>,
  context: ({ node }) => <section className="agent-document-context">
    <h4>Additional context</h4>
    <p>{node.text}</p>
  </section>,
  error: ({ node }) => <p className="agent-document-error-node" role="alert"><strong>{node.code}</strong> · {node.message}</p>,
  image: ({ node }) => <figure className="agent-document-image">
    <img alt="Agent-rendered image" src={`data:${node.mimeType};base64,${node.data}`} />
    <figcaption>{node.mimeType}</figcaption>
  </figure>,
  json: ({ node }) => <pre className="agent-document-json"><code>{displayAgentDocumentValue(node.value)}</code></pre>,
  markdown: ({ node }) => <MarkdownProjector
    body={node.text}
    resolveImage={agentDocumentImageUrl}
    resolveLink={agentDocumentLinkUrl}
  />,
  progress: ({ node }) => <div className="agent-document-progress" role="status">
    <ProgressBar completed={node.completed} total={node.total} />
    <span>{agentDocumentProgressLabel(node)}</span>
  </div>,
  resource: ({ node }) => <dl className="agent-document-resource">
    <div><dt>Name</dt><dd>{node.name}</dd></div>
    <div><dt>URI</dt><dd><code>{node.uri}</code></dd></div>
    {node.mimeType === undefined ? undefined : <div><dt>MIME type</dt><dd>{node.mimeType}</dd></div>}
  </dl>,
  result: ({ node, path, renderChild }) => <section className="agent-document-result">
    {node.metadata === undefined
      ? undefined
      : <details className="agent-document-metadata"><summary>Result metadata</summary><pre><code>{displayAgentDocumentValue(node.metadata)}</code></pre></details>}
    <div className="agent-document-children">
      {node.children.map((child, index) => renderChild(child, `${path}-${String(index)}`))}
    </div>
  </section>,
  text: ({ node }) => <p className="agent-document-text">{node.text}</p>,
});

/**
 * The mapped registry type guarantees a renderer for every kind, so dispatch
 * is a keyed lookup; the cast only widens the per-kind renderer to the union.
 */
const renderNode = (node: AgentDocumentNode, path: string): React.ReactNode => {
  const renderer = agentDocumentNodeRenderers[node.kind] as AgentDocumentNodeRenderer<AgentDocumentNode['kind']>;
  return <React.Fragment key={path}>{renderer({ node, path, renderChild: renderNode })}</React.Fragment>;
};

/** Renders one semantic node (and its subtree) through the registry. */
export const AgentDocumentNodeView = ({ node, path }: Readonly<{ readonly node: AgentDocumentNode; readonly path: string }>): React.ReactNode =>
  renderNode(node, path);

/** The one-line label of a render event for timelines and the Raw AgentDocument tab. */
export const agentRenderEventLabel = (event: AgentRenderEvent): string => {
  switch (event.type) {
    case 'shell':
      return `Shell · #${String(event.sequence)}`;
    case 'progress':
      return `Progress · #${String(event.sequence)} · ${agentDocumentProgressLabel(event)}`;
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

export interface RenderedAgentDocumentProps {
  /** Shown when no event has produced a document yet (idle workspace, failed before the shell). */
  readonly emptyLabel?: string;
  readonly events: readonly AgentRenderEvent[];
  /** True while the backend is still running: the pane shows the stream's live state as pending rather than final. */
  readonly streaming?: boolean;
}

const statusLabel = (fold: AgentDocumentFold, streaming: boolean): string => {
  if (fold.document === undefined) return streaming ? 'Rendering…' : 'No document';
  const status = fold.finalStatus ?? fold.document.status;
  return fold.complete ? status : streaming ? `rendering · ${status}` : `incomplete stream · ${status}`;
};

/** The default result pane: the folded stream rendered as the agent sees it. */
export const RenderedAgentDocument = ({ emptyLabel, events, streaming = false }: RenderedAgentDocumentProps): React.ReactNode => {
  const fold = foldAgentDocumentEvents(events);
  const pending = streaming || (events.length > 0 && !fold.complete);
  return <section
    aria-busy={pending}
    aria-label="Rendered Agent Document"
    className={`rendered-document${pending ? ' rendered-document--pending' : ''}`}
    data-testid="rendered-document"
  >
    <header className="rendered-document-status">
      <span className={`rendered-document-badge rendered-document-badge--${fold.finalStatus ?? fold.document?.status ?? (pending ? 'pending' : 'empty')}`}>
        {statusLabel(fold, streaming)}
      </span>
      {fold.document === undefined ? undefined : <span className="rendered-document-version">Version {String(fold.document.version)}</span>}
      {fold.progress === undefined || fold.complete
        ? undefined
        : <span className="rendered-document-live-progress" role="status">
          <ProgressBar completed={fold.progress.completed} total={fold.progress.total} />
          {agentDocumentProgressLabel(fold.progress)}
        </span>}
    </header>
    {fold.errors.length === 0 ? undefined : <section aria-label="Render diagnostics" className="rendered-document-diagnostics">
      <h3>Render diagnostics</h3>
      <ul>{fold.errors.map((event) => <li key={`${String(event.sequence)}-${event.error.code}`}>
        <strong>{event.error.code}</strong> · {event.error.message}
        {event.boundaryId === undefined ? undefined : <> · boundary {event.boundaryId}</>}
        {event.error.data === undefined ? undefined : <pre><code>{displayAgentDocumentValue(event.error.data)}</code></pre>}
      </li>)}</ul>
    </section>}
    {fold.document === undefined
      ? <p className="rendered-document-empty" role="status">
        {pending ? 'Waiting for the first render event…' : emptyLabel ?? 'Run the route to see the Agent Document it renders.'}
      </p>
      : <div className="rendered-document-body">
        <AgentDocumentNodeView node={fold.document.root} path="root" />
        {fold.document.value === undefined ? undefined : <details className="rendered-document-value">
          <summary>Document value</summary>
          <pre><code>{displayAgentDocumentValue(fold.document.value)}</code></pre>
        </details>}
      </div>}
  </section>;
};
