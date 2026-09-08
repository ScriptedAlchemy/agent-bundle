import { deepFreeze } from './freeze.ts';
import { isPlainDataRecord } from './strict-json.ts';

/**
 * The descriptive fields more than one host manifest carries. Identity
 * (`name`, `version`, `description`) is not here: those axes are already
 * derived once by {@link ../config/plugin-identity.ts} and stamped into
 * `model.metadata`.
 */
export const descriptiveMetadataFields = Object.freeze([
  'author',
  'homepage',
  'keywords',
  'license',
  'repository',
] as const);

export type DescriptiveMetadataField = (typeof descriptiveMetadataFields)[number];

/** The author sub-fields npm and the host manifests agree on. */
export type DescriptiveAuthorField = 'email' | 'name' | 'url';

const descriptiveAuthorFields: readonly DescriptiveAuthorField[] = Object.freeze(['email', 'name', 'url']);

export type DescriptiveAuthor = Readonly<Partial<Record<DescriptiveAuthorField, string>>>;

/** One resolved descriptive value per field, in the shape every host projects from. */
export interface DescriptiveMetadata {
  readonly author?: DescriptiveAuthor;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly repository?: string;
}

/**
 * A descriptive field this compiler refuses to share. The value is withheld
 * rather than corrected: the caller reports it against the file that declared
 * it, and the author either fixes that file or declares the field explicitly.
 */
export interface DescriptiveMetadataIssue {
  readonly field: string;
  readonly message: string;
  /** True when the value came from `plugin.metadata` rather than `package.json`. */
  readonly shared: boolean;
}

export interface DescriptiveMetadataResult {
  readonly issues: readonly DescriptiveMetadataIssue[];
  readonly value: DescriptiveMetadata;
}

