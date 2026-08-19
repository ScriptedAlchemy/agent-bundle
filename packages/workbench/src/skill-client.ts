import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import { parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../../agent-bundle/src/core/strict-json.ts';
import type { SourceProvenance } from '../../agent-bundle/src/core/types.ts';
import type {
  ServedSkillDocument,
  SkillDocumentBase,
  SkillDocumentResource,
  SkillDocumentTree,
} from '../../agent-bundle/src/dev/skill-document-service.ts';

import { generatedSkillPath, sourceSkillPath } from './skills-model.ts';

export interface SkillClientOptions {
  readonly fetch?: typeof fetch;
}

export class SkillClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillClientError';
    this.code = code;
  }
}

type JsonRecord = Readonly<Record<string, JsonValue>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasAllowedKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is JsonRecord =>
  isRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const invalidResponse = (): SkillClientError =>
  new SkillClientError('SKILL_RESPONSE_INVALID', 'Skill route returned an invalid response.');

const requiredString = (value: JsonRecord, key: string): string => {
  const candidate = value[key];
  if (typeof candidate !== 'string') throw invalidResponse();
  return candidate;
};

const optionalString = (value: JsonRecord, key: string): string | undefined => {
  if (!Object.hasOwn(value, key)) return undefined;
  return requiredString(value, key);
};

const diagnostic = (value: unknown): Diagnostic => {
  if (!hasAllowedKeys(value, ['code', 'message', 'severity'], ['generatedPath', 'recovery', 'sourcePath', 'target'])) {
    throw invalidResponse();
  }
  const severity = value.severity;
  if (severity !== 'error' && severity !== 'info' && severity !== 'warning') throw invalidResponse();
  const generatedPath = optionalString(value, 'generatedPath');
  const recovery = optionalString(value, 'recovery');
  const sourcePath = optionalString(value, 'sourcePath');
  const target = optionalString(value, 'target');
  return Object.freeze({
    code: requiredString(value, 'code'),
    ...(generatedPath === undefined ? {} : { generatedPath }),
    message: requiredString(value, 'message'),
    ...(recovery === undefined ? {} : { recovery }),
    severity,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(target === undefined ? {} : { target }),
  });
};

const diagnostics = (value: unknown): readonly Diagnostic[] => {
  if (!Array.isArray(value)) throw invalidResponse();
  return Object.freeze(value.map(diagnostic));
};

const provenance = (value: unknown): SourceProvenance => {
  if (!hasAllowedKeys(value, ['kind', 'sourcePath'])) throw invalidResponse();
  const kind = value.kind;
  if (kind !== 'config' && kind !== 'conventional' && kind !== 'explicit') throw invalidResponse();
  return Object.freeze({ kind, sourcePath: requiredString(value, 'sourcePath') });
};

const documentBase = (value: unknown): SkillDocumentBase => {
  if (!isRecord(value)) throw invalidResponse();
  if (value.kind === 'source') {
    if (!hasAllowedKeys(value, ['kind', 'skillId'])) throw invalidResponse();
    return Object.freeze({ kind: 'source', skillId: requiredString(value, 'skillId') });
  }
  if (value.kind === 'generated') {
    if (!hasAllowedKeys(value, ['epochId', 'kind', 'skillId', 'target'])) throw invalidResponse();
    return Object.freeze({
      epochId: requiredString(value, 'epochId'),
      kind: 'generated',
      skillId: requiredString(value, 'skillId'),
      target: requiredString(value, 'target'),
    });
  }
  throw invalidResponse();
};

const resources = (value: unknown): readonly SkillDocumentResource[] => {
  if (!Array.isArray(value)) throw invalidResponse();
  return Object.freeze(value.map((resource) => {
    if (!hasAllowedKeys(resource, ['bytes', 'relativePath']) ||
      typeof resource.bytes !== 'number' || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) {
      throw invalidResponse();
    }
    return Object.freeze({ bytes: resource.bytes, relativePath: requiredString(resource, 'relativePath') });
  }));
};

const strings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw invalidResponse();
  return Object.freeze([...value]);
};

