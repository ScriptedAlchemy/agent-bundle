import type {
  ServedSkillDocument,
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

interface DocumentResponse {
  readonly document: ServedSkillDocument;
}

const diagnosticError = (value: unknown, status: number): SkillClientError => {
  if (typeof value === 'object' && value !== null && 'diagnostic' in value) {
    const diagnostic = (value as { readonly diagnostic?: unknown }).diagnostic;
    if (
      typeof diagnostic === 'object' && diagnostic !== null &&
      typeof (diagnostic as { readonly code?: unknown }).code === 'string' &&
      typeof (diagnostic as { readonly message?: unknown }).message === 'string'
    ) {
      return new SkillClientError(
        (diagnostic as { readonly code: string }).code,
        (diagnostic as { readonly message: string }).message,
      );
    }
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
    return this.#read('/api/skills/source');
  }

  source(skillId: string): Promise<ServedSkillDocument> {
    return this.#document(sourceSkillPath(skillId));
  }

  generatedTree(epochId: string, target: string): Promise<SkillDocumentTree> {
    return this.#read(`/api/skills/epochs/${encodeURIComponent(epochId)}/${encodeURIComponent(target)}`);
  }

  generated(epochId: string, target: string, skillId: string): Promise<ServedSkillDocument> {
    return this.#document(generatedSkillPath(epochId, target, skillId));
  }

  async #document(path: string): Promise<ServedSkillDocument> {
    return (await this.#read<DocumentResponse>(path)).document;
  }

  async #read<Result>(path: string): Promise<Result> {
    const response = await this.#fetch(path);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body as Result;
  }
}
