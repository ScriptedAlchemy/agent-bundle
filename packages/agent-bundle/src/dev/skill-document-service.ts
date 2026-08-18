import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { parseSkill, type SkillDocument, type SkillResource } from '../config/skill.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedSkill, SourceProvenance } from '../core/types.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectService } from './project-service.ts';
import { isInsideOrEqual } from '../core/paths.ts';

export type SkillDocumentErrorCode =
  | 'SKILL_DOCUMENT_UNAVAILABLE'
  | 'SKILL_EPOCH_UNAVAILABLE'
  | 'SKILL_RESOURCE_UNAVAILABLE'
  | 'SKILL_TARGET_UNAVAILABLE';

/** Stable, route-safe failures from the explicit source/epoch Skill bases. */
export class SkillDocumentError extends Error {
  readonly code: SkillDocumentErrorCode;

  constructor(code: SkillDocumentErrorCode, message: string) {
    super(message);
    this.name = 'SkillDocumentError';
    this.code = code;
  }
}

export interface SourceSkillBase {
  readonly kind: 'source';
  readonly skillId: string;
}

export interface GeneratedSkillBase {
  readonly epochId: string;
  readonly kind: 'generated';
  readonly skillId: string;
  readonly target: string;
}

export type SkillDocumentBase = GeneratedSkillBase | SourceSkillBase;

export interface SkillDocumentResource {
  readonly bytes: number;
  readonly relativePath: string;
}

/** Browser-safe document view; server parsing owns frontmatter and body splitting. */
export interface ServedSkillDocument {
  readonly base: SkillDocumentBase;
  readonly body: string;
  readonly description?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly id: string;
  /** Exact source or emitted Markdown for the Source tab; never browser-parsed frontmatter. */
  readonly markdown: string;
  readonly name: string;
  readonly provenance?: SourceProvenance;
  readonly resources: readonly SkillDocumentResource[];
  readonly targets?: readonly string[];
}

export interface ServedSkillResource {
  readonly body: Uint8Array;
  /** Active web formats are downloaded instead of rendered under the foreground origin. */
  readonly contentDisposition?: 'attachment';
  readonly contentType: string;
  readonly relativePath: string;
}

export interface SkillDocumentTree {
  readonly diagnostics: readonly Diagnostic[];
  readonly skills: readonly ServedSkillDocument[];
}

export interface SkillDocumentServiceOptions {
  readonly epochStore: EpochStore;
  readonly projectService: ProjectService;
  readonly root: string;
}

const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.text': 'text/plain; charset=utf-8',
  '.toml': 'application/toml; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
});

const safeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' &&
  !value.includes('/') && !value.includes('\\') && !value.includes('\0');

const sourceResource = (resource: SkillResource): SkillDocumentResource => Object.freeze({
  bytes: resource.bytes,
  relativePath: resource.relativePath,
});

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((entry) => Object.freeze({ ...entry })));

const documentResources = (resources: readonly SkillResource[]): readonly SkillDocumentResource[] =>
  Object.freeze(resources.map(sourceResource));

const contentTypeFor = (path: string): string =>
  contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';

const activeWebContentTypes = new Set([
  'image/svg+xml',
  'text/html',
  'text/javascript',
  'text/typescript',
]);

const contentDispositionFor = (contentType: string): 'attachment' | undefined =>
  activeWebContentTypes.has(contentType.split(';', 1)[0]!) ? 'attachment' : undefined;

const resourcePath = (segments: readonly string[]): string => {
  if (segments.length === 0 || segments.some((segment) => !safeSegment(segment))) {
    throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource path is not valid.');
  }
  return segments.join('/');
};

const sourceSkillDocument = (skill: NormalizedSkill, document: SkillDocument): ServedSkillDocument => Object.freeze({
  base: Object.freeze({ kind: 'source', skillId: skill.id }),
  body: document.body,
  ...(skill.description === undefined ? {} : { description: skill.description }),
  diagnostics: freezeDiagnostics(document.diagnostics),
  frontmatter: Object.freeze(structuredClone(document.frontmatter)),
  id: skill.id,
  markdown: document.markdown,
  name: skill.name,
  provenance: Object.freeze({ ...skill.provenance }),
  resources: Object.freeze(skill.resources.map((resource) => Object.freeze({
    bytes: resource.bytes,
    relativePath: resource.relativePath,
  }))),
  targets: Object.freeze([...skill.targets]),
});

