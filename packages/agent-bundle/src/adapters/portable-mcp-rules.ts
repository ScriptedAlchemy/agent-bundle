import { posix, win32 } from 'node:path';

/**
 * Agent Plugins 1.0.0 normative MCP rules that the pinned `mcp.schema.json`
 * cannot express (§7.2.1 command, cwd, URL and header forms; §9.2 placeholder
 * scope). Pure value checks shared by portable planning (so `build` and
 * `validate` fail closed before publication) and by the bytes-at-rest lane in
 * `host-contracts/portable-plugin-validation.ts`. Filesystem-backed checks
 * (bundled command files, symlinks) stay in the byte lane.
 */

export interface PortableMcpRuleIssue {
  /** JSON-pointer-like location under the server entry, e.g. `command`, `headers/Authorization`. */
  readonly field: string;
  readonly message: string;
}

export const portablePlaceholderPattern = /\$\{PLUGIN_(?:ROOT|DATA)\}/u;

const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// RFC 9110 §5.5 field values: VCHAR, SP, HTAB and obs-text only. Mirrors Node's
// `validateHeaderValue`, which rejects every other control or non-byte character.
const forbiddenHeaderValuePattern = /[^\t\u0020-\u007E\u0080-\u00FF]/u;
const loopbackIpv4Pattern = /^127(?:\.\d{1,3}){3}$/u;

const issue = (field: string, message: string): PortableMcpRuleIssue => Object.freeze({ field, message });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  hostname === '::1' ||
  loopbackIpv4Pattern.test(hostname);

/**
 * Platform-independent §4.1 containment. The emitted value is interpreted by
 * the consuming host, not the build host, so backslashes and NULs are refused
 * outright (a POSIX build would otherwise accept `./safe\..\..\outside` that
 * Windows resolves outside the root) and the remainder is normalized with
 * POSIX semantics only.
 */
const hasForbiddenPathBytes = (value: string): boolean => value.includes('\\') || value.includes('\0');

/**
 * Lexically normalized plugin-relative path, or `undefined` when the value
 * climbs above its root or is not relative. Checks the normalized path itself
 * for a leading `..` rather than resolving against a fixed synthetic root:
 * `./../anchor/server` must escape regardless of what the root is named.
 */
export const containedPortableRelativePath = (relativePath: string): string | undefined => {
  if (hasForbiddenPathBytes(relativePath) || posix.isAbsolute(relativePath)) return undefined;
  const normalized = posix.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
};

const staysInsidePosixRoot = (relativePath: string): boolean => containedPortableRelativePath(relativePath) !== undefined;

const isAnyPlatformAbsolute = (value: string): boolean => posix.isAbsolute(value) || win32.isAbsolute(value);

/** §7.2.1: a stdio command is a bare executable name or a plugin-relative `./` path. */
export const portableCommandIssues = (command: unknown): readonly PortableMcpRuleIssue[] => {
  if (typeof command !== 'string') return Object.freeze([]);
  if (portablePlaceholderPattern.test(command)) {
    return Object.freeze([issue(
      'command',
      'contains an Agent Plugins placeholder, but clients never expand placeholders in command (Agent Plugins 1.0.0 §7.2.1)',
    )]);
  }
  if (command.startsWith('./')) {
    if (hasForbiddenPathBytes(command) || !staysInsidePosixRoot(command)) {
      return Object.freeze([issue('command', `${JSON.stringify(command)} escapes the plugin root (Agent Plugins 1.0.0 §4.1)`)]);
    }
    return Object.freeze([]);
  }
  if (command.length === 0 || /[\s/\\\0]/u.test(command) || isAnyPlatformAbsolute(command) || command.startsWith('.')) {
    return Object.freeze([issue(
      'command',
      `${JSON.stringify(command)} is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1)`,
    )]);
  }
  return Object.freeze([]);
};

