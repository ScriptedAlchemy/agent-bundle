import { posix } from 'node:path';

import { parse as parseYaml } from 'yaml';

export type ParsedSkillMarkdown =
  | { readonly body: string; readonly status: 'missing-frontmatter' }
  | { readonly body: string; readonly message: string; readonly status: 'malformed-frontmatter' }
  | { readonly body: string; readonly frontmatter: Record<string, unknown>; readonly status: 'valid' };

const frontmatterPattern = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const parseSkillMarkdown = (markdown: string): ParsedSkillMarkdown => {
  const match = frontmatterPattern.exec(markdown);
  if (match === null) {
    return { body: markdown, status: 'missing-frontmatter' };
  }

  const body = markdown.slice(match[0].length);
  try {
    const frontmatter = parseYaml(match[1]);
    if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
      throw new TypeError('YAML frontmatter must define an object.');
    }
    return { body, frontmatter, status: 'valid' };
  } catch (error) {
    return {
      body,
      message: error instanceof Error ? error.message : String(error),
      status: 'malformed-frontmatter',
    };
  }
};

const withoutMarkdownCode = (body: string): string => {
  let fence: { character: string; length: number } | undefined;

  return body
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence.character && marker.length >= fence.length) {
          fence = undefined;
        }
        return '';
      }
      if (marker !== undefined) {
        fence = { character: marker[0] ?? '', length: marker.length };
        return '';
      }
      return line.replace(/`+[^`\n]*`+/g, '');
    })
    .join('\n');
};

const resourcePath = (rawReference: string): string | undefined => {
  const destination = rawReference.trim();
  if (
    destination.startsWith('#') ||
    destination.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(destination)
  ) {
    return undefined;
  }

  const pathOnly = destination.split(/[?#]/, 1)[0];
  if (pathOnly === undefined || pathOnly.length === 0) return undefined;

  try {
    return posix.normalize(decodeURIComponent(pathOnly));
  } catch {
    return posix.normalize(pathOnly);
  }
};

const markdownDestination = (value: string): string => {
  const titleStart = value.search(/\s+(?=["'(])/u);
  return (titleStart === -1 ? value : value.slice(0, titleStart)).trim();
};

const normalizeReferenceLabel = (label: string): string =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

export const referencedResources = (body: string): readonly string[] => {
  const markdown = withoutMarkdownCode(body);
  const references: string[] = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\n)]*))\)/g;

  for (const match of markdown.matchAll(linkPattern)) {
    const rawReference = match[1] ?? match[2];
    const path = rawReference === undefined ? undefined : resourcePath(markdownDestination(rawReference));
    if (path !== undefined) references.push(path);
  }

  const definitions = new Map<string, string | undefined>();
  const definitionPattern = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>\n]+)>|(.+?))\s*$/gm;
  for (const match of markdown.matchAll(definitionPattern)) {
    const label = match[1];
    const rawReference = match[2] ?? match[3];
    if (label === undefined || rawReference === undefined) continue;

    const normalizedLabel = normalizeReferenceLabel(label);
    if (!definitions.has(normalizedLabel)) {
      definitions.set(normalizedLabel, resourcePath(markdownDestination(rawReference)));
    }
  }

  const markdownWithoutDefinitions = markdown.replace(/^ {0,3}\[[^\]]+\]:.*$/gm, '');
  const referencePattern = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
  for (const match of markdownWithoutDefinitions.matchAll(referencePattern)) {
    const text = match[1];
    const explicitLabel = match[2];
    const label = explicitLabel === '' ? text : explicitLabel;
    if (label === undefined) continue;

    const path = definitions.get(normalizeReferenceLabel(label));
    if (path !== undefined) references.push(path);
  }

  const shortcutPattern = /!?\[([^\]]+)\](?!\[|\()/g;
  for (const match of markdownWithoutDefinitions.matchAll(shortcutPattern)) {
    const label = match[1];
    if (label === undefined) continue;

    const path = definitions.get(normalizeReferenceLabel(label));
    if (path !== undefined) references.push(path);
  }

  return [...new Set(references)];
};
