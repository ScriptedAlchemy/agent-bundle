import type { SkillDocumentBase } from '../../agent-bundle/src/contracts/skills.ts';

const encodedSegment = (value: string): string => encodeURIComponent(value);

const localSegments = (reference: string): readonly string[] | undefined => {
  if (reference.length === 0 || reference.startsWith('/') || reference.includes('\\')) return undefined;
  if (/%2f|%5c/iu.test(reference)) return undefined;
  const path = reference.startsWith('./') ? reference.slice(2) : reference;
  let segments: string[];
  try {
    segments = path.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  return Object.freeze(segments);
};

const splitReference = (reference: string): Readonly<{ readonly fragment: string; readonly path: string }> => {
  const index = reference.indexOf('#');
  return index < 0
    ? Object.freeze({ fragment: '', path: reference })
    : Object.freeze({ fragment: reference.slice(index), path: reference.slice(0, index) });
};

export const allowedExternalResourceUrl = (value: string): string | undefined => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

export const sourceSkillPath = (skillId: string): string =>
  `/api/skills/source/${encodedSegment(skillId)}`;

export const generatedSkillPath = (epochId: string, target: string, skillId: string): string =>
  `/api/skills/epochs/${encodedSegment(epochId)}/${encodedSegment(target)}/${encodedSegment(skillId)}`;

/** Resolves a Markdown target without granting the browser a filesystem path. */
export const resourceUrlFor = (
  base: SkillDocumentBase,
  reference: string,
  resources: readonly string[],
): string | undefined => {
  if (reference.startsWith('#')) return reference;
  const external = allowedExternalResourceUrl(reference);
  if (external !== undefined) return external;
  const { fragment, path } = splitReference(reference);
  const segments = localSegments(path);
  if (segments === undefined) return undefined;
  if (!resources.includes(segments.join('/'))) return undefined;
  const prefix = base.kind === 'source'
    ? `${sourceSkillPath(base.skillId)}/resources`
    : `${generatedSkillPath(base.epochId, base.target, base.skillId)}/resources`;
  return `${prefix}/${segments.map(encodedSegment).join('/')}${fragment}`;
};