export const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** An absolute `http`/`https` URL, the form every host manifest field requires. */
export const isAbsoluteHttpUrl = (value: unknown): value is string => {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const isEmailAddress = (value: unknown): value is string =>
  isNonemptyString(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

const isNonemptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonemptyString);

/** npm's `"Name <email> (url)"` person string; every part is optional but the name. */
const personPattern = /^(?<name>[^<(]*?)\s*(?:<(?<email>[^>]*)>)?\s*(?:\((?<url>[^)]*)\))?$/u;

/** `git+https://host/path(.git)`, the URL form npm writes for an HTTPS remote. */
const gitHttpsPattern = /^git\+(?<url>https?:\/\/\S+?)(?:\.git)?$/u;

/**
 * Nothing to share, reported as nothing: `null`, a blank string, and an empty
 * array all say "no value" rather than "a value this compiler rejects", and
 * `"keywords": []` is ordinary in a published `package.json`.
 */
const declaredValue = (value: unknown): unknown =>
  value === null ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
    ? undefined
    : value;

const authorFrom = (
  value: unknown,
  issues: DescriptiveMetadataIssue[],
  shared: boolean,
): DescriptiveAuthor | undefined => {
  const record = typeof value === 'string'
    ? personFrom(value.trim())
    : isPlainDataRecord(value)
      ? value
      : undefined;
  if (record === undefined) {
    issues.push({
      field: 'author',
      message: 'author must be a person string such as "Ada <ada@example.com>" or an object with name, email, and url.',
      shared,
    });
    return undefined;
  }
  const author: Record<string, string> = {};
  const name = declaredValue(record.name);
  if (name !== undefined) {
    if (isNonemptyString(name)) author.name = name.trim();
    else {
      issues.push({ field: 'author.name', message: 'author.name must be a nonempty string.', shared });
      return undefined;
    }
  }
  const email = declaredValue(record.email);
  if (email !== undefined) {
    if (isEmailAddress(email)) author.email = email.trim();
    else {
      issues.push({ field: 'author.email', message: 'author.email must be an email address.', shared });
      return undefined;
    }
  }
  const url = declaredValue(record.url);
  if (url !== undefined) {
    if (isAbsoluteHttpUrl(url)) author.url = url;
    else {
      issues.push({ field: 'author.url', message: 'author.url must be an absolute HTTP or HTTPS URL.', shared });
      return undefined;
    }
  }
  const unknown = Object.keys(record)
    .filter((field) => !(descriptiveAuthorFields as readonly string[]).includes(field))
    .sort();
  if (unknown.length > 0) {
    issues.push({
      field: 'author',
      message: `author declares ${unknown.map((field) => JSON.stringify(field)).join(', ')}; only name, email, and url are shared.`,
      shared,
    });
    return undefined;
  }
  if (Object.keys(author).length === 0) {
    issues.push({ field: 'author', message: 'author must declare at least one of name, email, or url.', shared });
    return undefined;
  }
  return Object.freeze(author);
};

/** Splits npm's person string; an empty name leaves the record without one. */
const personFrom = (value: string): Readonly<Record<string, unknown>> | undefined => {
  const groups = personPattern.exec(value)?.groups;
  if (groups === undefined) return undefined;
  return {
    ...(groups.email === undefined ? {} : { email: groups.email.trim() }),
    ...(groups.name === undefined || groups.name.trim().length === 0 ? {} : { name: groups.name.trim() }),
    ...(groups.url === undefined ? {} : { url: groups.url.trim() }),
  };
};

/**
 * npm's `repository` in the two forms that already carry the absolute HTTP(S)
 * URL host manifests require: an `http(s)` URL used verbatim, and the
 * `git+https://…` form npm writes, with the `git+` prefix and one trailing
 * `.git` removed. Shorthands (`owner/repo`, `github:owner/repo`) and SSH or
 * git-protocol URLs are not converted — deriving a provider's web URL from
 * them is a rewrite this compiler has no authority to perform, so the value is
 * withheld and the author declares the field explicitly instead.
 */
const repositoryFrom = (
  value: unknown,
  issues: DescriptiveMetadataIssue[],
  shared: boolean,
): string | undefined => {
  const declared = isPlainDataRecord(value) ? value.url : value;
  if (isAbsoluteHttpUrl(declared)) return declared;
  const converted = isNonemptyString(declared) ? gitHttpsPattern.exec(declared.trim())?.groups?.url : undefined;
  if (converted !== undefined && isAbsoluteHttpUrl(converted)) return converted;
  issues.push({
    field: 'repository',
    message:
      'repository must be an absolute HTTP or HTTPS URL, or the git+https URL npm writes for one; ' +
      'shorthand and SSH forms are not converted.',
    shared,
  });
  return undefined;
};

const descriptiveMetadataFrom = (
  declared: Readonly<Record<string, unknown>>,
  shared: boolean,
): DescriptiveMetadataResult => {
  const issues: DescriptiveMetadataIssue[] = [];
  const value: Record<string, unknown> = {};
  const author = declaredValue(declared.author);
  if (author !== undefined) {
    const planned = authorFrom(author, issues, shared);
    if (planned !== undefined) value.author = planned;
  }
  const homepage = declaredValue(declared.homepage);
  if (homepage !== undefined) {
    if (isAbsoluteHttpUrl(homepage)) value.homepage = homepage;
    else issues.push({ field: 'homepage', message: 'homepage must be an absolute HTTP or HTTPS URL.', shared });
  }
  const repository = declaredValue(declared.repository);
  if (repository !== undefined) {
    const planned = repositoryFrom(repository, issues, shared);
    if (planned !== undefined) value.repository = planned;
  }
  const license = declaredValue(declared.license);
  if (license !== undefined) {
    if (isNonemptyString(license)) value.license = license.trim();
    else issues.push({ field: 'license', message: 'license must be a nonempty string.', shared });
  }
  const keywords = declaredValue(declared.keywords);
  if (keywords !== undefined) {
    if (isNonemptyStringArray(keywords)) value.keywords = Object.freeze(keywords.map((keyword) => keyword.trim()));
    else issues.push({ field: 'keywords', message: 'keywords must be a nonempty array of nonempty strings.', shared });
  }
  return deepFreeze({ issues, value: value as DescriptiveMetadata });
};

/**
 * The descriptive metadata a project's `package.json` already declares, in the
 * one shape every host projection reads. An absent field is a normal state; a
 * malformed one is withheld with an issue for the caller to report against
 * `package.json`.
 */
export const packageDescriptiveMetadata = (
  document: Readonly<Record<string, unknown>>,
): DescriptiveMetadataResult => descriptiveMetadataFrom(document, false);

/**
 * The one shared descriptive layer every host projection starts from:
 * an explicit `plugin.metadata` field wins over the same field in
 * `package.json`, and `plugin.metadata.<field>: null` shares nothing for that
 * field so a project can keep a package field out of every artifact.
 */
export const resolveDescriptiveMetadata = (
  authored: unknown,
  packageValue: DescriptiveMetadata,
): DescriptiveMetadataResult => {
  if (authored === undefined) return deepFreeze({ issues: [], value: packageValue });
  if (!isPlainDataRecord(authored)) {
    return deepFreeze({
      issues: [{
        field: 'metadata',
        message: 'must be a plain object of shared descriptive fields.',
        shared: true,
      }],
      value: packageValue,
    });
  }
  const issues: DescriptiveMetadataIssue[] = [];
  const unknown = Object.keys(authored)
    .filter((field) => !(descriptiveMetadataFields as readonly string[]).includes(field))
    .sort();
  if (unknown.length > 0) {
    issues.push({
      field: 'metadata',
      message:
        `declares ${unknown.map((field) => JSON.stringify(field)).join(', ')}; ` +
        `it shares only ${descriptiveMetadataFields.join(', ')}.`,
      shared: true,
    });
  }
  const declared = descriptiveMetadataFrom(authored, true);
  issues.push(...declared.issues);
  const value: Record<string, unknown> = {};
  for (const field of descriptiveMetadataFields) {
    if (authored[field] === null) continue;
    const resolved = declared.value[field] ?? (authored[field] === undefined ? packageValue[field] : undefined);
    if (resolved !== undefined) value[field] = resolved;
  }
  return deepFreeze({ issues, value: value as DescriptiveMetadata });
};

/** The fields and author sub-fields one host manifest admits. */
export interface DescriptiveMetadataProjection {
  readonly authorFields: readonly DescriptiveAuthorField[];
  /**
   * Author sub-fields the host's own contract requires. A shared author
   * without them is dropped rather than projected into a document the host
   * would refuse — Claude Code's marketplace entry requires `author.name`,
   * so a `package.json` author that is only an email address shares nothing.
   */
  readonly authorRequiredFields?: readonly DescriptiveAuthorField[];
  readonly fields: readonly DescriptiveMetadataField[];
}

/**
 * The shared values one host can carry, narrowed to the fields its pinned
 * schema admits — Cursor's author object is closed to name and email, so a
 * shared `author.url` is dropped for Cursor rather than emitted and refused.
 */
export const projectDescriptiveMetadata = (
  shared: DescriptiveMetadata | undefined,
  projection: DescriptiveMetadataProjection,
): Readonly<Record<string, unknown>> => {
  if (shared === undefined) return Object.freeze({});
  const projected: Record<string, unknown> = {};
  for (const field of projection.fields) {
    const value = shared[field];
    if (value === undefined) continue;
    if (field !== 'author') {
      projected[field] = value;
      continue;
    }
    const author = Object.fromEntries(projection.authorFields
      .flatMap((sub) => (shared.author?.[sub] === undefined ? [] : [[sub, shared.author[sub]] as const])));
    const missing = (projection.authorRequiredFields ?? []).some((sub) => author[sub] === undefined);
    if (!missing && Object.keys(author).length > 0) projected.author = Object.freeze(author);
  }
  return Object.freeze(projected);
};

/**
 * One host's descriptive document before its pinned-schema validation: the
 * host block's own value wins, an explicit `null` there keeps a shared value
 * out of that one artifact, and anything the host block omits comes from the
 * shared layer. `usedShared` reports whether a shared value survived, so the
 * planner records `package.json` among its source inputs only when the
 * artifact actually depends on it.
 */
export const mergeDescriptiveMetadata = (
  authored: Readonly<Record<string, unknown>> | undefined,
  projected: Readonly<Record<string, unknown>>,
): { readonly usedShared: boolean; readonly value: Readonly<Record<string, unknown>> } => {
  const merged: Record<string, unknown> = { ...authored };
  let usedShared = false;
  for (const [field, value] of Object.entries(projected)) {
    if (authored?.[field] !== undefined) continue;
    merged[field] = value;
    usedShared = true;
  }
  // An explicit `null` is a deliberate absence rather than a value, so it
  // never reaches a document or a pinned-schema validator.
  for (const field of descriptiveMetadataFields) {
    if (merged[field] === null) delete merged[field];
  }
  return Object.freeze({ usedShared, value: Object.freeze(merged) });
};
