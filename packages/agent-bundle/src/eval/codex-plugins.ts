import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { CodexEvalHarnessError } from './codex-errors.ts';
import { deepFreeze } from '../core/freeze.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';


export interface CodexCandidatePlugin {
  readonly marketplace: string;
  readonly plugin: string;
  readonly skills: readonly string[];
}

export type CodexInstallStepId = 'marketplace.add' | 'plugin.add' | 'plugin.list';

export interface CodexInstallStep {
  readonly args: readonly string[];
  readonly id: CodexInstallStepId;
}

const marketplacePath = '.agents/plugins/marketplace.json';

const artifactError = (message: string): CodexEvalHarnessError =>
  new CodexEvalHarnessError('CODEX_ARTIFACT_INVALID', message);

/** Stays on `Dirent`: a symlinked skill directory is not a skill of the candidate. */
const readCandidateSkills = async (candidateDirectory: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(join(candidateDirectory, 'skills'), { withFileTypes: true });
    return Object.freeze(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right)));
  } catch {
    return Object.freeze([]);
  }
};

const readMarketplaceDocument = async (candidateDirectory: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await runWithPlatform(readFileString(join(candidateDirectory, ...marketplacePath.split('/'))));
  } catch {
    throw artifactError(
      `Codex candidate ${JSON.stringify(candidateDirectory)} contains no marketplace manifest at ${marketplacePath}.`,
    );
  }
  try {
    return parseJsonWithoutDuplicateKeys(raw);
  } catch (error) {
    throw artifactError(
      `Codex candidate marketplace ${JSON.stringify(marketplacePath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** The install identity comes from the candidate's own marketplace, never from a caller-supplied name. */
export const readCodexCandidatePlugin = async (
  candidateDirectory: string,
): Promise<CodexCandidatePlugin> => {
  const document = await readMarketplaceDocument(candidateDirectory);
  if (!isRecord(document) || typeof document.name !== 'string' || document.name.length === 0) {
    throw artifactError('A Codex marketplace manifest must declare a non-empty name.');
  }
  const plugins = document.plugins;
  const first = Array.isArray(plugins) ? plugins[0] : undefined;
  if (!isRecord(first) || typeof first.name !== 'string' || first.name.length === 0) {
    throw artifactError('A Codex marketplace manifest must declare at least one named plugin.');
  }
  return Object.freeze({
    marketplace: document.name,
    plugin: first.name,
    skills: await readCandidateSkills(candidateDirectory),
  });
};

export const codexPluginInstallPlan = (
  candidate: CodexCandidatePlugin,
  candidateDirectory: string,
): readonly CodexInstallStep[] => deepFreeze([
  {
    args: Object.freeze(['plugin', 'marketplace', 'add', candidateDirectory]),
    id: 'marketplace.add' as const,
  },
  {
    args: Object.freeze(['plugin', 'add', `${candidate.plugin}@${candidate.marketplace}`]),
    id: 'plugin.add' as const,
  },
  { args: Object.freeze(['plugin', 'list', '--json']), id: 'plugin.list' as const },
]);

/** Plugin availability is read back from the temporary home's own state, so it is observed. */
export const codexPluginObserved = (
  raw: string,
  candidate: Pick<CodexCandidatePlugin, 'marketplace' | 'plugin'>,
): boolean => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.installed)) return false;
  return parsed.installed.some((entry) =>
    isRecord(entry)
    && entry.name === candidate.plugin
    && entry.marketplaceName === candidate.marketplace
    && entry.installed === true
    && entry.enabled === true);
};
