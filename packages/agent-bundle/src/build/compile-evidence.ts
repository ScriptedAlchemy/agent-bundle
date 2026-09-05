import { join, posix } from 'node:path';

import packageManifest from '../../package.json' with { type: 'json' };
import { sha256File, stableJson } from '../core/digest.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { isPlainRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { artifactDiagnostic } from './artifact-diagnostics.ts';
import type { CompileResult, ExternalIR } from './compile-result.ts';
import { classifyExternal } from './external-policy.ts';

/**
 * The compile evidence record: what the compiler service reported about each
 * file it emitted, persisted beside the emitted files and bound to their
 * bytes. Self-containment was judged on this evidence at build time
 * (`external-policy.ts`); the record lets `validate --artifact` re-check the
 * judgement against the file table without reading a byte of JavaScript, and
 * states plainly what the compiler could not see.
 */
export const compileEvidenceFileName = 'agent-bundle.compile-evidence.json';

/** The self-containment policy the record was judged under; bump `revision` when `external-policy.ts` changes what it permits. */
export const externalPolicy = Object.freeze({ name: 'closed-world-externals', revision: 1 });

/**
 * Load forms Rslib's profile leaves verbatim in the emitted bundle: the
 * compiler neither bundles nor records them, so no record entry proves their
 * absence. A record's `coverage.unobserved` lists them so a reader knows the
 * limits of "no externals".
 */
export const unobservedLoadForms: readonly string[] = Object.freeze([
  'import(<expression>)',
  'require(<expression>)',
  'require.resolve(…)',
  'createRequire(…)(…)',
  'import.meta.resolve(…)',
]);

export type CompileEvidenceExternalKind = 'artifact-relative' | 'builtin';

/** One run-time load the compiler kept external; a `package` external never reaches a record, the build fails first. */
export interface CompileEvidenceExternal {
  readonly externalType: string;
  /** Issuer modules relative to the project root (POSIX). */
  readonly issuers: readonly string[];
  readonly kind: CompileEvidenceExternalKind;
  readonly request: string;
  /** The emitted file an artifact-relative request loads, relative to the record root (POSIX). */
  readonly target?: string;
  readonly userRequest: string;
}

export interface CompileEvidenceAsset {
  readonly externals: readonly CompileEvidenceExternal[];
  /** Packages the compiler inlined into this file (`ModuleIR.package`); sorted, unique. */
  readonly packages: readonly string[];
  /** The emitted file, relative to the record root (POSIX). */
  readonly path: string;
  /** SHA-256 of the emitted bytes the evidence describes. */
  readonly sha256: string;
}

export interface CompileEvidenceCoverage {
  /** A `tools` hatch ran in this build: emitted bytes may differ from the module graph the record describes. */
  readonly rewritable: boolean;
  readonly unobserved: readonly string[];
}

export interface CompileEvidencePolicy {
  readonly name: string;
  readonly revision: number;
}

export interface CompileEvidenceProducer {
  readonly name: 'agent-bundle';
  readonly rspack: string;
  readonly version: string;
}

export interface CompileEvidenceRecord {
  /** Sorted by `path`, one entry per emitted compiled file. */
  readonly assets: readonly CompileEvidenceAsset[];
  readonly coverage: CompileEvidenceCoverage;
  readonly policy: CompileEvidencePolicy;
  readonly producer: CompileEvidenceProducer;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

const sortedUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));

/** The distinct packages of every dependency module the compiler inlined into `asset`. */
export const bundledPackagesOf = (result: CompileResult, asset: string): readonly string[] =>
  sortedUnique(result.modules.flatMap((module) => (module.asset === asset && module.package !== undefined ? [module.package] : [])));

