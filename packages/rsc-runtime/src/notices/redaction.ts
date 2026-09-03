import { RedactionLimitError, compilePolicy } from 'flare-redact';

import { DEFAULT_AGENT_RENDER_LIMITS } from '../agent-document.js';
import type { AgentDocumentNode, AgentDocumentSnapshot } from '../agent-document.js';
import type { JsonValue } from '../lower-mcp.js';

/**
 * Notice content redaction (#99 acceptance item 7).
 *
 * A notice's free text lives only in its detached `AgentDocumentSnapshot`
 * (`text`, `markdown`, `context`, `progress.message`, `error.message`,
 * `resource.name`/`uri`, and every string inside `json.value`,
 * `result.metadata`, and the document `value`). Recipient, priority, dedupe
 * key, timestamps, and receipts are identity and evidence, never prose, and
 * must not carry secrets; hosts receive them unredacted.
 *
 * Authors classify each notice with a {@link AgentNoticeSensitivity}:
 *
 * - `public`: safe for any surface; delivered as authored.
 * - `internal` (default): for the recipient's own context; delivered after
 *   the secret pass below, so a credential pasted into a coordination
 *   message never crosses into another actor's context.
 * - `secret`: delivered as authored, but only over a route whose host
 *   capability row admits `secret`; otherwise it never leaves the durable
 *   store (see `resolveNoticeDisclosure` in `router.ts`).
 *
 * The secret pass is not ours. Which fields are prose, which class each route
 * may carry, and what a refusal records are this module's policy; recognizing
 * a credential is `flare-redact`'s job (pinned exact in `package.json`, a
 * runtime dependency of this package, zero dependencies of its own, plain
 * regular expressions with no Node-only globals). Its default detector set
 * covers provider tokens (OpenAI, Anthropic, AWS, GitHub, GitLab, Slack,
 * Stripe, Google, npm, …), JWTs, PEM private keys, `Bearer` / `Basic`
 * headers, `user:password@` URL credentials, `key=value` / `key: value`
 * credential assignments in any language, e-mail addresses (a recipient's
 * identity is never surfaced through another actor's notice), card numbers,
 * and IBANs; a structured value stored directly under a credential-shaped
 * member name (`password`, `token`, `apiKey`, `authorization`, …) is masked
 * whole regardless of content. Paths are not redacted: coordination notices
 * legitimately name files. Detector limits at the pinned version are part of
 * the contract (README, "Redaction"): an assignment value shorter than four
 * characters and an OpenAI key longer than 64 characters are not findings.
 * The compiler keeps its own, older credential pass
 * for probe and log text (`packages/agent-bundle/src/core/credentials.ts`);
 * the two are not held in parity.
 */
export const AGENT_NOTICE_SENSITIVITIES = Object.freeze(['public', 'internal', 'secret'] as const);

export type AgentNoticeSensitivity = (typeof AGENT_NOTICE_SENSITIVITIES)[number];

/** A notice published without `sensitivity` is `internal`. */
export const AGENT_NOTICE_DEFAULT_SENSITIVITY: AgentNoticeSensitivity = 'internal';

const sensitivityRank = Object.freeze({ internal: 1, public: 0, secret: 2 } as const satisfies Record<AgentNoticeSensitivity, number>);

/** Negative when `left` is less sensitive than `right`, zero when equal. */
export const compareNoticeSensitivity = (
  left: AgentNoticeSensitivity,
  right: AgentNoticeSensitivity,
): number => sensitivityRank[left] - sensitivityRank[right];

export const isNoticeSensitivity = (value: unknown): value is AgentNoticeSensitivity =>
  typeof value === 'string' && (AGENT_NOTICE_SENSITIVITIES as readonly string[]).includes(value);

/** The replacement every redaction surface in the repository uses. */
export const NOTICE_REDACTION_MARK = '[REDACTED]';

/**
 * The one redaction policy of the notice ledger: `flare-redact`'s default
 * detectors and default credential-shaped member names, every finding
 * replaced whole by {@link NOTICE_REDACTION_MARK}. The library's own masks
 * keep a recognizable prefix (`AKIA***`, `b***@***`) as a debugging hint; a
 * notice crossing into another actor's context keeps nothing.
 */
const secretPass = compilePolicy({ mask: NOTICE_REDACTION_MARK });

/**
 * The library refuses a string it cannot bound (more than 50,000 findings, or
 * longer than 16 MiB) with `RedactionLimitError`. On egress that refusal
 * fails closed: the value is replaced by the mark whole rather than letting
 * one pathological notice fail the inbox for every reader.
 */
const failClosed = <T>(run: () => T, fallback: T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof RedactionLimitError) return fallback;
    throw error;
  }
};

/** Irreversibly removes recognizable credential material from free text. */
export const redactSecretText = (value: string): string => failClosed(() => secretPass.redact(value), NOTICE_REDACTION_MARK);

/** True when the secret pass would change `value`. */
export const containsSecretText = (value: string): boolean => failClosed(() => !secretPass.isClean(value), true);

const freezeRedactedJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeRedactedJson(entry as JsonValue)));
  // Member names are prose too: a token used as a key (`{ "sk-…": true }`)
  // is masked like any other string. Two names that mask to the same text
  // collapse onto one member; the mark carries no information to lose.
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Readonly<Record<string, JsonValue>>)
      .map(([key, entry]) => [redactSecretText(key), freezeRedactedJson(entry)]),
  ));
};

/**
 * Structured content: the library walks the value, masking a string held
 * directly under a credential-shaped member name whole and scanning every
 * other string; the result is then deep-frozen with its member names passed
 * through the same scan.
 */