const generatedSkillDocument = (
  base: GeneratedSkillBase,
  name: string,
  document: SkillDocument,
): ServedSkillDocument => {
  const description = document.frontmatter.description;
  return Object.freeze({
    base: Object.freeze({ ...base }),
    body: document.body,
    ...(typeof description === 'string' ? { description } : {}),
    diagnostics: freezeDiagnostics(document.diagnostics),
    frontmatter: Object.freeze(structuredClone(document.frontmatter)),
    id: base.skillId,
    markdown: document.markdown,
    name,
    resources: documentResources(document.resources),
  });
};

const resourceByPath = (
  resources: readonly SkillResource[],
  segments: readonly string[],
): SkillResource => {
  const requested = resourcePath(segments);
  const resource = resources.find((entry) => entry.relativePath === requested);
  if (resource === undefined) {
    throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource is not available from this document base.');
  }
  return resource;
};

const assertedDirectory = async (root: string): Promise<string> => {
  const metadata = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Skill document is not available from this base.');
    }
    throw error;
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Skill document base must be a regular directory.');
  }
  return realpath(root);
};

const readAllowedResource = async (
  root: string,
  resource: SkillResource,
): Promise<ServedSkillResource> => {
  const realRoot = await assertedDirectory(root);
  const candidate = resolve(root, resource.relativePath);
  if (!isInsideOrEqual(root, candidate)) {
    throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource escapes its document base.');
  }
  const metadata = await lstat(candidate).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource is not available from this document base.');
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource must be a regular file.');
  }
  const realCandidate = await realpath(candidate);
  if (!isInsideOrEqual(realRoot, realCandidate)) {
    throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource escapes its document base.');
  }
  const contentType = contentTypeFor(resource.relativePath);
  return Object.freeze({
    body: new Uint8Array(await readFile(realCandidate)),
    ...(contentDispositionFor(contentType) === undefined ? {} : { contentDisposition: 'attachment' as const }),
    contentType,
    relativePath: resource.relativePath,
  });
};

/**
 * Presents only normalized source Skills or resources from a pinned immutable
 * epoch. The browser chooses opaque IDs, never local filesystem paths.
 */
export class SkillDocumentService {
  readonly #epochStore: EpochStore;
  readonly #projectService: ProjectService;
  readonly #root: string;

  constructor(options: SkillDocumentServiceOptions) {
    this.#epochStore = options.epochStore;
    this.#projectService = options.projectService;
    this.#root = resolve(options.root);
  }

  async sourceTree(): Promise<SkillDocumentTree> {
    const prepared = await this.#projectService.prepare('inspect');
    return Object.freeze({
      diagnostics: freezeDiagnostics(prepared.diagnostics),
      skills: Object.freeze(await Promise.all((prepared.model?.skills ?? []).map((skill) => this.#sourceDocument(skill)))),
    });
  }

  async source(skillId: string): Promise<ServedSkillDocument> {
    const skill = await this.#sourceSkill(skillId);
    return this.#sourceDocument(skill);
  }

  async sourceResource(skillId: string, segments: readonly string[]): Promise<ServedSkillResource> {
    let skill: NormalizedSkill;
    try {
      skill = await this.#sourceSkill(skillId);
    } catch (error) {
      if (error instanceof SkillDocumentError && error.code === 'SKILL_DOCUMENT_UNAVAILABLE') {
        throw new SkillDocumentError('SKILL_RESOURCE_UNAVAILABLE', 'Skill resource is not available from this document base.');
      }
      throw error;
    }
    const resource = resourceByPath(skill.resources, segments);
    return readAllowedResource(skill.dir, resource);
  }

  async generatedTree(epochId: string, target: string): Promise<SkillDocumentTree> {
    return this.#withEpochTarget(epochId, target, async (targetRoot) => {
      const skillsRoot = await this.#skillsRoot(targetRoot);
      const entries = await readdir(skillsRoot, { withFileTypes: true });
      const documents = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && safeSegment(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => this.#generatedDocument(epochId, target, `skill:${entry.name}`, targetRoot)));
      return Object.freeze({ diagnostics: Object.freeze([]), skills: Object.freeze(documents) });
    });
  }

  async generated(epochId: string, target: string, skillId: string): Promise<ServedSkillDocument> {
    return this.#withEpochTarget(epochId, target, (targetRoot) =>
      this.#generatedDocument(epochId, target, skillId, targetRoot));
  }

  async generatedResource(
    epochId: string,
    target: string,
    skillId: string,
    segments: readonly string[],
  ): Promise<ServedSkillResource> {
    return this.#withEpochTarget(epochId, target, async (targetRoot) => {
      const document = await this.#generatedParser(skillId, targetRoot);
      const resource = resourceByPath(document.resources, segments);
      return readAllowedResource(document.dir, resource);
    });
  }

