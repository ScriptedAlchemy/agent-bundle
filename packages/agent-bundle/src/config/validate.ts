import { basename, posix } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  AgentBundleHookEntry,
  AgentBundleHookInput,
  CanonicalHookEvent,
  NormalizationTargetRegistry,
  NormalizedPlugin,
} from '../core/types.ts';
import type { DiscoveredProject } from './discover.ts';
import type { LoadedConfig } from './load.ts';
import type { SkillDocument } from './skill.ts';

const sourceDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
): Diagnostic => ({ code, message, severity: 'error', sourcePath });

const hookEvents: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];

const hookTools = new Set(['shell', 'file.read', 'file.write', 'mcp', 'agent']);

const isHookEntryList = (
  input: AgentBundleHookInput,
): input is readonly (string | AgentBundleHookEntry)[] => Array.isArray(input);

const asHookEntries = (input: AgentBundleHookInput): readonly (string | AgentBundleHookEntry)[] =>
  isHookEntryList(input) ? input : [input];

const validateHooks = (loaded: LoadedConfig): Diagnostic[] => {
  const hooks = loaded.config.hooks;
  if (hooks === undefined) return [];

  const diagnostics: Diagnostic[] = [];
  for (const event of hookEvents) {
    const input = hooks[event];
    if (input === undefined) continue;
    for (const rawEntry of asHookEntries(input)) {
      const entry = typeof rawEntry === 'string' ? { handler: rawEntry } : rawEntry;
      if (typeof entry.handler !== 'string' || entry.handler.trim().length === 0) {
        diagnostics.push(sourceDiagnostic(
          'AB4200',
          `Hook ${event} requires a nonempty handler path.`,
          loaded.configPath,
        ));
      }
      if (entry.tools !== undefined && event !== 'beforeTool' && event !== 'afterTool') {
        diagnostics.push(sourceDiagnostic(
          'AB4201',
          `Hook ${event} cannot select tools.`,
          loaded.configPath,
        ));
      }
      for (const tool of entry.tools ?? []) {
        if (!hookTools.has(tool)) {
          diagnostics.push(sourceDiagnostic(
            'AB4202',
            `Hook ${event} selects unknown tool ${JSON.stringify(tool)}.`,
            loaded.configPath,
          ));
        }
      }
      for (const target of entry.targets ?? []) {
        if (typeof target !== 'string' || target.trim().length === 0) {
          diagnostics.push(sourceDiagnostic('AB4203', `Hook ${event} has an invalid target.`, loaded.configPath));
        } else if (target === 'portable') {
          diagnostics.push(sourceDiagnostic(
            'AB4204',
            `Portable target cannot emit hook ${event}.`,
            loaded.configPath,
          ));
        }
      }
      if (
        entry.timeout !== undefined &&
        (!Number.isFinite(entry.timeout) || !Number.isInteger(entry.timeout) || entry.timeout <= 0)
      ) {
        diagnostics.push(sourceDiagnostic(
          'AB4205',
          `Hook ${event} timeout must be a positive whole number of seconds.`,
          loaded.configPath,
        ));
      }
    }
  }
  return diagnostics;
};

const withoutMarkdownCode = (body: string): string => {
  let fence: { character: string; length: number } | undefined;

  return body
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== undefined) {
        if (
          marker !== undefined &&
          marker[0] === fence.character &&
          marker.length >= fence.length
        ) {
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
  if (
    rawReference.startsWith('#') ||
    rawReference.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(rawReference)
  ) {
    return undefined;
  }

  const pathOnly = rawReference.split(/[?#]/, 1)[0];
  if (pathOnly === undefined || pathOnly.length === 0) {
    return undefined;
  }

  try {
    return posix.normalize(decodeURIComponent(pathOnly));
  } catch {
    return posix.normalize(pathOnly);
  }
};

const normalizeReferenceLabel = (label: string): string =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

const referencedResources = (body: string): string[] => {
  const markdown = withoutMarkdownCode(body);
  const references: string[] = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;

  for (const match of markdown.matchAll(linkPattern)) {
    const rawReference = match[1] ?? match[2];
    const path = rawReference === undefined ? undefined : resourcePath(rawReference);
    if (path !== undefined) {
      references.push(path);
    }
  }

  const definitions = new Map<string, string | undefined>();
  const definitionPattern = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const match of markdown.matchAll(definitionPattern)) {
    const label = match[1];
    const rawReference = match[2] ?? match[3];
    if (label === undefined || rawReference === undefined) {
      continue;
    }

    const normalizedLabel = normalizeReferenceLabel(label);
    if (!definitions.has(normalizedLabel)) {
      definitions.set(normalizedLabel, resourcePath(rawReference));
    }
  }

  const markdownWithoutDefinitions = markdown.replace(
    /^ {0,3}\[[^\]]+\]:.*$/gm,
    '',
  );
  const referencePattern = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
  for (const match of markdownWithoutDefinitions.matchAll(referencePattern)) {
    const text = match[1];
    const explicitLabel = match[2];
    const label = explicitLabel === '' ? text : explicitLabel;
    if (label === undefined) {
      continue;
    }

    const path = definitions.get(normalizeReferenceLabel(label));
    if (path !== undefined) {
      references.push(path);
    }
  }

  const shortcutPattern = /!?\[([^\]]+)\](?!\[|\()/g;
  for (const match of markdownWithoutDefinitions.matchAll(shortcutPattern)) {
    const label = match[1];
    if (label === undefined) {
      continue;
    }

    const path = definitions.get(normalizeReferenceLabel(label));
    if (path !== undefined) {
      references.push(path);
    }
  }

  return [...new Set(references)];
};

const validateSkill = (skill: SkillDocument): Diagnostic[] => {
  const diagnostics = [...skill.diagnostics];
  const name = skill.frontmatter.name;
  const description = skill.frontmatter.description;

  if (typeof name !== 'string' || name.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic('AB4002', 'Skill frontmatter must define a nonempty name.', skill.source),
    );
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4003',
        'Skill frontmatter must define a nonempty description.',
        skill.source,
      ),
    );
  }

  if (typeof name === 'string' && name !== basename(skill.dir)) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4004',
        `Skill name ${JSON.stringify(name)} must match directory ${JSON.stringify(basename(skill.dir))}.`,
        skill.source,
      ),
    );
  }

  const resources = new Set(skill.resources.map(({ relativePath }) => relativePath));
  for (const reference of referencedResources(skill.body)) {
    if (!resources.has(reference)) {
      diagnostics.push(
        sourceDiagnostic(
          'AB4005',
          `Skill references missing resource ${JSON.stringify(reference)}.`,
          skill.source,
        ),
      );
    }
  }

  return diagnostics;
};