const redactJson = (value: JsonValue): JsonValue =>
  freezeRedactedJson(failClosed<JsonValue>(() => secretPass.redact(value), NOTICE_REDACTION_MARK));

const redactNode = (node: AgentDocumentNode): AgentDocumentNode => {
  switch (node.kind) {
    case 'result':
      return Object.freeze({
        ...node,
        children: Object.freeze(node.children.map(redactNode)),
        ...(node.metadata === undefined ? {} : { metadata: redactJson(node.metadata) }),
      });
    case 'markdown':
    case 'text':
    case 'context':
      return Object.freeze({ ...node, text: redactSecretText(node.text) });
    case 'json':
      return Object.freeze({ ...node, value: redactJson(node.value) });
    case 'progress':
      return node.message === undefined
        ? node
        : Object.freeze({ ...node, message: redactSecretText(node.message) });
    case 'image':
    case 'audio':
      // Binary payloads carry no prose; their MIME type is a vocabulary value.
      return node;
    case 'resource':
      return Object.freeze({
        ...node,
        name: redactSecretText(node.name),
        uri: redactSecretText(node.uri),
      });
    case 'error':
      // Codes are vocabulary; the message is prose.
      return Object.freeze({ ...node, message: redactSecretText(node.message) });
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

/**
 * The document a route hands out in place of content it may not disclose:
 * one text node carrying the mark, with the original status and version.
 */
export const noticeRedactionPlaceholder = (snapshot: AgentDocumentSnapshot): AgentDocumentSnapshot => Object.freeze({
  root: Object.freeze({ kind: 'text' as const, text: NOTICE_REDACTION_MARK }),
  status: snapshot.status,
  version: snapshot.version,
});

const documentBytes = (document: AgentDocumentSnapshot): number =>
  new TextEncoder().encode(JSON.stringify(document)).byteLength;

/**
 * Applies the secret pass to every free-text field of a detached snapshot.
 * Structure, depth, node count, status, and codes are unchanged, so those
 * bounds still hold; bytes need not — the mark is longer than the shortest
 * values it replaces (`pass=abcd`, `a@b.co`), so a document authored at the
 * byte bound can grow past it. A redacted document that no longer fits the
 * bound the original passed is replaced by the placeholder rather than handed
 * out oversized: the bound is a promise to hosts, made at publish and kept on
 * egress.
 */
export const redactNoticeDocument = (snapshot: AgentDocumentSnapshot): AgentDocumentSnapshot => {
  const redacted: AgentDocumentSnapshot = Object.freeze({
    ...snapshot,
    root: redactNode(snapshot.root),
    ...(snapshot.value === undefined ? {} : { value: redactJson(snapshot.value) }),
  });
  return documentBytes(redacted) > DEFAULT_AGENT_RENDER_LIMITS.maxDocumentBytes
    ? noticeRedactionPlaceholder(snapshot)
    : redacted;
};

const firstProse = (node: AgentDocumentNode): string | undefined => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) {
        const found = firstProse(child);
        if (found !== undefined) return found;
      }
      return undefined;
    case 'markdown':
    case 'text':
    case 'context':
      return node.text;
    case 'progress':
      return node.message;
    case 'error':
      return node.message;
    case 'resource':
      return node.name;
    case 'json':
    case 'image':
    case 'audio':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

/** Upper bound on a title-only projection, in UTF-16 code units. */
export const NOTICE_TITLE_MAX_LENGTH = 120;

/**
 * The single-line title a title-only route (host toast) may carry: the first
 * non-empty line of the first prose node, bounded to
 * {@link NOTICE_TITLE_MAX_LENGTH}. A document without prose has no title and
 * yields an empty string, which title-only routes treat as nothing to show.
 */
export const noticeTitle = (snapshot: AgentDocumentSnapshot): string => {
  const prose = firstProse(snapshot.root) ?? '';
  const line = prose.split(/\r?\n/u).map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  return line.length <= NOTICE_TITLE_MAX_LENGTH ? line : `${line.slice(0, NOTICE_TITLE_MAX_LENGTH - 1)}…`;
};

/**
 * What a delivery route may carry of a notice's content: the whole document
 * (`body`), a bounded single-line `title`, or only the fact that the inbox
 * changed (`signal`, for `resources/updated`, which names the inbox URI and
 * nothing else).
 */
export type AgentNoticeDisclosureShape = 'body' | 'signal' | 'title';

/**
 * A route's disclosure decision for one notice. `disclosed.redacted` says
 * whether the secret pass ran over the content handed out; `withheld` means
 * nothing about the notice leaves the store through that route.
 */
export type AgentNoticeDisclosure =
  | { readonly kind: 'disclosed'; readonly redacted: boolean; readonly shape: AgentNoticeDisclosureShape }
  | { readonly kind: 'withheld'; readonly reason: 'route-unavailable' | 'sensitivity-exceeds-route' };

/**
 * The content a disclosed route hands out for a notice: the full document or
 * a one-line title document, secret-passed when the decision says so. A
 * `signal` route carries no content and gets `undefined`.
 */
export const disclosedNoticeContent = (
  content: AgentDocumentSnapshot,
  disclosure: Extract<AgentNoticeDisclosure, { readonly kind: 'disclosed' }>,
): AgentDocumentSnapshot | undefined => {
  switch (disclosure.shape) {
    case 'body':
      return disclosure.redacted ? redactNoticeDocument(content) : content;
    case 'title': {
      const title = noticeTitle(disclosure.redacted ? redactNoticeDocument(content) : content);
      return Object.freeze({
        root: Object.freeze({ kind: 'text' as const, text: title }),
        status: content.status,
        version: content.version,
      });
    }
    case 'signal':
      return undefined;
    default: {
      const exhaustive: never = disclosure.shape;
      return exhaustive;
    }
  }
};