const recordedExternal = (external: ExternalIR, recorded: (path: string) => string): CompileEvidenceExternal => {
  switch (external.kind) {
    case 'artifact-relative':
      return Object.freeze({
        externalType: external.externalType,
        issuers: sortedUnique(external.issuers),
        kind: 'artifact-relative',
        request: external.request,
        target: recorded(posix.join(posix.dirname(external.asset), external.request)),
        userRequest: external.userRequest,
      });
    case 'builtin':
      return Object.freeze({
        externalType: external.externalType,
        issuers: sortedUnique(external.issuers),
        kind: 'builtin',
        request: external.request,
        userRequest: external.userRequest,
      });
    case 'package':
      throw new Error(`Compile evidence cannot record the package external ${JSON.stringify(external.request)}; the build fails on it first.`);
    default: {
      const exhaustive: never = external.kind;
      throw new Error(`Unknown external kind ${JSON.stringify(exhaustive)}.`);
    }
  }
};

/**
 * Builds the record for every asset the given compile results emitted under
 * `root`, hashing the emitted bytes as they stand on disk. Results are the
 * self-containment-checked results of one build; a `package` external among
 * them is a framework fault.
 */
export const createCompileEvidenceRecord = async (options: {
  /** Prefixed to every recorded path when the record names files under a directory the results are relative to (`dist`). */
  readonly pathPrefix?: string;
  readonly results: readonly CompileResult[];
  /** True when a `tools` hatch (`rspack` or `rsbuild`) took part in the build. */
  readonly rewritable: boolean;
  /** The directory the results' asset paths are relative to. */
  readonly root: string;
  readonly rspackVersion: string;
}): Promise<CompileEvidenceRecord> => {
  const recorded = (path: string): string => (options.pathPrefix === undefined ? path : `${options.pathPrefix}/${path}`);
  const assets = await Promise.all(options.results.flatMap((result) => result.assets.map(async (asset) => Object.freeze({
    externals: Object.freeze(result.externals
      .filter((external) => external.asset === asset.path)
      .map((external) => recordedExternal(external, recorded))
      .sort((left, right) => left.request.localeCompare(right.request) || left.userRequest.localeCompare(right.userRequest))),
    packages: bundledPackagesOf(result, asset.path),
    path: recorded(asset.path),
    sha256: await sha256File(join(options.root, asset.path)),
  }))));
  const paths = new Set<string>();
  for (const asset of assets) {
    if (paths.has(asset.path)) throw new Error(`Compile evidence records ${JSON.stringify(asset.path)} twice.`);
    paths.add(asset.path);
  }
  return Object.freeze({
    assets: Object.freeze(assets.sort((left, right) => left.path.localeCompare(right.path))),
    coverage: Object.freeze({ rewritable: options.rewritable, unobserved: unobservedLoadForms }),
    policy: externalPolicy,
    producer: Object.freeze({ name: 'agent-bundle', rspack: options.rspackVersion, version: packageManifest.version }),
  });
};

export const serializeCompileEvidenceRecord = (record: CompileEvidenceRecord): string => `${stableJson(record)}\n`;

const fail = (message: string): never => {
  throw new TypeError(`Compile evidence record ${message}`);
};

const requireRecord = (value: unknown, location: string): Record<string, unknown> =>
  isPlainRecord(value) ? value : fail(`${location} must be a plain object.`);

const requireExactKeys = (
  value: Record<string, unknown>,
  location: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0) fail(`${location} has unexpected keys: ${unexpected.join(', ')}.`);
  if (missing.length > 0) fail(`${location} is missing keys: ${missing.join(', ')}.`);
};

