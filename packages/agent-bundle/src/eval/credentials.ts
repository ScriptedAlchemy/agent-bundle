import { isRecord } from '../core/strict-json.ts';

const providerCredentialPatterns = Object.freeze([
  /\bsk-(?:proj-|ant-|live-)?[a-z0-9_-]{16,}\b/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|akia[a-z0-9]{16})\b/iu,
  /\bbearer[ \t]+[a-z0-9._~+/=-]{20,}\b/iu,
]);

// `String.prototype.replace` resets `lastIndex` on global regexes, so sharing these is safe.
const globalProviderCredentialPatterns = Object.freeze(
  providerCredentialPatterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`)),
);

const credentialAssignmentPattern = /((?:["']?)(?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|authorization|credential|password|secret|token)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/giu;

const structuralEnvironmentKeys = new Set(['codex_home', 'home', 'path']);

const credentialKeywords = Object.freeze([
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
]);

/** Mirrors the playground service key heuristic so eval configuration cannot become a credential surface. */
export const isCredentialKey = (key: string): boolean => {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  const compact = segments.join('');
  return segments.some((segment) => credentialKeywords.includes(segment))
    || /(?:apikey|apitoken|authtoken|accesstoken)$/u.test(compact);
};

export const findCredentialConfiguration = (value: unknown, path = ''): string | undefined => {
  if (typeof value === 'string') {
    return providerCredentialPatterns.some((pattern) => pattern.test(value)) ? (path === '' ? 'value' : path) : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialConfiguration(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      if (isCredentialKey(key)) return keyPath;
      const found = findCredentialConfiguration(item, keyPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** Native eval children reuse signed-in CLI state, never credential-shaped environment variables. */
export const withoutEvalCredentialEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => Object.freeze(Object.fromEntries(
  Object.entries(environment).filter(([name, value]) =>
    structuralEnvironmentKeys.has(name.toLocaleLowerCase('en-US'))
    || (!isCredentialKey(name) && (value === undefined || findCredentialConfiguration(value) === undefined))),
));

/** Raw process output remains useful evidence after known credential material is irreversibly removed. */
export const redactEvalCredentialText = (value: string): string => {
  let redacted = value.replace(credentialAssignmentPattern, (_match, prefix: string, assigned: string) => {
    const quote = assigned[0] === '"' || assigned[0] === "'" ? assigned[0] : '';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  for (const pattern of globalProviderCredentialPatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
};
