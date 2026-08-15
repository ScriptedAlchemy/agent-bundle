import { digest, stableJson } from '../core/digest.ts';

export type ArtifactManifestFileKind = 'bundle' | 'copy' | 'generated';
export type ArtifactManifestValidationStatus = 'passed';

export interface ArtifactManifestSourceInput {
  readonly path: string;
  readonly sha256: string;
}

export interface ArtifactManifestAgentSkills {
  readonly schemaSha256: string;
  readonly sourceRevision: string;
  readonly specification: string;
}

export interface ArtifactManifestFile {
  readonly bytes: number;
  readonly kind: ArtifactManifestFileKind;
  readonly mode?: number;
  readonly path: string;
  readonly sha256: string;
  readonly sourceInputs: readonly string[];
}

export interface ArtifactManifestProducer {
  readonly name: 'agent-bundle';
  readonly version: string;
}

export interface ArtifactManifestProject {
  readonly configDigest: string;
  readonly configPath: string;
  readonly modelDigest: string;
  readonly revision: string;
  readonly sourceInputs: readonly ArtifactManifestSourceInput[];
}

export interface ArtifactManifestTargetSchema {
  readonly name: string;
  readonly revision: string;
  readonly sha256: string;
}

export interface ArtifactManifestTarget {
  readonly adapterRevision: string;
  readonly capabilityRevision: string;
  readonly capabilitySha256: string;
  readonly name: string;
  readonly observedVersion: string;
  readonly schemas: readonly ArtifactManifestTargetSchema[];
}

export interface ArtifactManifestValidationRecord {
  readonly status: ArtifactManifestValidationStatus;
}

export interface ArtifactManifestTargetValidation extends ArtifactManifestValidationRecord {
  readonly name: string;
}

export interface ArtifactManifestValidation {
  readonly artifact: ArtifactManifestValidationRecord;
  readonly source: ArtifactManifestValidationRecord;
  readonly targets: readonly ArtifactManifestTargetValidation[];
}

export interface ArtifactManifestV2 {
  readonly agentSkills: ArtifactManifestAgentSkills;
  readonly files: readonly ArtifactManifestFile[];
  readonly producer: ArtifactManifestProducer;
  readonly project: ArtifactManifestProject;
  readonly targets: readonly ArtifactManifestTarget[];
  readonly validation: ArtifactManifestValidation;
  readonly version: 2;
}

export interface AssembledArtifactManifest {
  readonly bytes: string;
  readonly manifest: ArtifactManifestV2;
}

type JsonRecord = Record<string, unknown>;

const manifestFileName = 'agent-bundle.manifest.json';
const sha256Pattern = /^[a-f0-9]{64}$/u;

const fail = (message: string): never => {
  throw new TypeError(`Artifact manifest v2 ${message}`);
};

const isPlainObject = (value: unknown): value is JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requireRecord = (value: unknown, location: string): JsonRecord =>
  isPlainObject(value) ? value : fail(`${location} must be a plain object.`);

