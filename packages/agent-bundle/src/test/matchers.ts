import type { AgentDocument, AgentDocumentNode, AgentDocumentStatus } from '@agent-bundle/runtime';

import { stableJson } from '../core/digest.ts';
import { AgentTestError, captured } from './errors.ts';
import type { RenderedRoute } from './render.ts';
import type { RenderedRouteProvenance } from './types.ts';

export type AgentDocumentNodeKind = AgentDocumentNode['kind'];

export type DocumentSubject = AgentDocument | RenderedRoute;

const documentOf = (subject: DocumentSubject): AgentDocument =>
  'document' in subject ? subject.document : subject;

const provenanceOf = (subject: DocumentSubject): RenderedRouteProvenance | undefined =>
  'provenance' in subject ? subject.provenance : undefined;

/** Every node in document order, so assertions read the document the way the renderer produced it. */
const nodes = (node: AgentDocumentNode): readonly AgentDocumentNode[] =>
  node.kind === 'result' ? [node, ...node.children.flatMap((child) => nodes(child))] : [node];

const textOf = (
  document: AgentDocument,
  kind: 'context' | 'markdown' | 'text',
): readonly string[] =>
  nodes(document.root).flatMap((node) => (node.kind === kind ? [node.text] : []));

/**
 * Fluent assertions over one final Agent Document. Every failure names the
 * route, its module, and the proof level that produced the document; passing
 * the whole `renderRoute` result (rather than just `.document`) is what makes
 * that provenance available.
 */
export interface DocumentAssertions {
  /** Asserts a context node contains `text` — the additional context an event route returns to its host. */
  readonly toContainContext: (text: string) => DocumentAssertions;
  /** Asserts a Markdown node contains `text`. */
  readonly toContainMarkdown: (text: string) => DocumentAssertions;
  /** Asserts a text node contains `text`. */
  readonly toContainText: (text: string) => DocumentAssertions;
  /** Asserts the document represents an error node, optionally with `code`. */
  readonly toHaveError: (code?: string) => DocumentAssertions;
  /** Asserts the document's node kinds in document order. */
  readonly toHaveNodeKinds: (kinds: readonly AgentDocumentNodeKind[]) => DocumentAssertions;
  readonly toHaveStatus: (status: AgentDocumentStatus) => DocumentAssertions;
  /**
   * Asserts the document's structured value equals `value` (JSON structural
   * equality). `undefined` asserts the document emitted no value at all, which
   * `null` does not satisfy.
   */
  readonly toHaveValue: (value: unknown) => DocumentAssertions;
}

export const expectDocument = (subject: DocumentSubject): DocumentAssertions => {
  const document = documentOf(subject);
  const provenance = provenanceOf(subject);
  const fail = (message: string, details: readonly string[]): never => {
    throw new AgentTestError('assertion-failed', message, {
      details,
      ...(provenance === undefined ? {} : { provenance }),
    });
  };
  const assertions: DocumentAssertions = {
    toContainContext(text) {
      const found = textOf(document, 'context');
      if (!found.some((value) => value.includes(text))) {
        fail('The Agent Document contains no context node with the expected text.', [
          `expected:     context containing ${JSON.stringify(text)}`,
          `received:     ${found.length === 0 ? 'no context nodes' : captured(found)}`,
        ]);
      }
      return assertions;
    },
    toContainMarkdown(text) {
      const found = textOf(document, 'markdown');
      if (!found.some((value) => value.includes(text))) {
        fail('The Agent Document contains no Markdown node with the expected text.', [
          `expected:     Markdown containing ${JSON.stringify(text)}`,
          `received:     ${found.length === 0 ? 'no Markdown nodes' : captured(found)}`,
        ]);
      }
      return assertions;
    },
    toContainText(text) {
      const found = textOf(document, 'text');
      if (!found.some((value) => value.includes(text))) {
        fail('The Agent Document contains no text node with the expected text.', [
          `expected:     text containing ${JSON.stringify(text)}`,
          `received:     ${found.length === 0 ? 'no text nodes' : captured(found)}`,
        ]);
      }
      return assertions;
    },
    toHaveError(code) {
      const errors = nodes(document.root).flatMap((node) => (node.kind === 'error' ? [node] : []));
      const matched = code === undefined ? errors : errors.filter((node) => node.code === code);
      if (matched.length === 0) {
        fail('The Agent Document represents no matching error.', [
          `expected:     ${code === undefined ? 'an error node' : `an error node with code ${JSON.stringify(code)}`}`,
          `received:     status ${document.status}, ${errors.length === 0 ? 'no error nodes' : captured(errors)}`,
        ]);
      }
      return assertions;
    },
    toHaveNodeKinds(kinds) {
      const received = nodes(document.root).map((node) => node.kind);
      if (stableJson(received) !== stableJson([...kinds])) {
        fail('The Agent Document node kinds differ from the expected sequence.', [
          `expected:     ${captured(kinds)}`,
          `received:     ${captured(received)}`,
        ]);
      }
      return assertions;
    },
    toHaveStatus(status) {
      if (document.status !== status) {
        fail('The Agent Document has an unexpected status.', [
          `expected:     status ${status}`,
          `received:     status ${document.status}`,
          ...(document.status === 'represented-error'
            ? [`error nodes:  ${captured(nodes(document.root).filter((node) => node.kind === 'error'))}`]
            : []),
        ]);
      }
      return assertions;
    },
    toHaveValue(value) {
      // `AgentDocument.value` is optional, so an absent value and an emitted
      // `null` are distinct states. Collapsing them would pass a route that
      // emitted no structured value at all.
      const absent = document.value === undefined;
      const expectAbsent = value === undefined;
      if (absent !== expectAbsent || (!absent && stableJson(document.value) !== stableJson(value))) {
        fail('The Agent Document value differs from the expected structured value.', [
          `expected:     ${expectAbsent ? 'no document value' : captured(value)}`,
          `received:     ${absent ? 'no document value' : captured(document.value)}`,
        ]);
      }
      return assertions;
    },
  };
  return assertions;
};