const requireString = (value: unknown, location: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fail(`${location} must be a non-empty string.`);

const requirePath = (value: unknown, location: string): string => {
  const path = requireString(value, location);
  const segments = path.split('/');
  if (
    path.includes('\\')
    || path.includes('\0')
    || path.startsWith('/')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${location} must be a safe relative POSIX path.`);
  }
  return path;
};

const requireStrings = (value: unknown, location: string): readonly string[] => {
  if (!Array.isArray(value)) fail(`${location} must be an array.`);
  return Object.freeze((value as readonly unknown[]).map((entry, index) => requireString(entry, `${location}[${index}]`)));
};

const requireSortedStrings = (value: unknown, location: string): readonly string[] => {
  const entries = requireStrings(value, location);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.localeCompare(entries[index]!) >= 0) fail(`${location} must be sorted with no duplicate entries.`);
  }
  return entries;
};

const parseExternal = (value: unknown, location: string): CompileEvidenceExternal => {
  const external = requireRecord(value, location);
  requireExactKeys(external, location, ['externalType', 'issuers', 'kind', 'request', 'userRequest'], ['target']);
  const kind = external.kind;
  if (kind !== 'artifact-relative' && kind !== 'builtin') fail(`${location}.kind must be "artifact-relative" or "builtin".`);
  if ((external.target === undefined) !== (kind === 'builtin')) {
    fail(`${location}.target is required for an artifact-relative external and forbidden for a built-in.`);
  }
  return Object.freeze({
    externalType: requireString(external.externalType, `${location}.externalType`),
    issuers: requireSortedStrings(external.issuers, `${location}.issuers`),
    kind: kind as CompileEvidenceExternalKind,
    request: requireString(external.request, `${location}.request`),
    ...(external.target === undefined ? {} : { target: requirePath(external.target, `${location}.target`) }),
    userRequest: requireString(external.userRequest, `${location}.userRequest`),
  });
};

const parseAsset = (value: unknown, location: string): CompileEvidenceAsset => {
  const asset = requireRecord(value, location);
  requireExactKeys(asset, location, ['externals', 'packages', 'path', 'sha256']);
  if (!Array.isArray(asset.externals)) fail(`${location}.externals must be an array.`);
  const sha256 = requireString(asset.sha256, `${location}.sha256`);
  if (!sha256Pattern.test(sha256)) fail(`${location}.sha256 must be a lowercase SHA-256 hash.`);
  return Object.freeze({
    externals: Object.freeze((asset.externals as readonly unknown[]).map((external, index) =>
      parseExternal(external, `${location}.externals[${index}]`))),
    packages: requireSortedStrings(asset.packages, `${location}.packages`),
    path: requirePath(asset.path, `${location}.path`),
    sha256,
  });
};

/** Parses the persisted record strictly: exact keys, sorted unique assets, safe paths, well-formed digests. */
export const parseCompileEvidenceRecord = (bytes: string): CompileEvidenceRecord => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(bytes);
  } catch {
    return fail('is not valid JSON.');
  }
  const record = requireRecord(parsed, 'root');
  requireExactKeys(record, 'root', ['assets', 'coverage', 'policy', 'producer']);
  if (!Array.isArray(record.assets)) fail('assets must be an array.');
  const assets = (record.assets as readonly unknown[]).map((asset, index) => parseAsset(asset, `assets[${index}]`));
  for (let index = 1; index < assets.length; index += 1) {
    if (assets[index - 1]!.path.localeCompare(assets[index]!.path) >= 0) fail('assets must be sorted by path with no duplicates.');
  }
  const coverage = requireRecord(record.coverage, 'coverage');
  requireExactKeys(coverage, 'coverage', ['rewritable', 'unobserved']);
  const rewritable = coverage.rewritable;
  if (typeof rewritable !== 'boolean') return fail('coverage.rewritable must be a boolean.');
  const policy = requireRecord(record.policy, 'policy');
  requireExactKeys(policy, 'policy', ['name', 'revision']);
  const revision = policy.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return fail('policy.revision must be a positive integer.');
  }
  const producer = requireRecord(record.producer, 'producer');
  requireExactKeys(producer, 'producer', ['name', 'rspack', 'version']);
  if (producer.name !== 'agent-bundle') fail('producer.name must be "agent-bundle".');
  return Object.freeze({
    assets: Object.freeze(assets),
    coverage: Object.freeze({
      rewritable,
      unobserved: requireStrings(coverage.unobserved, 'coverage.unobserved'),
    }),
    policy: Object.freeze({ name: requireString(policy.name, 'policy.name'), revision }),
    producer: Object.freeze({
      name: 'agent-bundle',
      rspack: requireString(producer.rspack, 'producer.rspack'),
      version: requireString(producer.version, 'producer.version'),
    }),
  });
};

/** MCP App views are the only compiled HTML documents (`mcp-apps/<name>.html`). */
const isViewAsset = (path: string): boolean => path.endsWith('.html');

const evidenceDiagnostic = (message: string): Diagnostic =>
  artifactDiagnostic('AB6039', `Compile evidence ${message}`, compileEvidenceFileName);

/**
 * Checks a parsed record against the artifact's file table: every compiled
 * file is covered by exactly the bytes the record describes, every recorded
 * file is a compiled file, every recorded external is one the policy permits
 * (a built-in, or an artifact-relative target the artifact contains), and
 * the record was judged under the policy this validator applies.
 */
export const compileEvidenceDiagnostics = (
  record: CompileEvidenceRecord,
  files: ReadonlyMap<string, { readonly kind: string; readonly sha256: string }>,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (record.policy.name !== externalPolicy.name || record.policy.revision !== externalPolicy.revision) {
    diagnostics.push(evidenceDiagnostic(
      `was judged under policy ${record.policy.name}@${String(record.policy.revision)}; `
      + `this validator applies ${externalPolicy.name}@${String(externalPolicy.revision)}.`,
    ));
  }
  const recorded = new Map(record.assets.map((asset) => [asset.path, asset]));
  const compiled = new Set([...files].filter(([, file]) => file.kind === 'bundle').map(([path]) => path));
  for (const path of compiled) {
    const asset = recorded.get(path);
    if (asset === undefined) diagnostics.push(evidenceDiagnostic(`does not cover compiled file ${JSON.stringify(path)}.`));
    else if (asset.sha256 !== files.get(path)!.sha256) diagnostics.push(evidenceDiagnostic(`for ${JSON.stringify(path)} describes different bytes.`));
  }
  // A view (an HTML document) inlines every module it loads; only node bundles may load a sibling, and only another node bundle.
  const nodeBundles = new Set([...compiled].filter((path) => !isViewAsset(path)));
  for (const asset of record.assets) {
    if (!compiled.has(asset.path)) {
      diagnostics.push(evidenceDiagnostic(`names ${JSON.stringify(asset.path)}, which the manifest does not list as a compiled file.`));
    }
    for (const external of asset.externals) {
      if (isViewAsset(asset.path)) {
        diagnostics.push(evidenceDiagnostic(
          `for ${JSON.stringify(asset.path)} records ${JSON.stringify(external.request)} as an external; a view inlines every module it loads.`,
        ));
        continue;
      }
      // The same judgement the build made, over the file table instead of the module graph.
      const judged = classifyExternal(external, { asset: asset.path, emittedAssets: nodeBundles });
      switch (external.kind) {
        case 'builtin':
          if (judged !== 'builtin') {
            diagnostics.push(evidenceDiagnostic(
              `for ${JSON.stringify(asset.path)} records ${JSON.stringify(external.request)} as a built-in; it is not one.`,
            ));
          }
          break;
        case 'artifact-relative':
          if (judged !== 'artifact-relative' || external.target !== posix.join(posix.dirname(asset.path), external.request)) {
            diagnostics.push(evidenceDiagnostic(
              `for ${JSON.stringify(asset.path)} records sibling ${JSON.stringify(external.request)}, which the artifact does not contain.`,
            ));
          }
          break;
        default: {
          const exhaustive: never = external.kind;
          throw new Error(`Unknown external kind ${JSON.stringify(exhaustive)}.`);
        }
      }
    }
  }
  return Object.freeze(diagnostics);
};