  async #sourceSkill(skillId: string): Promise<NormalizedSkill> {
    const prepared = await this.#projectService.prepare('inspect');
    const skill = prepared.model?.skills.find((candidate) => candidate.id === skillId);
    if (skill === undefined) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Source Skill is not available from the current normalized project.');
    }
    return skill;
  }

  async #sourceDocument(skill: NormalizedSkill): Promise<ServedSkillDocument> {
    const document = await parseSkill(skill.dir, this.#root);
    if (document.diagnostics.some((entry) => entry.code === 'AB3000')) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Source Skill Markdown is not available.');
    }
    return sourceSkillDocument(skill, document);
  }

  async #withEpochTarget<Result>(
    epochId: string,
    target: string,
    operation: (targetRoot: string) => Promise<Result>,
  ): Promise<Result> {
    if (!safeSegment(epochId)) {
      throw new SkillDocumentError('SKILL_EPOCH_UNAVAILABLE', 'Artifact epoch is not valid.');
    }
    if (!safeSegment(target)) {
      throw new SkillDocumentError('SKILL_TARGET_UNAVAILABLE', 'Artifact target is not valid.');
    }
    let reference;
    try {
      reference = await this.#epochStore.acquireEpochReference(epochId);
    } catch (error) {
      if (error instanceof Error) {
        throw new SkillDocumentError('SKILL_EPOCH_UNAVAILABLE', 'Artifact epoch is not available.');
      }
      throw error;
    }
    try {
      const realEpochRoot = await assertedDirectory(reference.root).catch((error: unknown) => {
        if (error instanceof SkillDocumentError) {
          throw new SkillDocumentError('SKILL_EPOCH_UNAVAILABLE', 'Artifact epoch is not available.');
        }
        throw error;
      });
      const targetRoot = join(realEpochRoot, target);
      const realTargetRoot = await assertedDirectory(targetRoot).catch((error: unknown) => {
        if (error instanceof SkillDocumentError) {
          throw new SkillDocumentError('SKILL_TARGET_UNAVAILABLE', 'Artifact target is not available in this epoch.');
        }
        throw error;
      });
      if (!isInsideOrEqual(realEpochRoot, realTargetRoot)) {
        throw new SkillDocumentError('SKILL_TARGET_UNAVAILABLE', 'Artifact target escapes its epoch.');
      }
      return await operation(realTargetRoot);
    } finally {
      await reference.close();
    }
  }

  async #skillsRoot(targetRoot: string): Promise<string> {
    const skillsRoot = join(targetRoot, 'skills');
    const realSkillsRoot = await assertedDirectory(skillsRoot).catch((error: unknown) => {
      if (error instanceof SkillDocumentError) {
        throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'No generated Skills are available for this target.');
      }
      throw error;
    });
    if (!isInsideOrEqual(targetRoot, realSkillsRoot)) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Generated Skills escape their target base.');
    }
    return realSkillsRoot;
  }

  async #generatedParser(skillId: string, targetRoot: string): Promise<SkillDocument> {
    if (!skillId.startsWith('skill:') || !safeSegment(skillId.slice('skill:'.length))) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Generated Skill ID is not valid.');
    }
    const name = skillId.slice('skill:'.length);
    const skillsRoot = await this.#skillsRoot(targetRoot);
    const skillRoot = join(skillsRoot, name);
    const realSkillRoot = await assertedDirectory(skillRoot);
    if (!isInsideOrEqual(skillsRoot, realSkillRoot)) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Generated Skill escapes its target base.');
    }
    const document = await parseSkill(realSkillRoot, targetRoot);
    if (document.diagnostics.some((entry) => entry.code === 'AB3000')) {
      throw new SkillDocumentError('SKILL_DOCUMENT_UNAVAILABLE', 'Generated Skill Markdown is not available.');
    }
    return document;
  }

  async #generatedDocument(
    epochId: string,
    target: string,
    skillId: string,
    targetRoot: string,
  ): Promise<ServedSkillDocument> {
    const name = skillId.startsWith('skill:') ? skillId.slice('skill:'.length) : '';
    const document = await this.#generatedParser(skillId, targetRoot);
    return generatedSkillDocument({ epochId, kind: 'generated', skillId, target }, name, document);
  }
}