/** Decodes the only unversioned Skill DTO contract emitted by the foreground server. */
const skillDocument = (value: unknown): ServedSkillDocument => {
  if (!isRecord(value)) throw invalidResponse();
  const base = documentBase(value.base);
  const required = ['base', 'body', 'diagnostics', 'frontmatter', 'id', 'markdown', 'name', 'resources'];
  const sourceRequired = [...required, 'provenance', 'targets'];
  if (!hasAllowedKeys(value, base.kind === 'source' ? sourceRequired : required, ['description'])) throw invalidResponse();
  if (!isRecord(value.frontmatter)) throw invalidResponse();
  const description = optionalString(value, 'description');
  const shared = {
    base,
    body: requiredString(value, 'body'),
    ...(description === undefined ? {} : { description }),
    diagnostics: diagnostics(value.diagnostics),
    frontmatter: value.frontmatter,
    id: requiredString(value, 'id'),
    markdown: requiredString(value, 'markdown'),
    name: requiredString(value, 'name'),
    resources: resources(value.resources),
  };
  if (base.kind === 'source') {
    return Object.freeze({
      ...shared,
      provenance: provenance(value.provenance),
      targets: strings(value.targets),
    });
  }
  return Object.freeze(shared);
};

const skillTree = (value: unknown, kind: SkillDocumentBase['kind']): SkillDocumentTree => {
  if (!hasAllowedKeys(value, ['diagnostics', 'skills']) || !Array.isArray(value.skills)) throw invalidResponse();
  const skills = value.skills.map(skillDocument);
  if (skills.some((skill) => skill.base.kind !== kind)) throw invalidResponse();
  return Object.freeze({ diagnostics: diagnostics(value.diagnostics), skills: Object.freeze(skills) });
};

const documentResponse = (value: unknown, kind: SkillDocumentBase['kind']): ServedSkillDocument => {
  if (!hasAllowedKeys(value, ['document'])) throw invalidResponse();
  const document = skillDocument(value.document);
  if (document.base.kind !== kind) throw invalidResponse();
  return document;
};

const parseResponseJson = (bytes: Uint8Array): JsonValue => {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return snapshotStrictJsonValue(parseJsonWithoutDuplicateKeys(decoded));
  } catch {
    throw invalidResponse();
  }
};

const diagnosticError = (value: unknown, status: number): SkillClientError => {
  if (hasAllowedKeys(value, ['diagnostic']) && hasAllowedKeys(value.diagnostic, ['code', 'message'])) {
    return new SkillClientError(requiredString(value.diagnostic, 'code'), requiredString(value.diagnostic, 'message'));
  }
  return new SkillClientError('SKILL_REQUEST_FAILED', `Skill request failed with HTTP ${status}.`);
};

/** Browser transport for the foreground Skill document routes. */
export class SkillClient {
  readonly #fetch: typeof fetch;

  constructor(options: SkillClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  sourceTree(): Promise<SkillDocumentTree> {
    return this.#read('/api/skills/source', (value) => skillTree(value, 'source'));
  }

  source(skillId: string): Promise<ServedSkillDocument> {
    return this.#document(sourceSkillPath(skillId), 'source');
  }

  generatedTree(epochId: string, target: string): Promise<SkillDocumentTree> {
    return this.#read(
      `/api/skills/epochs/${encodeURIComponent(epochId)}/${encodeURIComponent(target)}`,
      (value) => skillTree(value, 'generated'),
    );
  }

  generated(epochId: string, target: string, skillId: string): Promise<ServedSkillDocument> {
    return this.#document(generatedSkillPath(epochId, target, skillId), 'generated');
  }

  #document(path: string, kind: SkillDocumentBase['kind']): Promise<ServedSkillDocument> {
    return this.#read(path, (value) => documentResponse(value, kind));
  }

  async #read<Result>(path: string, decode: (value: JsonValue) => Result): Promise<Result> {
    try {
      const response = await this.#fetch(path);
      const body = parseResponseJson(new Uint8Array(await response.arrayBuffer()));
      if (!response.ok) throw diagnosticError(body, response.status);
      return decode(body);
    } catch (error) {
      if (error instanceof SkillClientError) throw error;
      throw invalidResponse();
    }
  }
}