/** §7.2.1: cwd stays inside the plugin root or plugin data directory after resolution. */
export const portableCwdIssues = (cwd: unknown): readonly PortableMcpRuleIssue[] => {
  if (typeof cwd !== 'string') return Object.freeze([]);
  const relativePart = cwd.startsWith('./')
    ? cwd
    : cwd.startsWith('${PLUGIN_ROOT}')
      ? `.${cwd.slice('${PLUGIN_ROOT}'.length)}`
      : cwd.startsWith('${PLUGIN_DATA}')
        ? `.${cwd.slice('${PLUGIN_DATA}'.length)}`
        : undefined;
  if (relativePart === undefined) return Object.freeze([]);
  if (hasForbiddenPathBytes(relativePart)) {
    return Object.freeze([issue(
      'cwd',
      `${JSON.stringify(cwd)} must use forward-slash separators without backslashes or NUL so every consuming platform resolves it identically (Agent Plugins 1.0.0 §4.1)`,
    )]);
  }
  if (staysInsidePosixRoot(relativePart)) return Object.freeze([]);
  const scope = cwd.startsWith('${PLUGIN_DATA}') ? 'plugin data directory' : 'plugin root';
  return Object.freeze([issue('cwd', `${JSON.stringify(cwd)} escapes its ${scope} after resolution (Agent Plugins 1.0.0 §7.2.1)`)]);
};

/** §9.2: placeholders never expand in env keys. */
export const portableEnvKeyIssues = (env: unknown): readonly PortableMcpRuleIssue[] => {
  if (!isRecord(env)) return Object.freeze([]);
  return Object.freeze(Object.keys(env)
    .filter((key) => portablePlaceholderPattern.test(key))
    .map((key) => issue(
      'env',
      `key ${JSON.stringify(key)} contains an Agent Plugins placeholder, but expansion never applies to env keys (Agent Plugins 1.0.0 §9.2)`,
    )));
};

/** §7.2.1: remote URLs are absolute http(s), no userinfo or fragment, HTTPS off loopback, no placeholders. */
export const portableRemoteUrlIssues = (url: unknown): readonly PortableMcpRuleIssue[] => {
  if (typeof url !== 'string') return Object.freeze([]);
  if (portablePlaceholderPattern.test(url)) {
    return Object.freeze([issue(
      'url',
      'contains an Agent Plugins placeholder, but clients never expand placeholders in url (Agent Plugins 1.0.0 §7.2.1)',
    )]);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Object.freeze([issue('url', 'must be an absolute HTTP or HTTPS URL (Agent Plugins 1.0.0 §7.2.1)')]);
  }
  const issues: PortableMcpRuleIssue[] = [];
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push(issue('url', 'must use the http or https scheme (Agent Plugins 1.0.0 §7.2.1)'));
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    issues.push(issue('url', 'must not contain user information (Agent Plugins 1.0.0 §7.2.1)'));
  }
  if (url.includes('#')) {
    issues.push(issue('url', 'must not contain a fragment (Agent Plugins 1.0.0 §7.2.1)'));
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    issues.push(issue(
      'url',
      `uses plain HTTP against non-loopback host ${JSON.stringify(parsed.hostname)}; non-loopback endpoints must use HTTPS (Agent Plugins 1.0.0 §7.2.1)`,
    ));
  }
  return Object.freeze(issues);
};

/** §7.2.1: header names are RFC 9110 tokens, values carry no control bytes, names are case-insensitive, no placeholders. */
export const portableHeaderIssues = (headers: unknown): readonly PortableMcpRuleIssue[] => {
  if (!isRecord(headers)) return Object.freeze([]);
  const issues: PortableMcpRuleIssue[] = [];
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const field = `headers/${name}`;
    if (!headerNamePattern.test(name)) {
      issues.push(issue(field, 'is not a valid HTTP header field name (Agent Plugins 1.0.0 §7.2.1)'));
    }
    if (typeof value === 'string' && forbiddenHeaderValuePattern.test(value)) {
      issues.push(issue(field, 'is not a valid HTTP header field value: only visible ASCII, space, horizontal tab and obs-text bytes are allowed (Agent Plugins 1.0.0 §7.2.1)'));
    }
    if (portablePlaceholderPattern.test(name) || (typeof value === 'string' && portablePlaceholderPattern.test(value))) {
      issues.push(issue(field, 'contains an Agent Plugins placeholder, but clients never expand placeholders in headers (Agent Plugins 1.0.0 §7.2.1)'));
    }
    const folded = name.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined) {
      issues.push(issue(
        field,
        `repeats header ${JSON.stringify(previous)} under different casing; header names are case-insensitive (Agent Plugins 1.0.0 §7.2.1)`,
      ));
    } else {
      seen.set(folded, name);
    }
  }
  return Object.freeze(issues);
};
