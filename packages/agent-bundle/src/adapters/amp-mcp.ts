import { isPlainDataRecord } from '../core/strict-json.ts';

export interface AmpMcpDocumentIssue {
  readonly path: string;
  readonly message: string;
}

const fields = new Set(['args', 'command', 'env', 'headers', 'includeTools', 'url']);

const issue = (path: string, message: string): AmpMcpDocumentIssue =>
  Object.freeze({ message, path });

const stringRecord = (value: unknown): boolean =>
  isPlainDataRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

const stringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Validates Amp's flat skill-scoped MCP map from the pinned 2026-09-07 documentation. */
export const ampMcpDocumentIssues = (value: unknown): readonly AmpMcpDocumentIssue[] => {
  if (!isPlainDataRecord(value)) return Object.freeze([issue('', 'must be a flat server map')]);
  const issues: AmpMcpDocumentIssue[] = [];
  for (const [name, candidate] of Object.entries(value)) {
    const path = name;
    if (name.trim() === '') {
      issues.push(issue('', 'server names must be nonempty'));
      continue;
    }
    if (!isPlainDataRecord(candidate)) {
      issues.push(issue(path, 'must be an object'));
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (!fields.has(key)) issues.push(issue(`${path}.${key}`, 'is not a documented Amp skill MCP field'));
    }
    const local = typeof candidate.command === 'string' && candidate.command.trim() !== '';
    const remote = typeof candidate.url === 'string' && candidate.url.trim() !== '';
    if (local === remote) issues.push(issue(path, 'must declare exactly one nonempty command or url'));
    if (candidate.args !== undefined && !stringArray(candidate.args)) {
      issues.push(issue(`${path}.args`, 'must be an array of strings'));
    }
    if (candidate.includeTools !== undefined && !stringArray(candidate.includeTools)) {
      issues.push(issue(`${path}.includeTools`, 'must be an array of strings'));
    }
    if (candidate.env !== undefined && !stringRecord(candidate.env)) {
      issues.push(issue(`${path}.env`, 'must map names to strings'));
    }
    if (candidate.headers !== undefined && !stringRecord(candidate.headers)) {
      issues.push(issue(`${path}.headers`, 'must map names to strings'));
    }
    if (local && candidate.headers !== undefined) {
      issues.push(issue(`${path}.headers`, 'is valid only for a url server'));
    }
    if (remote && (candidate.args !== undefined || candidate.env !== undefined)) {
      issues.push(issue(path, 'url servers cannot declare args or env'));
    }
  }
  return Object.freeze(issues);
};
