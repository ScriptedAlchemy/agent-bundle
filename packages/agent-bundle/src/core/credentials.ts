/**
 * Single source of truth for credential classification (audit §1.4).
 *
 * Two distinct contracts live here — keep them separate:
 * - Key-name classifiers (`isCredentialKey`, `isProviderEndpointKey`) decide
 *   whether an environment-variable or record-key *name* is credential-shaped.
 * - Free-text helpers (`containsProviderCredential`, `redactCredentialText`)
 *   detect or irreversibly remove credential *values* in arbitrary text.
 */

const credentialKeywords = Object.freeze([
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
]);

// The segment heuristic in isCredentialKey subsumes these today (every match
// contains a `token` segment or an apikey/apitoken/accesstoken suffix), but
// they stay explicit so the union survives future keyword-list edits.
const providerKeyPatterns = Object.freeze([
  /(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$/iu,
  /^(?:ANTHROPIC|AZURE_OPENAI|CODEX|COHERE|DEEPSEEK|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|MISTRAL|OPENAI|PERPLEXITY|TOGETHER|XAI)_(?:API_KEY|TOKEN)$/iu,
]);

/**
 * Union key-name classifier: keyword segments (authorization, credential,
 * password, secret, token), compact apikey/apitoken/authtoken/accesstoken
 * suffixes, and the provider environment-variable patterns. Every redaction
 * surface (eval records, playground traces, native smoke child environments,
 * workbench logs) shares this one definition.
 */
export const isCredentialKey = (key: string): boolean => {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  const compact = segments.join('');
  return segments.some((segment) => credentialKeywords.includes(segment))
    || /(?:apikey|apitoken|authtoken|accesstoken)$/u.test(compact)
    || providerKeyPatterns.some((pattern) => pattern.test(key));
};

/**
 * Provider endpoint-routing variables. Not credential material, but host
 * smokes strip them alongside credentials so a child CLI cannot be redirected
 * to an environment-configured provider endpoint.
 */
export const isProviderEndpointKey = (key: string): boolean =>
  /^(?:CODEX|OPENAI)_(?:API_BASE|BASE_URL|URL)$/iu.test(key);

/**
 * Pattern sources of the free-text secret pass. The notice ledger in
 * `@agent-bundle/runtime` (`notices/redaction.ts`, `NOTICE_SECRET_PATTERN_SOURCES`)
 * carries the same three sources: the runtime is an optional peer of this
 * package, so neither side can import the other's module, and
 * `notice-redaction-parity.test.ts` pins them byte-identical instead. Edit
 * both together.
 */
export const CREDENTIAL_TEXT_PATTERN_SOURCES = Object.freeze({
  assignment: String.raw`((?:["']?)(?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|authorization|credential|password|secret|token)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)`,
  provider: Object.freeze([
    String.raw`\bsk-(?:proj-|ant-|live-)?[a-z0-9_-]{16,}\b`,
    String.raw`\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|akia[a-z0-9]{16})\b`,
    String.raw`\bbearer[ \t]+[a-z0-9._~+/=-]{20,}\b`,
  ]),
  /**
   * URL userinfo (`scheme://user:secret@host`): the authority runs until one
   * of the terminators every WHATWG scheme shares (`/`, `?`, `#`) and the
   * match is greedy through the final `@`, so a raw `@`, quote, backslash, or
   * whitespace inside a password cannot leave part of it behind. The scheme is
   * anchored to the start of its own character run, so a URL glued to an
   * identifier (`_https://user:secret@…`) is masked too.
   */
  urlUserinfo: String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@`,
});

const providerCredentialPatterns = Object.freeze(
  CREDENTIAL_TEXT_PATTERN_SOURCES.provider.map((source) => new RegExp(source, 'iu')),
);

// `String.prototype.replace` resets `lastIndex` on global regexes, so sharing these is safe.
const globalProviderCredentialPatterns = Object.freeze(
  providerCredentialPatterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`)),
);

/** True when free text contains recognizable provider credential material. */
export const containsProviderCredential = (value: string): boolean =>
  providerCredentialPatterns.some((pattern) => pattern.test(value));

const credentialAssignmentPattern = new RegExp(CREDENTIAL_TEXT_PATTERN_SOURCES.assignment, 'giu');

/** Masks `scheme://user:secret@host` credentials; shared by the probe and Workbench log surfaces. */
export const urlUserinfoPattern = new RegExp(CREDENTIAL_TEXT_PATTERN_SOURCES.urlUserinfo, 'giu');

/**
 * Raw process output remains useful evidence after known credential material
 * is irreversibly removed. Provider forms go first: an unquoted
 * `authorization: Bearer <token>` would otherwise lose only the word `Bearer`
 * to the assignment pass and keep the token.
 */
export const redactCredentialText = (value: string): string => {
  let redacted = value;
  for (const pattern of globalProviderCredentialPatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted.replace(credentialAssignmentPattern, (_match, prefix: string, assigned: string) => {
    const quote = assigned[0] === '"' || assigned[0] === "'" ? assigned[0] : '';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
};