export const validateSource = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const plugin = loaded.config.plugin as unknown;
  const pluginRecord =
    typeof plugin === 'object' && plugin !== null && !Array.isArray(plugin)
      ? (plugin as Record<string, unknown>)
      : undefined;
  const pluginName = pluginRecord?.name;
  const pluginVersion = pluginRecord?.version;

  if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic('AB4000', 'Plugin metadata must define a nonempty name.', loaded.configPath),
    );
  }
  if (typeof pluginVersion !== 'string' || pluginVersion.trim().length === 0) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4001',
        'Plugin metadata must define a nonempty version.',
        loaded.configPath,
      ),
    );
  }

  const skillNames = new Map<string, string>();
  for (const skill of discovered.skills) {
    diagnostics.push(...validateSkill(skill));

    const name = skill.frontmatter.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      continue;
    }

    const firstSource = skillNames.get(name);
    if (firstSource === undefined) {
      skillNames.set(name, skill.source);
    } else {
      diagnostics.push(
        sourceDiagnostic(
          'AB4006',
          `Skill name ${JSON.stringify(name)} duplicates ${firstSource}.`,
          skill.source,
        ),
      );
    }
  }

  diagnostics.push(...validateHooks(loaded));

  return diagnostics;
};

export const validateModel = (
  model: NormalizedPlugin,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const target of model.targets) {
    if (!registry.has(target.name)) {
      diagnostics.push({
        code: 'AB4100',
        message: `Unknown target ${JSON.stringify(target.name)}.`,
        severity: 'error',
        sourcePath: target.provenance.sourcePath,
        target: target.name,
      });
    }
  }

  const ids = new Map<string, string>();
  const components = [model.metadata, ...model.targets, ...model.skills, ...model.hooks];
  for (const component of components) {
    const firstSource = ids.get(component.id);
    if (firstSource === undefined) {
      ids.set(component.id, component.provenance.sourcePath);
    } else {
      diagnostics.push({
        code: 'AB4101',
        message: `Normalized component ID ${JSON.stringify(component.id)} is duplicated.`,
        severity: 'error',
        sourcePath: component.provenance.sourcePath,
      });
    }
  }

  for (const hook of model.hooks) {
    for (const target of hook.targets) {
      if (!registry.has(target)) {
        diagnostics.push({
          code: 'AB4203',
          message: `Hook ${hook.event} selects unknown target ${JSON.stringify(target)}.`,
          severity: 'error',
          sourcePath: hook.provenance.sourcePath,
          target,
        });
      } else if (target === 'portable') {
        diagnostics.push({
          code: 'AB4204',
          message: `Portable target cannot emit hook ${hook.event}.`,
          severity: 'error',
          sourcePath: hook.provenance.sourcePath,
          target,
        });
      }
    }
  }

  const outputs = new Map<string, string>();
  for (const target of model.targets) {
    for (const skill of model.skills) {
      for (const resource of skill.resources) {
        const generatedPath = posix.join(
          target.name,
          'skills',
          skill.name,
          resource.relativePath,
        );
        const firstSource = outputs.get(generatedPath);
        if (firstSource === undefined) {
          outputs.set(generatedPath, resource.source);
        } else {
          diagnostics.push({
            code: 'AB4102',
            generatedPath,
            message: `Multiple inputs produce ${JSON.stringify(generatedPath)}; first source is ${firstSource}.`,
            severity: 'error',
            sourcePath: resource.source,
            target: target.name,
          });
        }
      }
    }
  }

  return diagnostics;
};
