import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

import { projectMeta } from '../build/meta.ts';
import { isErrno } from '../core/errors.ts';
import { isInside } from '../core/paths.ts';
import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import { compileRouteGraph, isEmptyRouteGraph } from '../routes/graph.ts';
import type { CompiledRouteGraph } from '../routes/types.ts';
import { parseCommand, type CommandDocument } from './command.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from './ignore.ts';
import { pluginIdentity } from './plugin-identity.ts';
import { isRenderedSkillSourceName } from './rendered-skill.ts';
import { parseRule, type RuleDocument } from './rule.ts';
import { parseSkill, type SkillDocument } from './skill.ts';
import { extractStateDefinition } from './state-extract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedStateDefinition } from '../core/types.ts';

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
  /** Conventional flat `src/commands/*.md` documents; absent when none are discovered. */
  commands?: readonly CommandDocument[];
  /**
   * Documents using removed top-level conventions. Validation reports AB4736
   * for every unclaimed document; absent when none are discovered.
   */
  legacyConventionalDocuments?: readonly {
    readonly kind: 'skill' | 'command' | 'rule';
    readonly source: string;
  }[];
  payloads?: DiscoveredPayload[];
  /** Conventional flat `src/rules/*.mdc` documents; absent when none are discovered. */
  rules?: readonly RuleDocument[];
  /**
   * The compiled conventional route graph (#93). Present only when route
   * discovery found modules or produced diagnostics, so route-free projects
   * keep their existing discovery shape.
   */
  routeGraph?: CompiledRouteGraph;
  /**
   * Conventional `src/skills/<name>/SKILL.md` documents that explicit `skills`
   * configuration leaves uncovered — the confusable shadowed state surfaced
   * by the AB4734 migration nudge. Absent when config is silent (the
   * convention itself applies) or when every conventional skill is covered.
   */
  shadowedConventionalSkills?: readonly string[];
  skills: SkillDocument[];
  /** Conventional src/state.ts declaration and its parse-only diagnostics. */
  state?: {
    readonly definition?: Pick<NormalizedStateDefinition, 'budgets' | 'id' | 'lifetime'>;
    readonly diagnostics: readonly Diagnostic[];
    readonly source: string;
  };
}

const discoverState = async (
  projectRoot: string,
  config: Readonly<AgentBundleConfig>,
): Promise<DiscoveredProject['state']> => {
  if (config.state === false) return undefined;
  const source = resolve(projectRoot, 'src', 'state.ts');
  let moduleText: string;
  try {
    moduleText = await readFile(source, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const extracted = extractStateDefinition(moduleText, 'src/state.ts', source);
  return {
    ...(extracted.definition === undefined ? {} : { definition: extracted.definition }),
    diagnostics: extracted.diagnostics,
    source,
  };
};

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
  // Rendered skills evaluate during discovery, before normalization stamps
  // the same identity into the model; `agent-bundle/meta` serves it to them
  // here so a skill documents the version its plugin ships (#440).
  const meta = projectMeta(pluginIdentity(projectRoot, config));
  const configuredSkills = config.skills;
  const conventionalSources = (await fastGlob('src/skills/*/SKILL.{md,ts,tsx}', {
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

  const legacySkillSources = (await fastGlob('skills/*/SKILL.{md,ts,tsx}', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  }))
    .filter((source) =>
      !isProjectPathIgnored(rules, projectRoot, source) &&
      !coveredDirs.has(dirname(source))
    );
  const legacyCommandSources = (await fastGlob('commands/*.md', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  })).filter((source) => !isProjectPathIgnored(rules, projectRoot, source));
  const legacyRuleSources = (await fastGlob('rules/*.mdc', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  })).filter((source) => !isProjectPathIgnored(rules, projectRoot, source));
  const legacyConventionalDocuments = [
    ...legacySkillSources.map((source) => ({ kind: 'skill' as const, source })),
    ...legacyCommandSources.map((source) => ({ kind: 'command' as const, source })),
    ...legacyRuleSources.map((source) => ({ kind: 'rule' as const, source })),
  ].sort((left, right) =>
    left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind)
  );

  const payloads = await discoverPayloads(projectRoot, config.payload);
  const routeGraph = await compileRouteGraph(projectRoot, config, rules);
  const commandSources = (await fastGlob('src/commands/*.md', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  }))
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .sort((left, right) => left.localeCompare(right));
  const discoveredCommands = await Promise.all(commandSources.map((source) => parseCommand(source)));
  const ruleSources = (await fastGlob('src/rules/*.mdc', {
    absolute: true,
    cwd: projectRoot,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
  }))
    .filter((source) => !isProjectPathIgnored(rules, projectRoot, source))
    .sort((left, right) => left.localeCompare(right));
  const discoveredRules = await Promise.all(ruleSources.map((source) => parseRule(source)));
  const state = await discoverState(projectRoot, config);
  return {
    assets: await discoverAssets(projectRoot, config.assets, rules),
    ...(discoveredCommands.length === 0 ? {} : { commands: discoveredCommands }),
    ...(legacyConventionalDocuments.length === 0 ? {} : { legacyConventionalDocuments }),
    ...(payloads.length === 0 ? {} : { payloads }),
    ...(routeGraph === undefined || isEmptyRouteGraph(routeGraph) ? {} : { routeGraph }),
    ...(discoveredRules.length === 0 ? {} : { rules: discoveredRules }),
    ...(shadowedConventionalSkills.length === 0 ? {} : { shadowedConventionalSkills }),
    skills: await Promise.all(
      skillDirs.map((skillDir) => parseSkill(skillDir, projectRoot, rules, { meta })),
    ),
    ...(state === undefined ? {} : { state }),
  };
};
