import { stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { isInside } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import { compileRouteGraph, isEmptyRouteGraph } from '../routes/graph.ts';
import type { CompiledRouteGraph } from '../routes/types.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from './ignore.ts';
import { isRenderedSkillSourceName } from './rendered-skill.ts';
import { parseSkill, type SkillDocument } from './skill.ts';

/** A skill directory is identified by SKILL.md or a rendered-skill source module. */
const isSkillDocumentName = (name: string): boolean =>
  name === 'SKILL.md' || isRenderedSkillSourceName(name);

/** One discovered project-level asset file with its artifact destination under `assets/`. */
export interface DiscoveredAsset {
  readonly bytes: number;
  readonly relativePath: string;
  readonly source: string;
}

/** One file found inside a declared prebuilt payload directory. */
export interface DiscoveredPayloadFile {
  readonly bytes: number;
  readonly relativePath: string;
  readonly source: string;
}

/** One declared prebuilt payload directory with its enumerated files. */
export interface DiscoveredPayload {
  readonly files: readonly DiscoveredPayloadFile[];
  readonly name: string;
  readonly source: string;
}

export interface DiscoveredProject {
  assets?: DiscoveredAsset[];
  payloads?: DiscoveredPayload[];
  /**
   * The compiled conventional route graph (#93). Present only when route
   * discovery found modules or produced diagnostics, so route-free projects
   * keep their existing discovery shape.
   */
  routeGraph?: CompiledRouteGraph;
  /**
   * Conventional `skills/<name>/SKILL.md` documents that explicit `skills`
   * configuration leaves uncovered — the confusable shadowed state surfaced
   * by the AB4734 migration nudge. Absent when config is silent (the
   * convention itself applies) or when every conventional skill is covered.
   */
  shadowedConventionalSkills?: readonly string[];
  skills: SkillDocument[];
}

/** Expands one configured skills entry: literal paths stay literal, globs match skill directories or SKILL.md files. */
const expandConfiguredSkill = async (projectRoot: string, skill: string): Promise<string[]> => {
  if (!fastGlob.isDynamicPattern(skill)) return [resolve(projectRoot, skill)];
  const matches = await fastGlob(skill, {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    objectMode: true,
    onlyFiles: false,
  });
  return matches
    .filter((match) => match.dirent.isDirectory() || isSkillDocumentName(match.name))
    .map((match) => match.path);
};

const assetGlobOptions = {
  absolute: true,
  dot: true,
  followSymbolicLinks: false,
  onlyFiles: true,
} as const;

/** Expands one configured assets entry: globs match files, literals name a file or a whole directory. */
const expandConfiguredAsset = async (projectRoot: string, entry: string): Promise<string[]> => {
  if (fastGlob.isDynamicPattern(entry)) return fastGlob(entry, { ...assetGlobOptions, cwd: projectRoot });
  const source = resolve(projectRoot, entry);
  let stats;
  try {
    stats = await stat(source);
  } catch {
    // Missing configured assets are omitted rather than failing discovery.
    return [];
  }
  if (stats.isFile()) return [source];
  if (!stats.isDirectory()) return [];
  return fastGlob('**', { ...assetGlobOptions, cwd: source });
};

/** The artifact destination strips a conventional leading `assets/` so `assets/logo.svg` stays `logo.svg`. */
const assetRelativePath = (projectRoot: string, source: string): string => {
  const projectRelative = relative(projectRoot, source).replaceAll('\\', '/');
  return projectRelative.startsWith('assets/') ? projectRelative.slice('assets/'.length) : projectRelative;
};

const discoverAssets = async (
  projectRoot: string,
  configured: readonly string[] | undefined,
  rules: Awaited<ReturnType<typeof readProjectIgnoreRules>>,
): Promise<DiscoveredAsset[]> => {
  const sources = configured === undefined
    ? await fastGlob('assets/**', { ...assetGlobOptions, cwd: projectRoot })
    : (await Promise.all(configured.map((entry) => expandConfiguredAsset(projectRoot, entry)))).flat();
  const selected = [...new Set(sources)]
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(selected.map(async (source) => ({
    bytes: (await stat(source)).size,
    relativePath: assetRelativePath(projectRoot, source),
    source,
  })));
};

/** The declared source path of a payload declaration, or undefined when the declaration is not string-or-`{source}` shaped. */
export const payloadDeclarationEntry = (declaration: unknown): string | undefined => {
  const entry = typeof declaration === 'string'
    ? declaration
    : isRecord(declaration) ? declaration.source : undefined;
  return typeof entry === 'string' && entry.trim().length > 0 ? entry : undefined;
};

/**
 * The absolute, project-contained source directory of one well-shaped payload
 * declaration. Malformed or escaping declarations return undefined — source
 * validation reports those (AB4740-AB4742).
 */
export const payloadDeclarationSource = (
  projectRoot: string,
  declaration: unknown,
): string | undefined => {
  const entry = payloadDeclarationEntry(declaration);
  if (entry === undefined) return undefined;
  const source = resolve(projectRoot, entry);
  return isInside(projectRoot, source) ? source : undefined;
};

/**
 * The absolute source directories of well-shaped payload declarations.
 * Source snapshots use this to include payload files in the project
 * identity even though payload directories are ignored for source discovery.
 */
export const configuredPayloadRoots = (
  projectRoot: string,
  config: Readonly<AgentBundleConfig>,
): readonly string[] => {
  const configured = config.payload;
  if (configured === undefined || !isRecord(configured)) return [];
  const roots: string[] = [];
  for (const declaration of Object.values(configured)) {
    const source = payloadDeclarationSource(projectRoot, declaration);
    if (source !== undefined) roots.push(source);
  }
  return [...new Set(roots)].sort((left, right) => left.localeCompare(right));
};

/**
 * Enumerates every file of each declared prebuilt payload directory. Ignore
 * rules deliberately do not apply: payloads live inside build-output
 * directories (`dist/` is mandatory-ignored for source discovery) and are
 * packaged verbatim. Malformed declarations are skipped here — source
 * validation reports them (AB4740-AB4742).
 */
const discoverPayloads = async (
  projectRoot: string,
  configured: AgentBundleConfig['payload'],
): Promise<DiscoveredPayload[]> => {
  if (configured === undefined || !isRecord(configured)) return [];
  const payloads: DiscoveredPayload[] = [];
  for (const [name, declaration] of Object.entries(configured).sort(([left], [right]) => left.localeCompare(right))) {
    const source = payloadDeclarationSource(projectRoot, declaration);
    if (source === undefined) continue;
    let stats;
    try {
      stats = await stat(source);
    } catch {
      // A payload the consumer's own build has not produced yet has no files.
    }
    if (stats?.isDirectory() !== true) {
      payloads.push({ files: [], name, source });
      continue;
    }
    const matches = (await fastGlob('**', { ...assetGlobOptions, cwd: source, stats: true }))
      .sort((left, right) => left.path.localeCompare(right.path));
    payloads.push({
      files: await Promise.all(matches.map(async (match) => ({
        bytes: (match.stats ?? await stat(match.path)).size,
        relativePath: relative(source, match.path).replaceAll('\\', '/'),
        source: match.path,
      }))),
      name,
      source,
    });
  }
  return payloads;
};

export const discoverProject = async (
  root: string,
  config: AgentBundleConfig,
): Promise<DiscoveredProject> => {
  const projectRoot = resolve(root);
  const rules = await readProjectIgnoreRules(projectRoot);
  const configuredSkills = config.skills;
  const conventionalSources = (await fastGlob('skills/*/SKILL.{md,ts,tsx}', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  })).filter((source) => !isProjectPathIgnored(rules, projectRoot, source));
  const sources =
    configuredSkills === undefined
      ? conventionalSources
      : (await Promise.all(configuredSkills.map((skill) => expandConfiguredSkill(projectRoot, skill)))).flat();
  const skillDirs = [...new Set(sources
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .map((source) => (isSkillDocumentName(basename(source)) ? dirname(source) : source)))]
    .sort((left, right) => left.localeCompare(right));
  const coveredDirs = new Set(skillDirs);
  const shadowedByDir = new Map<string, string>();
  if (configuredSkills !== undefined) {
    for (const source of [...conventionalSources].sort((left, right) => left.localeCompare(right))) {
      const skillDir = dirname(source);
      if (!coveredDirs.has(skillDir) && !shadowedByDir.has(skillDir)) {
        shadowedByDir.set(skillDir, source);
      }
    }
  }
  const shadowedConventionalSkills = [...shadowedByDir.values()];

  const payloads = await discoverPayloads(projectRoot, config.payload);
  const routeGraph = await compileRouteGraph(projectRoot, config, rules);
  return {
    assets: await discoverAssets(projectRoot, config.assets, rules),
    ...(payloads.length === 0 ? {} : { payloads }),
    ...(isEmptyRouteGraph(routeGraph) ? {} : { routeGraph }),
    ...(shadowedConventionalSkills.length === 0 ? {} : { shadowedConventionalSkills }),
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot, rules)),
    ),
  };
};