const requireArray = (value: unknown, location: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(`${location} must be an array.`);

const requireString = (value: unknown, location: string): string =>
  typeof value === 'string' && value.length > 0
    ? value
    : fail(`${location} must be a non-empty string.`);

const requireHash = (value: unknown, location: string): string => {
  const hash = requireString(value, location);
  return sha256Pattern.test(hash) ? hash : fail(`${location} must be a lowercase SHA-256 hash.`);
};

const requirePath = (value: unknown, location: string): string => {
  const path = requireString(value, location);
  const segments = path.split('/');
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${location} must be a safe relative POSIX path.`);
  }
  return path;
};

const requireExactKeys = (
  value: JsonRecord,
  location: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0) fail(`${location} has unexpected keys: ${unexpected.join(', ')}.`);
  if (missing.length > 0) fail(`${location} is missing keys: ${missing.join(', ')}.`);
};

const requireSortedUnique = <Value>(
  values: readonly Value[],
  location: string,
  keyFor: (value: Value) => string,
): void => {
  let previous: string | undefined;
  for (const value of values) {
    const key = keyFor(value);
    if (previous !== undefined && previous >= key) {
      fail(`${location} must be sorted with no duplicate entries.`);
    }
    previous = key;
  }
};

const requireStatus = (value: unknown, location: string): ArtifactManifestValidationRecord => {
  const record = requireRecord(value, location);
  requireExactKeys(record, location, ['status']);
  if (record.status !== 'passed') fail(`${location}.status must be "passed".`);
  return { status: 'passed' };
};

const parseSourceInputs = (value: unknown, location: string): readonly ArtifactManifestSourceInput[] => {
  const inputs = requireArray(value, location).map((candidate, index) => {
    const input = requireRecord(candidate, `${location}[${index}]`);
    requireExactKeys(input, `${location}[${index}]`, ['path', 'sha256']);
    return {
      path: requirePath(input.path, `${location}[${index}].path`),
      sha256: requireHash(input.sha256, `${location}[${index}].sha256`),
    } satisfies ArtifactManifestSourceInput;
  });
  requireSortedUnique(inputs, location, (input) => input.path);
  return inputs;
};

const parseFileSourceInputs = (value: unknown, location: string): readonly string[] => {
  const sourceInputs = requireArray(value, location).map((input, index) =>
    requirePath(input, `${location}[${index}]`));
  requireSortedUnique(sourceInputs, location, (input) => input);
  return sourceInputs;
};

const parseFiles = (value: unknown): readonly ArtifactManifestFile[] => {
  const files = requireArray(value, 'files').map((candidate, index) => {
    const file = requireRecord(candidate, `files[${index}]`);
    requireExactKeys(file, `files[${index}]`, ['bytes', 'kind', 'path', 'sha256', 'sourceInputs'], ['mode']);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) {
      fail(`files[${index}].bytes must be a non-negative safe integer.`);
    }
    if (file.kind !== 'bundle' && file.kind !== 'copy' && file.kind !== 'generated') {
      fail(`files[${index}].kind is unknown.`);
    }
    if (file.mode !== undefined && (!Number.isSafeInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777)) {
      fail(`files[${index}].mode must be an integer from 0 through 0777.`);
    }
    const path = requirePath(file.path, `files[${index}].path`);
    if (path === manifestFileName) fail(`files[${index}].path must not name the manifest itself.`);
    return {
      bytes: file.bytes as number,
      kind: file.kind as ArtifactManifestFileKind,
      ...(file.mode === undefined ? {} : { mode: file.mode as number }),
      path,
      sha256: requireHash(file.sha256, `files[${index}].sha256`),
      sourceInputs: parseFileSourceInputs(file.sourceInputs, `files[${index}].sourceInputs`),
    } satisfies ArtifactManifestFile;
  });
  requireSortedUnique(files, 'files', (file) => file.path);
  return files;
};

const parseTargetSchemas = (value: unknown, location: string): readonly ArtifactManifestTargetSchema[] => {
  const schemas = requireArray(value, location).map((candidate, index) => {
    const schema = requireRecord(candidate, `${location}[${index}]`);
    requireExactKeys(schema, `${location}[${index}]`, ['name', 'revision', 'sha256']);
    return {
      name: requireString(schema.name, `${location}[${index}].name`),
      revision: requireString(schema.revision, `${location}[${index}].revision`),
      sha256: requireHash(schema.sha256, `${location}[${index}].sha256`),
    } satisfies ArtifactManifestTargetSchema;
  });
  requireSortedUnique(schemas, location, (schema) => schema.name);
  return schemas;
};

const parseTargets = (value: unknown): readonly ArtifactManifestTarget[] => {
  const targets = requireArray(value, 'targets').map((candidate, index) => {
    const target = requireRecord(candidate, `targets[${index}]`);
    requireExactKeys(target, `targets[${index}]`, [
      'adapterRevision',
      'capabilityRevision',
      'capabilitySha256',
      'name',
      'observedVersion',
      'schemas',
    ]);
    return {
      adapterRevision: requireString(target.adapterRevision, `targets[${index}].adapterRevision`),
      capabilityRevision: requireString(target.capabilityRevision, `targets[${index}].capabilityRevision`),
      capabilitySha256: requireHash(target.capabilitySha256, `targets[${index}].capabilitySha256`),
      name: requireString(target.name, `targets[${index}].name`),
      observedVersion: requireString(target.observedVersion, `targets[${index}].observedVersion`),
      schemas: parseTargetSchemas(target.schemas, `targets[${index}].schemas`),
    } satisfies ArtifactManifestTarget;
  });
  requireSortedUnique(targets, 'targets', (target) => target.name);
  return targets;
};

const parseValidation = (value: unknown): ArtifactManifestValidation => {
  const validation = requireRecord(value, 'validation');
  requireExactKeys(validation, 'validation', ['artifact', 'source', 'targets']);
  const targets = requireArray(validation.targets, 'validation.targets').map((candidate, index) => {
    const target = requireRecord(candidate, `validation.targets[${index}]`);
    requireExactKeys(target, `validation.targets[${index}]`, ['name', 'status']);
    const status = requireStatus({ status: target.status }, `validation.targets[${index}]`);
    return {
      name: requireString(target.name, `validation.targets[${index}].name`),
      status: status.status,
    } satisfies ArtifactManifestTargetValidation;
  });
  requireSortedUnique(targets, 'validation.targets', (target) => target.name);
  return {
    artifact: requireStatus(validation.artifact, 'validation.artifact'),
    source: requireStatus(validation.source, 'validation.source'),
    targets,
  };
};

const validateManifest = (value: unknown): ArtifactManifestV2 => {
  const manifest = requireRecord(value, 'root');
  requireExactKeys(manifest, 'root', ['agentSkills', 'files', 'producer', 'project', 'targets', 'validation', 'version']);
  if (manifest.version !== 2) fail('version must be 2.');

  const agentSkills = requireRecord(manifest.agentSkills, 'agentSkills');
  requireExactKeys(agentSkills, 'agentSkills', ['schemaSha256', 'sourceRevision', 'specification']);

  const producer = requireRecord(manifest.producer, 'producer');
  requireExactKeys(producer, 'producer', ['name', 'version']);
  if (producer.name !== 'agent-bundle') fail('producer.name must be "agent-bundle".');

  const project = requireRecord(manifest.project, 'project');
  requireExactKeys(project, 'project', ['configDigest', 'configPath', 'modelDigest', 'revision', 'sourceInputs']);
  const sourceInputs = parseSourceInputs(project.sourceInputs, 'project.sourceInputs');
  const configPath = requirePath(project.configPath, 'project.configPath');
  const configDigest = requireHash(project.configDigest, 'project.configDigest');
  const configInput = sourceInputs.find((input) => input.path === configPath);
  if (configInput === undefined || configInput.sha256 !== configDigest) {
    fail('project.configDigest must equal the declared configPath source input hash.');
  }
  const revision = requireHash(project.revision, 'project.revision');
  if (revision !== digest(sourceInputs)) fail('project.revision does not match project.sourceInputs.');

  const files = parseFiles(manifest.files);
  const projectInputPaths = new Set(sourceInputs.map((input) => input.path));
  for (const file of files) {
    for (const sourceInput of file.sourceInputs) {
      if (!projectInputPaths.has(sourceInput)) {
        fail(`files[${file.path}].sourceInputs contains an undeclared project source input.`);
      }
    }
  }

  const targets = parseTargets(manifest.targets);
  const validation = parseValidation(manifest.validation);
  const targetNames = targets.map((target) => target.name);
  const validationTargetNames = validation.targets.map((target) => target.name);
  if (
    targetNames.length !== validationTargetNames.length ||
    targetNames.some((name, index) => name !== validationTargetNames[index])
  ) {
    fail('validation target names must exactly match targets.');
  }

  return {
    agentSkills: {
      schemaSha256: requireHash(agentSkills.schemaSha256, 'agentSkills.schemaSha256'),
      sourceRevision: requireString(agentSkills.sourceRevision, 'agentSkills.sourceRevision'),
      specification: requireString(agentSkills.specification, 'agentSkills.specification'),
    },
    files,
    producer: {
      name: 'agent-bundle',
      version: requireString(producer.version, 'producer.version'),
    },
    project: {
      configDigest,
      configPath,
      modelDigest: requireHash(project.modelDigest, 'project.modelDigest'),
      revision,
      sourceInputs,
    },
    targets,
    validation,
    version: 2,
  };
};

const freezeDeep = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeDeep);
  }
  return Object.freeze(value);
};

const skipWhitespace = (bytes: string, index: number): number => {
  let cursor = index;
  while (/\s/u.test(bytes[cursor] ?? '')) cursor += 1;
  return cursor;
};

const scanJsonString = (bytes: string, index: number): readonly [string, number] => {
  let cursor = index + 1;
  while (cursor < bytes.length) {
    const character = bytes[cursor]!;
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '"') {
      const end = cursor + 1;
      return [JSON.parse(bytes.slice(index, end)) as string, end];
    }
    cursor += 1;
  }
  throw new SyntaxError('Artifact manifest JSON has an unterminated string.');
};

const scanJsonValue = (bytes: string, index: number): number => {
  let cursor = skipWhitespace(bytes, index);
  const character = bytes[cursor];
  if (character === '{') {
    cursor = skipWhitespace(bytes, cursor + 1);
    const keys = new Set<string>();
    if (bytes[cursor] === '}') return cursor + 1;
    while (true) {
      if (bytes[cursor] !== '"') throw new SyntaxError('Artifact manifest JSON has an invalid object key.');
      const [key, afterKey] = scanJsonString(bytes, cursor);
      if (keys.has(key)) throw new SyntaxError(`Artifact manifest JSON has duplicate key ${JSON.stringify(key)}.`);
      keys.add(key);
      cursor = skipWhitespace(bytes, afterKey);
      if (bytes[cursor] !== ':') throw new SyntaxError('Artifact manifest JSON has an invalid object entry.');
      cursor = skipWhitespace(bytes, scanJsonValue(bytes, cursor + 1));
      if (bytes[cursor] === '}') return cursor + 1;
      if (bytes[cursor] !== ',') throw new SyntaxError('Artifact manifest JSON has an invalid object separator.');
      cursor = skipWhitespace(bytes, cursor + 1);
    }
  }
  if (character === '[') {
    cursor = skipWhitespace(bytes, cursor + 1);
    if (bytes[cursor] === ']') return cursor + 1;
    while (true) {
      cursor = skipWhitespace(bytes, scanJsonValue(bytes, cursor));
      if (bytes[cursor] === ']') return cursor + 1;
      if (bytes[cursor] !== ',') throw new SyntaxError('Artifact manifest JSON has an invalid array separator.');
      cursor = skipWhitespace(bytes, cursor + 1);
    }
  }
  if (character === '"') return scanJsonString(bytes, cursor)[1];
  while (cursor < bytes.length && !/[\s,}\]]/u.test(bytes[cursor]!)) cursor += 1;
  return cursor;
};

const assertNoDuplicateJsonKeys = (bytes: string): void => {
  const end = skipWhitespace(bytes, scanJsonValue(bytes, 0));
  if (end !== bytes.length) throw new SyntaxError('Artifact manifest JSON has trailing data.');
};

export const parseArtifactManifest = (bytes: string): ArtifactManifestV2 => {
  assertNoDuplicateJsonKeys(bytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    throw new SyntaxError('Artifact manifest is not valid JSON.');
  }
  const manifest = validateManifest(value);
  if (bytes !== `${stableJson(manifest)}\n`) {
    fail('bytes are not canonical.');
  }
  return freezeDeep(manifest);
};

/**
 * Serializes a valid v2 manifest. Caller arrays must already be sorted and unique;
 * this function validates rather than reordering them.
 */
export const serializeArtifactManifest = (manifest: ArtifactManifestV2): string => {
  const validated = validateManifest(manifest);
  return `${stableJson(validated)}\n`;
};

export const assembleArtifactManifest = (manifest: ArtifactManifestV2): AssembledArtifactManifest => {
  const bytes = serializeArtifactManifest(manifest);
  return Object.freeze({ bytes, manifest: parseArtifactManifest(bytes) });
};
