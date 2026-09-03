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
 *   the secret-pattern pass below, so a credential pasted into a coordination
 *   message never crosses into another actor's context.
 * - `secret`: delivered as authored, but only over a route whose host
 *   capability row admits `secret`; otherwise it never leaves the durable
 *   store (see `resolveNoticeDisclosure` in `router.ts`).
 *
 * The secret patterns mirror the compiler's credential redaction
 * (`packages/agent-bundle/src/core/credentials.ts`, reused by the Workbench
 * probe redaction). The two packages cannot share a module — the runtime is an
 * optional peer of the compiler — so `notice-redaction-parity.test.ts` pins
 * the pattern sources equal on both sides.
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
 * Pattern sources of the secret pass, exported so the compiler-side copy can
 * be pinned identical by test. `assignment` masks `key: value` / `key=value`
 * credential assignments; `provider` masks recognizable provider tokens;
 * `urlUserinfo` masks `scheme://user:secret@host` credentials.
 */
export const NOTICE_SECRET_PATTERN_SOURCES = Object.freeze({
  assignment: String.raw`((?:["']?)(?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|authorization|credential|password|secret|token)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)`,
  provider: Object.freeze([
    String.raw`\bsk-(?:proj-|ant-|live-)?[a-z0-9_-]{16,}\b`,
    String.raw`\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|akia[a-z0-9]{16})\b`,
    String.raw`\bbearer[ \t]+[a-z0-9._~+/=-]{20,}\b`,
  ]),
  urlUserinfo: String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@`,
});

// `String.prototype.replace` resets `lastIndex` on global regexes, so sharing these is safe.
const assignmentPattern = new RegExp(NOTICE_SECRET_PATTERN_SOURCES.assignment, 'giu');
const providerPatterns = NOTICE_SECRET_PATTERN_SOURCES.provider.map((source) => new RegExp(source, 'giu'));
const urlUserinfoPattern = new RegExp(NOTICE_SECRET_PATTERN_SOURCES.urlUserinfo, 'giu');

/**
 * Irreversibly removes recognizable credential material from free text.
 * Provider forms go first: an unquoted `authorization: Bearer <token>` would
 * otherwise lose only the word `Bearer` to the assignment pass and keep the
 * token.
 */
export const redactSecretText = (value: string): string => {
  let redacted = value;
  for (const pattern of providerPatterns) {
    redacted = redacted.replace(pattern, NOTICE_REDACTION_MARK);
  }
  redacted = redacted.replace(assignmentPattern, (_match, prefix: string, assigned: string) => {
    const quote = assigned[0] === '"' || assigned[0] === "'" ? assigned[0] : '';
    return `${prefix}${quote}${NOTICE_REDACTION_MARK}${quote}`;
  });
  return redacted.replace(urlUserinfoPattern, `$1${NOTICE_REDACTION_MARK}@`);
};

/** True when the secret pass would change `value`. */
export const containsSecretText = (value: string): boolean => redactSecretText(value) !== value;

/**
 * Key-name classifier for structured content, mirroring the compiler's
 * `isCredentialKey` (`packages/agent-bundle/src/core/credentials.ts`, pinned
 * equal by `notice-redaction-parity.test.ts`): keyword segments, compact
 * apikey/apitoken/authtoken/accesstoken suffixes, and provider
 * environment-variable names. A JSON value under such a key is a credential
 * by position — `{ password: "hunter2" }` never shows the assignment pass a
 * `password:` prefix — so every string beneath it is masked whole.
 */
export const NOTICE_SECRET_KEY_SOURCES = Object.freeze({
  compactSuffix: String.raw`(?:apikey|apitoken|authtoken|accesstoken)$`,
  keywords: Object.freeze(['authorization', 'credential', 'credentials', 'password', 'secret', 'token']),
  provider: Object.freeze([
    String.raw`(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$`,
    String.raw`^(?:ANTHROPIC|AZURE_OPENAI|CODEX|COHERE|DEEPSEEK|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|MISTRAL|OPENAI|PERPLEXITY|TOGETHER|XAI)_(?:API_KEY|TOKEN)$`,
  ]),
});

const compactSuffixPattern = new RegExp(NOTICE_SECRET_KEY_SOURCES.compactSuffix, 'u');
const providerKeyPatterns = NOTICE_SECRET_KEY_SOURCES.provider.map((source) => new RegExp(source, 'iu'));

/** True when a record key or environment-variable name is credential-shaped. */
export const isSecretKey = (key: string): boolean => {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  const compact = segments.join('');
  return segments.some((segment) => NOTICE_SECRET_KEY_SOURCES.keywords.includes(segment))
    || compactSuffixPattern.test(compact)
    || providerKeyPatterns.some((pattern) => pattern.test(key));
};

const redactJson = (value: JsonValue, underSecretKey = false): JsonValue => {
  if (typeof value === 'string') return underSecretKey ? NOTICE_REDACTION_MARK : redactSecretText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => redactJson(entry as JsonValue, underSecretKey)));
  // Member names are prose too: a token used as a key (`{ "sk-…": true }`)
  // is masked like any other string. Two names that mask to the same text
  // collapse onto one member; the mark carries no information to lose.
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Readonly<Record<string, JsonValue>>)
      .map(([key, entry]) => [
        underSecretKey ? NOTICE_REDACTION_MARK : redactSecretText(key),
        redactJson(entry, underSecretKey || isSecretKey(key)),
      ]),
  ));
};

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
 * Applies the secret pass to every free-text field of a detached snapshot.
 * Structure, node count, status, and codes are unchanged, so the result still
 * satisfies the Agent Document bounds the original passed; a string only ever
 * shrinks or is replaced by the fixed mark.
 */
export const redactNoticeDocument = (snapshot: AgentDocumentSnapshot): AgentDocumentSnapshot => Object.freeze({
  ...snapshot,
  root: redactNode(snapshot.root),
  ...(snapshot.value === undefined ? {} : { value: redactJson(snapshot.value) }),
});

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
