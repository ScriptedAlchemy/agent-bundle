import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { scanEntryExportsSource } from '../build/entry-exports.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { stableJson } from '../core/digest.ts';
import { unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  developmentFallbackVersion,
  snapshotPackageIdentity,
  type PackageIdentityIssueKind,
} from '../core/project-context.ts';
import {
  defaultGeneratedRuntime,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { canonicalHookEvents, isPrebuiltEntryInput, parseNativeHookToolSelector } from '../core/types.ts';
import type {
  AgentBundleBinEntry,
  AgentBundleHookEntry,
  AgentBundleHookInput,
  AgentBundleLibEntry,
  AgentBundleMcpApp,
  AgentBundleMcpServer,
  AgentBundlePrebuiltEntry,
  AgentBundleScriptInput,
  CanonicalHookEvent,
  NormalizationTargetRegistry,
  NormalizedPlugin,
} from '../core/types.ts';
import {
  artifactDistPathIssue,
  conventionalCliEntrySource,
  conventionalIndexEntrySource,
  conventionalMcpEntrySource,
  isArtifactOutputConfig,
  owningPayload,
  reservedPayloadDestinations,
} from './normalize.ts';
import { type DiscoveredProject, payloadDeclarationEntry, payloadDeclarationSource } from './discover.ts';
import type { LoadedConfig } from './load.ts';
import { configuredScriptNames, judgeScriptRoute, scriptRouteName } from './script-routes.ts';
import type { SkillDocument } from './skill.ts';
import { referencedResources } from './skill-references.ts';
import { validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';
import { parseSkillIr } from '../skills/parse-ir.ts';

const sourceDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
  recovery?: string,
): Diagnostic => ({
  code,
  message,
  ...(recovery === undefined ? {} : { recovery }),
  severity: 'error',
  sourcePath,
});

/**
 * Informational migration nudges (AB4730-AB4735): they surface pre-convention
 * patterns the entry conventions now replace, and they must never gate a
 * build — migrations stay optional, so the severity is always `info`.
 */
const nudgeDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'info', sourcePath });

const hookEvents: readonly CanonicalHookEvent[] = canonicalHookEvents;

const hookTools = new Set(['shell', 'file.read', 'file.write', 'mcp', 'agent']);

const isHookEntryList = (
  input: AgentBundleHookInput,
): input is readonly (string | AgentBundleHookEntry)[] => Array.isArray(input);

const asHookEntries = (input: AgentBundleHookInput): readonly (string | AgentBundleHookEntry)[] =>
  isHookEntryList(input) ? input : [input];

const validateHooks = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
  payloads: readonly DeclaredPayload[],
): Diagnostic[] => {
  const hooks = loaded.config.hooks;
  if (hooks === undefined) return [];
  const selectedTargets = loaded.context.selectedTargets.length > 0
    ? loaded.context.selectedTargets
    : (loaded.config.targets ?? registry.defaultTargetNames());

  const diagnostics: Diagnostic[] = [];
  for (const event of hookEvents) {
    const input = hooks[event];
    if (input === undefined) continue;
    for (const rawEntry of asHookEntries(input)) {
      const entry = typeof rawEntry === 'string' ? { handler: rawEntry } : rawEntry;
      const handler = entry.handler;
      const prebuilt = isPrebuiltEntryInput(handler);
      if (prebuilt) {
        const hookTargets = declaredTargetsOr(
          entry.targets,
          selectedTargets.filter((target) => registry.supports(target, 'hooks')),
        );
        diagnostics.push(...validatePrebuiltReference(
          `Hook ${event}`,
          handler,
          hookTargets,
          loaded,
          payloads,
        ));
      } else if (typeof handler !== 'string' || handler.trim().length === 0) {
        diagnostics.push(sourceDiagnostic(
          'AB4200',
          `Hook ${event} requires a nonempty handler path.`,
          loaded.configPath,
        ));
      }
      if (entry.args !== undefined) {
        if (!prebuilt) {
          diagnostics.push(sourceDiagnostic(
            'AB4746',
            `Hook ${event} declares arguments, but only prebuilt handlers accept arguments.`,
            loaded.configPath,
          ));
        } else if (
          !Array.isArray(entry.args) ||
          entry.args.some((argument) => typeof argument !== 'string' || !safePrebuiltArgumentPattern.test(argument))
        ) {
          diagnostics.push(sourceDiagnostic(
            'AB4746',
            `Hook ${event} arguments must be shell-safe strings (letters, digits, and %+,-./:=@_).`,
            loaded.configPath,
          ));
        }
      }
      if (entry.tools !== undefined && event !== 'beforeTool' && event !== 'afterTool') {
        diagnostics.push(sourceDiagnostic(
          'AB4201',
          `Hook ${event} cannot select tools.`,
          loaded.configPath,
        ));
      }
      for (const tool of entry.tools ?? []) {
        if (hookTools.has(tool)) continue;
        const selector = parseNativeHookToolSelector(tool);
        if (selector === undefined) {
          diagnostics.push(sourceDiagnostic(
            'AB4202',
            `Hook ${event} selects unknown tool ${JSON.stringify(tool)}.`,
            loaded.configPath,
          ));
        } else if (!registry.has(selector.target)) {
          diagnostics.push(sourceDiagnostic(
            'AB4210',
            `Hook ${event} native tool selector ${JSON.stringify(tool)} names unknown target ${JSON.stringify(selector.target)}.`,
            loaded.configPath,
          ));
        } else if (!registry.supports(selector.target, 'hooks')) {
          diagnostics.push(sourceDiagnostic(
            'AB4211',
            `Hook ${event} native tool selector ${JSON.stringify(tool)} names target ${JSON.stringify(selector.target)}, which cannot emit hooks.`,
            loaded.configPath,
          ));
        } else if (!(entry.targets ?? selectedTargets).includes(selector.target)) {
          diagnostics.push(sourceDiagnostic(
            'AB4212',
            `Hook ${event} native tool selector ${JSON.stringify(tool)} names target ${JSON.stringify(selector.target)} outside the hook's selected targets.`,
            loaded.configPath,
          ));
        }
      }
      for (const target of entry.targets ?? []) {
        if (typeof target !== 'string' || target.trim().length === 0) {
          diagnostics.push(sourceDiagnostic('AB4203', `Hook ${event} has an invalid target.`, loaded.configPath));
        } else if (!registry.has(target)) {
          diagnostics.push(sourceDiagnostic(
            'AB4203',
            `Hook ${event} selects unknown target ${JSON.stringify(target)}.`,
            loaded.configPath,
          ));
        } else if (!registry.supports(target, 'hooks')) {
          diagnostics.push(sourceDiagnostic(
            'AB4204',
            `Target ${JSON.stringify(target)} cannot emit hook ${event}.`,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isProtocolJsonValue = (value: unknown, ancestors = new Set<object>()): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || !isProtocolJsonValue(descriptor.value, ancestors)) {
          return false;
        }
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) return false;
        const index = Number(key);
        if (index >= value.length) {
          return false;
        }
      }
      return true;
    }

    if (!isPlainRecord(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !isProtocolJsonValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
};

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** A declared targets restriction when it is a well-shaped string array, otherwise the fallback selection. */
const declaredTargetsOr = (
  targets: unknown,
  fallback: readonly string[],
): readonly string[] =>
  Array.isArray(targets) && targets.every(nonemptyString) ? targets : fallback;

const validateStringList = (
  value: unknown,
  label: string,
  code: string,
  loaded: LoadedConfig,
): Diagnostic[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !nonemptyString(item))) {
    return [sourceDiagnostic(code, `MCP ${label} must be an array of nonempty strings.`, loaded.configPath)];
  }
  return [];
};

const validateStringRecord = (
  value: unknown,
  label: string,
  code: string,
  loaded: LoadedConfig,
): Diagnostic[] => {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => !nonemptyString(key) || typeof item !== 'string')) {
    return [sourceDiagnostic(code, `MCP ${label} must map nonempty string keys to string values.`, loaded.configPath)];
  }
  return [];
};

const validRemoteUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const localEntryExists = (root: string, entry: string): boolean => {
  const source = resolve(root, entry);
  try {
    return existsSync(source) && statSync(source).isFile();
  } catch {
    return false;
  }
};

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(resolve(root), resolve(candidate));
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const scriptExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.sh',
  '.bash',
  '.py',
]);

const bundleScriptExtensions = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);

const isSafeScriptName = (name: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(name);

const validateScripts = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const scripts = loaded.config.scripts;
  if (scripts === undefined) return [];
  if (!isRecord(scripts)) {
    return [sourceDiagnostic('AB4400', 'Scripts configuration must be an object.', loaded.configPath)];
  }

  const diagnostics: Diagnostic[] = [];
  const outputSources = new Map<string, string>();
  for (const [name, rawDeclaration] of Object.entries(scripts)) {
    if (!isSafeScriptName(name)) {
      diagnostics.push(sourceDiagnostic(
        'AB4401',
        `Script name ${JSON.stringify(name)} must be a safe stable output name.`,
        loaded.configPath,
      ));
    }
    if (typeof rawDeclaration !== 'string' && !isRecord(rawDeclaration)) {
      diagnostics.push(sourceDiagnostic(
        'AB4402',
        `Script ${JSON.stringify(name)} must be an entry path or an object with an entry path.`,
        loaded.configPath,
      ));
      continue;
    }
    const declaration = rawDeclaration as AgentBundleScriptInput;
    const entry = typeof declaration === 'string' ? declaration : declaration.entry;
    if (!nonemptyString(entry)) {
      diagnostics.push(sourceDiagnostic(
        'AB4402',
        `Script ${JSON.stringify(name)} entry must be a nonempty path.`,
        loaded.configPath,
      ));
      continue;
    }
    const source = resolve(loaded.context.projectRoot, entry);
    if (!isInside(loaded.context.projectRoot, source)) {
      diagnostics.push(sourceDiagnostic(
        'AB4405',
        `Script ${JSON.stringify(name)} entry must resolve inside the project root.`,
        loaded.configPath,
      ));
      continue;
    }
    if (!scriptExtensions.has(extname(source).toLowerCase())) {
      diagnostics.push(sourceDiagnostic(
        'AB4403',
        `Script ${JSON.stringify(name)} entry has an unsupported extension.`,
        loaded.configPath,
      ));
    } else {
      const extension = extname(source).toLowerCase();
      const output = posix.normalize(
        `scripts/${name}${bundleScriptExtensions.has(extension) ? '.mjs' : extension}`,
      );
      const firstSource = outputSources.get(output);
      if (firstSource === undefined) {
        outputSources.set(output, source);
      } else {
        diagnostics.push(sourceDiagnostic(
          'AB4408',
          `Scripts ${JSON.stringify(firstSource)} and ${JSON.stringify(source)} share canonical output ${JSON.stringify(output)}.`,
          loaded.configPath,
        ));
      }
    }
    try {
      const canonicalRoot = realpathSync(loaded.context.projectRoot);
      const canonicalSource = realpathSync(source);
      if (!isInside(canonicalRoot, canonicalSource)) {
        diagnostics.push(sourceDiagnostic(
          'AB4405',
          `Script ${JSON.stringify(name)} entry must resolve inside the project root.`,
          loaded.configPath,
        ));
      } else if (!statSync(canonicalSource).isFile()) {
        diagnostics.push(sourceDiagnostic(
          'AB4404',
          `Script ${JSON.stringify(name)} entry must name an existing regular file.`,
          loaded.configPath,
        ));
      }
    } catch {
      diagnostics.push(sourceDiagnostic(
        'AB4404',
        `Script ${JSON.stringify(name)} entry must name an existing regular file.`,
        loaded.configPath,
      ));
    }
    if (typeof declaration !== 'string' && declaration.targets !== undefined) {
      if (!Array.isArray(declaration.targets) || declaration.targets.some((target) => !nonemptyString(target))) {
        diagnostics.push(sourceDiagnostic(
          'AB4407',
          `Script ${JSON.stringify(name)} targets must be an array of nonempty strings.`,
          loaded.configPath,
        ));
      } else {
        for (const target of declaration.targets) {
          if (!registry.has(target)) {
            diagnostics.push(sourceDiagnostic(
              'AB4406',
              `Script ${JSON.stringify(name)} selects unknown target ${JSON.stringify(target)}.`,
              loaded.configPath,
            ));
          }
        }
      }
    }
  }
  return diagnostics;
};

const validUiUri = (value: string): boolean => {
  try {
    const uri = new URL(value);
    return uri.protocol === 'ui:' && uri.hostname.length > 0;
  } catch {
    return false;
  }
};

/**
 * The declaration identity that lets several servers share one app name as
 * one compiled app. Targets stay out of it: each declaring server selects
 * its own hosts for the shared output.
 */
const mcpAppIdentity = (app: AgentBundleMcpApp): string | undefined => {
  try {
    return stableJson({
      ...(app._meta === undefined ? {} : { _meta: app._meta }),
      entry: app.entry,
      resourceUri: app.resourceUri,
      ...(app.template === undefined ? {} : { template: app.template }),
    });
  } catch {
    // Non-JSON _meta is separately rejected by AB4338; never treat it as shareable.
    return undefined;
  }
};

const validateMcpApps = (
  name: string,
  server: AgentBundleMcpServer,
  loaded: LoadedConfig,
  seenApps: Map<string, string | undefined>,
  seenUris: Map<string, string>,
): Diagnostic[] => {
  if (server.apps === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  const hasLocalEntry = server.entry !== undefined || (
    server.command === undefined && server.url === undefined &&
    conventionalMcpEntrySource(loaded.context.projectRoot, name) !== undefined
  );
  if (!hasLocalEntry) {
    diagnostics.push(sourceDiagnostic(
      'AB4322',
      `MCP server ${JSON.stringify(name)} can declare Apps only with a local entry.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  if (!isRecord(server.apps)) {
    diagnostics.push(sourceDiagnostic(
      'AB4323',
      `MCP server ${JSON.stringify(name)} Apps must be an object.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  for (const [appName, value] of Object.entries(server.apps)) {
    const identity = isRecord(value) ? mcpAppIdentity(value as AgentBundleMcpApp) : undefined;
    if (!/^[a-z][a-z0-9-]*$/u.test(appName)) {
      diagnostics.push(sourceDiagnostic(
        'AB4324',
        `MCP App name ${JSON.stringify(appName)} must use stable lowercase kebab-case.`,
        loaded.configPath,
      ));
    } else if (seenApps.has(appName) && (identity === undefined || seenApps.get(appName) !== identity)) {
      diagnostics.push(sourceDiagnostic(
        'AB4325',
        `MCP App name ${JSON.stringify(appName)} is duplicated with a conflicting definition; `
        + 'servers may share an app name only with an identical declaration.',
        loaded.configPath,
      ));
    }
    if (!seenApps.has(appName)) seenApps.set(appName, identity);
    if (!isRecord(value)) {
      diagnostics.push(sourceDiagnostic(
        'AB4326',
        `MCP App ${JSON.stringify(appName)} must be an object.`,
        loaded.configPath,
      ));
      continue;
    }
    const app = value as AgentBundleMcpApp;
    if (!nonemptyString(app.entry)) {
      diagnostics.push(sourceDiagnostic(
        'AB4327',
        `MCP App ${JSON.stringify(appName)} entry must be a nonempty path.`,
        loaded.configPath,
      ));
    } else if (!localEntryExists(loaded.context.projectRoot, app.entry)) {
      diagnostics.push(sourceDiagnostic(
        'AB4328',
        `MCP App ${JSON.stringify(appName)} entry does not exist.`,
        loaded.configPath,
      ));
    }
    if (!nonemptyString(app.resourceUri) || !validUiUri(app.resourceUri)) {
      diagnostics.push(sourceDiagnostic(
        'AB4329',
        `MCP App ${JSON.stringify(appName)} resourceUri must use ui:// with a nonempty host.`,
        loaded.configPath,
      ));
    } else if (seenUris.has(app.resourceUri) && seenUris.get(app.resourceUri) !== appName) {
      diagnostics.push(sourceDiagnostic(
        'AB4330',
        `MCP App resourceUri ${JSON.stringify(app.resourceUri)} is declared by more than one app name.`,
        loaded.configPath,
      ));
    }
    if (typeof app.resourceUri === 'string' && !seenUris.has(app.resourceUri)) {
      seenUris.set(app.resourceUri, appName);
    }
    if (app.template !== undefined) {
      if (!nonemptyString(app.template)) {
        diagnostics.push(sourceDiagnostic(
          'AB4331',
          `MCP App ${JSON.stringify(appName)} template must be a nonempty HTML path.`,
          loaded.configPath,
        ));
      } else if (!/\.html?$/iu.test(app.template) || !localEntryExists(loaded.context.projectRoot, app.template)) {
        diagnostics.push(sourceDiagnostic(
          'AB4332',
          `MCP App ${JSON.stringify(appName)} template must name an existing HTML file.`,
          loaded.configPath,
        ));
      }
    }
    diagnostics.push(...validateStringList(app.targets, 'App targets', 'AB4333', loaded));
    for (const target of app.targets ?? []) {
      if (server.targets !== undefined && !server.targets.includes(target)) {
        diagnostics.push(sourceDiagnostic(
          'AB4334',
          `MCP App ${JSON.stringify(appName)} selects target ${JSON.stringify(target)} outside its owning server.`,
          loaded.configPath,
        ));
      }
    }
    if (app._meta !== undefined && !isRecord(app._meta)) {
      diagnostics.push(sourceDiagnostic(
        'AB4335',
        `MCP App ${JSON.stringify(appName)} _meta must be an object.`,
        loaded.configPath,
      ));
    } else if (app._meta !== undefined && !isProtocolJsonValue(app._meta)) {
      diagnostics.push(sourceDiagnostic(
        'AB4338',
        `MCP App ${JSON.stringify(appName)} _meta must contain only JSON data.`,
        loaded.configPath,
      ));
    }
  }
  return diagnostics;
};

const relativePosix = (root: string, path: string): string =>
  relative(root, path).replaceAll('\\', '/');

/**
 * AB4730: a local stdio entry whose module never default-exports a factory
 * is self-connecting, so the build cannot wrap it in the framework stdio
 * lifecycle shell. The detection is the same static export scan the build
 * uses to decide the wrap, so the nudge and the build always agree.
 */
const selfConnectingEntryNudge = (
  name: string,
  entry: string | undefined,
  conventionalEntry: string | undefined,
  loaded: LoadedConfig,
): Diagnostic[] => {
  const source = entry !== undefined
    ? nonemptyString(entry) && localEntryExists(loaded.context.projectRoot, entry)
      ? resolve(loaded.context.projectRoot, entry)
      : undefined
    : conventionalEntry;
  if (source === undefined || !bundleScriptExtensions.has(extname(source).toLowerCase())) return [];
  try {
    if (scanEntryExportsSource(readFileSync(source, 'utf8')).hasDefaultExport) return [];
  } catch {
    // An unreadable entry is already reported by the existence diagnostics.
    return [];
  }
  return [nudgeDiagnostic(
    'AB4730',
    `MCP server ${JSON.stringify(name)} stdio entry is self-connecting; a default-exported server factory would receive the framework stdio lifecycle shell.`,
    source,
    'Optional: default-export a server factory from the entry module to adopt the framework lifecycle; self-connecting entries keep their current behavior.',
  )];
};

const validateMcpServer = (
  name: string,
  value: unknown,
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
  payloads: readonly DeclaredPayload[],
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (!nonemptyString(name)) {
    diagnostics.push(sourceDiagnostic('AB4302', 'MCP server names must be nonempty.', loaded.configPath));
  }
  if (!isRecord(value)) {
    diagnostics.push(sourceDiagnostic('AB4303', `MCP server ${JSON.stringify(name)} must be an object.`, loaded.configPath));
    return diagnostics;
  }
  const server = value as AgentBundleMcpServer;
  const entry = server.entry;
  const command = server.command;
  const url = server.url;
  const variants = [entry, command, url].filter((candidate) => candidate !== undefined);
  const conventionalEntry = variants.length === 0
    ? conventionalMcpEntrySource(loaded.context.projectRoot, name)
    : undefined;
  if (variants.length !== 1 && conventionalEntry === undefined) {
    diagnostics.push(sourceDiagnostic(
      'AB4304',
      `MCP server ${JSON.stringify(name)} must define exactly one of entry, command, or url, `
      + `or provide the conventional stdio entry src/mcp/${name}.ts.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  if (variants.length > 1) {
    diagnostics.push(sourceDiagnostic(
      'AB4304',
      `MCP server ${JSON.stringify(name)} must define exactly one of entry, command, or url.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  if (variants.length === 1) {
    const shadowed = conventionalMcpEntrySource(loaded.context.projectRoot, name);
    if (
      shadowed !== undefined &&
      !(typeof entry === 'string' && entry.trim().length > 0 && resolve(loaded.context.projectRoot, entry) === shadowed)
    ) {
      diagnostics.push(nudgeDiagnostic(
        'AB4733',
        `MCP server ${JSON.stringify(name)} has the conventional stdio entry ${JSON.stringify(relativePosix(loaded.context.projectRoot, shadowed))}, but explicit configuration points elsewhere; the conventional file is shadowed.`,
        shadowed,
        'Optional: drop the explicit entry, command, or url to adopt the conventional stdio entry, or remove the shadowed file to silence this nudge.',
      ));
    }
  }
  diagnostics.push(...validateStringList(server.targets, 'targets', 'AB4305', loaded));

  if (entry !== undefined || conventionalEntry !== undefined) {
    if (isPrebuiltEntryInput(entry)) {
      const serverTargets = declaredTargetsOr(server.targets, selectedTargetNamesFor(loaded, registry));
      diagnostics.push(...validatePrebuiltReference(
        `MCP server ${JSON.stringify(name)}`,
        entry,
        serverTargets,
        loaded,
        payloads,
      ));
    } else if (entry !== undefined && !nonemptyString(entry)) {
      diagnostics.push(sourceDiagnostic('AB4306', `MCP server ${JSON.stringify(name)} entry must be a nonempty path.`, loaded.configPath));
    } else if (entry !== undefined && !localEntryExists(loaded.context.projectRoot, entry)) {
      diagnostics.push(sourceDiagnostic('AB4307', `MCP server ${JSON.stringify(name)} entry does not exist.`, loaded.configPath));
    }
    if (server.transport !== undefined && server.transport !== 'stdio') {
      diagnostics.push(sourceDiagnostic('AB4308', `MCP server ${JSON.stringify(name)} entry must use stdio transport.`, loaded.configPath));
    }
    if (server.cwd !== undefined) {
      diagnostics.push(sourceDiagnostic('AB4309', `MCP server ${JSON.stringify(name)} local entry cannot set cwd.`, loaded.configPath));
    }
    if (server.headers !== undefined) {
      diagnostics.push(sourceDiagnostic('AB4310', `MCP server ${JSON.stringify(name)} stdio server cannot set headers.`, loaded.configPath));
    }
    diagnostics.push(...validateStringList(server.args, 'args', 'AB4311', loaded));
    diagnostics.push(...validateStringRecord(server.env, 'env', 'AB4312', loaded));
    if (!isPrebuiltEntryInput(entry)) {
      diagnostics.push(...selfConnectingEntryNudge(name, entry, conventionalEntry, loaded));
    }
    return diagnostics;
  }

  if (command !== undefined) {
    if (!nonemptyString(command)) {
      diagnostics.push(sourceDiagnostic('AB4313', `MCP server ${JSON.stringify(name)} command must be nonempty.`, loaded.configPath));
    }
    if (server.transport !== undefined && server.transport !== 'stdio') {
      diagnostics.push(sourceDiagnostic('AB4314', `MCP server ${JSON.stringify(name)} command must use stdio transport.`, loaded.configPath));
    }
    if (server.cwd !== undefined && !nonemptyString(server.cwd)) {
      diagnostics.push(sourceDiagnostic('AB4315', `MCP server ${JSON.stringify(name)} cwd must be a nonempty path.`, loaded.configPath));
    }
    if (server.headers !== undefined) {
      diagnostics.push(sourceDiagnostic('AB4310', `MCP server ${JSON.stringify(name)} stdio server cannot set headers.`, loaded.configPath));
    }
    diagnostics.push(...validateStringList(server.args, 'args', 'AB4311', loaded));
    diagnostics.push(...validateStringRecord(server.env, 'env', 'AB4312', loaded));
    return diagnostics;
  }

  if (!nonemptyString(url) || !validRemoteUrl(url)) {
    diagnostics.push(sourceDiagnostic('AB4316', `MCP server ${JSON.stringify(name)} URL must be a valid HTTP URL.`, loaded.configPath));
  }
  if (server.transport !== 'streamable-http') {
    diagnostics.push(sourceDiagnostic('AB4317', `MCP server ${JSON.stringify(name)} URL requires streamable-http transport.`, loaded.configPath));
  }
  if (server.args !== undefined || server.env !== undefined || server.cwd !== undefined) {
    diagnostics.push(sourceDiagnostic('AB4318', `MCP server ${JSON.stringify(name)} remote server cannot set stdio options.`, loaded.configPath));
  }
  diagnostics.push(...validateStringRecord(server.headers, 'headers', 'AB4319', loaded));
  return diagnostics;
};

const validatePluginLogo = (
  loaded: LoadedConfig,
  pluginRecord: Record<string, unknown> | undefined,
): Diagnostic[] => {
  if (pluginRecord === undefined || !Object.hasOwn(pluginRecord, 'logo')) return [];
  const declared = pluginRecord.logo;
  const recovery = 'Set plugin.logo to an existing file inside the project root, or omit the field.';
  const fail = (message: string): Diagnostic => ({
    code: 'AB4012',
    message,
    recovery,
    severity: 'error',
    sourcePath: loaded.configPath,
  });
  if (typeof declared !== 'string' || declared.trim().length === 0) {
    return [fail('Plugin logo must be a nonempty path to an existing file inside the project.')];
  }
  const source = resolve(loaded.context.projectRoot, declared);
  if (!isInside(loaded.context.projectRoot, source) || resolve(loaded.context.projectRoot) === source) {
    return [fail(`Plugin logo ${JSON.stringify(declared)} must resolve inside the project root.`)];
  }
  if (!localEntryExists(loaded.context.projectRoot, declared)) {
    return [fail(`Plugin logo ${JSON.stringify(declared)} must name an existing file.`)];
  }
  return [];
};

const validateAssets = (loaded: LoadedConfig): Diagnostic[] => {
  const assets = loaded.config.assets;
  if (assets === undefined) return [];
  if (!Array.isArray(assets) || assets.some((entry) => !nonemptyString(entry))) {
    return [sourceDiagnostic('AB4600', 'Assets configuration must be an array of nonempty paths or globs.', loaded.configPath)];
  }
  const diagnostics: Diagnostic[] = [];
  for (const entry of assets) {
    const source = resolve(loaded.context.projectRoot, entry);
    if (!isInside(loaded.context.projectRoot, source)) {
      diagnostics.push(sourceDiagnostic(
        'AB4601',
        `Asset entry ${JSON.stringify(entry)} must resolve inside the project root.`,
        loaded.configPath,
      ));
      continue;
    }
    if (!/[*?{[\]()!]/u.test(entry) && !existsSync(source)) {
      diagnostics.push(sourceDiagnostic(
        'AB4602',
        `Asset entry ${JSON.stringify(entry)} must name an existing file or directory.`,
        loaded.configPath,
      ));
    }
  }
  return diagnostics;
};

const validateRuntime = (loaded: LoadedConfig): Diagnostic[] => {
  const runtime = loaded.config.runtime;
  if (runtime === undefined) return [];
  if (!isRecord(runtime) || !isPlainRecord(runtime)) {
    return [sourceDiagnostic('AB4600', 'Runtime configuration must be an object.', loaded.configPath)];
  }
  const keys = Object.keys(runtime);
  if (keys.length !== 1 || keys[0] !== 'node') {
    return [sourceDiagnostic(
      'AB4600',
      'Runtime configuration must contain exactly one node version.',
      loaded.configPath,
    )];
  }
  const node = runtime.node;
  const version = typeof node === 'string' ? parseRuntimeVersion(node) : undefined;
  if (version === undefined) {
    return [sourceDiagnostic(
      'AB4601',
      'Runtime node floor must be a version string such as "22.16" or "24.0.0".',
      loaded.configPath,
    )];
  }
  if (!satisfiesGeneratedRuntimeFloor(version)) {
    return [sourceDiagnostic(
      'AB4602',
      `Runtime node floor ${JSON.stringify(node)} cannot lower the Node.js ${defaultGeneratedRuntime.node} default.`,
      loaded.configPath,
    )];
  }
  return [];
};

const validateMcp = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
  payloads: readonly DeclaredPayload[],
): Diagnostic[] => {
  const mcp = loaded.config.mcp;
  if (mcp === undefined) return [];
  if (!isRecord(mcp)) {
    return [sourceDiagnostic('AB4300', 'MCP configuration must be an object.', loaded.configPath)];
  }
  if (!isRecord(mcp.servers)) {
    return [sourceDiagnostic('AB4301', 'MCP configuration must define a servers object.', loaded.configPath)];
  }
  const names = new Map<string, string | undefined>();
  const uris = new Map<string, string>();
  return Object.entries(mcp.servers).flatMap(([name, server]) => {
    const diagnostics = validateMcpServer(name, server, loaded, registry, payloads);
    return isRecord(server)
      ? [...diagnostics, ...validateMcpApps(name, server as AgentBundleMcpServer, loaded, names, uris)]
      : diagnostics;
  });
};

const validateSkill = (skill: SkillDocument): Diagnostic[] => {
  const portableIssues = validateAgentSkillsFrontmatter({
    ...(Object.hasOwn(skill.frontmatter, 'allowed-tools')
      ? { 'allowed-tools': skill.frontmatter['allowed-tools'] }
      : {}),
    ...(Object.hasOwn(skill.frontmatter, 'compatibility')
      ? { compatibility: skill.frontmatter.compatibility }
      : {}),
    ...(Object.hasOwn(skill.frontmatter, 'description')
      ? { description: skill.frontmatter.description }
      : {}),
    ...(Object.hasOwn(skill.frontmatter, 'license')
      ? { license: skill.frontmatter.license }
      : {}),
    ...(Object.hasOwn(skill.frontmatter, 'metadata')
      ? { metadata: skill.frontmatter.metadata }
      : {}),
    ...(Object.hasOwn(skill.frontmatter, 'name')
      ? { name: skill.frontmatter.name }
      : {}),
  });
  const ir = parseSkillIr(skill);
  const diagnostics = [...ir.diagnostics];
  const name = ir.portable.name ?? skill.frontmatter.name;

  diagnostics.push(...portableIssues.map((issue) => {
    const location = issue.field ?? (issue.instancePath === '' ? 'root' : issue.instancePath);
    return sourceDiagnostic(
      issue.field === 'name' ? 'AB4002' : issue.field === 'description' ? 'AB4003' : 'AB4007',
      `Skill frontmatter ${location} ${issue.message}.`,
      skill.source,
    );
  }));

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

const validateCommands = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const selectedTargets = selectedTargetNamesFor(loaded, registry);
  const names = new Map<string, string>();

  for (const command of discovered.commands ?? []) {
    diagnostics.push(...command.diagnostics);
    const name = basename(command.source, extname(command.source));
    const firstSource = names.get(name);
    if (firstSource === undefined) {
      names.set(name, command.source);
    } else {
      diagnostics.push(sourceDiagnostic(
        'AB4926',
        `Command name ${JSON.stringify(name)} duplicates ${firstSource}.`,
        command.source,
      ));
    }

    for (const target of command.authoredTargets ?? []) {
      if (!registry.has(target) || !selectedTargets.includes(target)) {
        diagnostics.push({
          code: 'AB4924',
          message: `Command ${JSON.stringify(name)} selects target ${JSON.stringify(target)} outside the selected target names.`,
          severity: 'error',
          sourcePath: command.source,
          target,
        });
        continue;
      }
      const capability = registry.capabilityState?.(target, 'commands');
      if (capability === undefined) {
        if (registry.supports(target, 'commands')) continue;
        diagnostics.push({
          code: 'AB4925',
          message: `Command ${JSON.stringify(name)} explicitly targets ${JSON.stringify(target)}, whose commands capability is unavailable: the target declares no supported commands surface.`,
          severity: 'error',
          sourcePath: command.source,
          target,
        });
        continue;
      }
      switch (capability.state) {
        case 'supported':
          break;
        case 'degraded':
        case 'prohibited':
        case 'unavailable':
          diagnostics.push({
            code: 'AB4925',
            message: `Command ${JSON.stringify(name)} explicitly targets ${JSON.stringify(target)}, whose commands capability is ${capability.state}: ${capability.reason}`,
            severity: 'error',
            sourcePath: command.source,
            target,
          });
          break;
        default: {
          const exhaustive: never = capability;
          return exhaustive;
        }
      }
    }
  }
  return diagnostics;
};

const validateRules = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const selectedTargets = selectedTargetNamesFor(loaded, registry);
  const names = new Map<string, string>();

  for (const rule of discovered.rules ?? []) {
    diagnostics.push(...rule.diagnostics);
    const name = basename(rule.source, extname(rule.source));
    const firstSource = names.get(name);
    if (firstSource === undefined) {
      names.set(name, rule.source);
    } else {
      diagnostics.push(sourceDiagnostic(
        'AB4906',
        `Rule name ${JSON.stringify(name)} duplicates ${firstSource}.`,
        rule.source,
      ));
    }

    for (const target of rule.authoredTargets ?? []) {
      if (!registry.has(target) || !selectedTargets.includes(target)) {
        diagnostics.push({
          code: 'AB4904',
          message: `Rule ${JSON.stringify(name)} selects target ${JSON.stringify(target)} outside the selected target names.`,
          severity: 'error',
          sourcePath: rule.source,
          target,
        });
        continue;
      }
      const capability = registry.capabilityState?.(target, 'rules');
      if (capability === undefined) {
        if (registry.supports(target, 'rules')) continue;
        diagnostics.push({
          code: 'AB4905',
          message: `Rule ${JSON.stringify(name)} explicitly targets ${JSON.stringify(target)}, whose rules capability is unavailable: the target declares no supported rules surface.`,
          severity: 'error',
          sourcePath: rule.source,
          target,
        });
        continue;
      }
      switch (capability.state) {
        case 'supported':
          break;
        case 'degraded':
        case 'prohibited':
        case 'unavailable':
          diagnostics.push({
            code: 'AB4905',
            message: `Rule ${JSON.stringify(name)} explicitly targets ${JSON.stringify(target)}, whose rules capability is ${capability.state}: ${capability.reason}`,
            severity: 'error',
            sourcePath: rule.source,
            target,
          });
          break;
        default: {
          const exhaustive: never = capability;
          return exhaustive;
        }
      }
    }
  }
  return diagnostics;
};

const isSafePackageOutputName = (name: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(name);

const validatePackageEntryPath = (
  label: string,
  entry: unknown,
  code: { readonly empty: string; readonly extension: string; readonly missing: string; readonly outside: string },
  loaded: LoadedConfig,
): Diagnostic[] => {
  if (!nonemptyString(entry)) {
    return [sourceDiagnostic(code.empty, `${label} entry must be a nonempty path.`, loaded.configPath)];
  }
  const source = resolve(loaded.context.projectRoot, entry);
  if (!isInside(loaded.context.projectRoot, source)) {
    return [sourceDiagnostic(code.outside, `${label} entry must resolve inside the project root.`, loaded.configPath)];
  }
  const diagnostics: Diagnostic[] = [];
  if (!bundleScriptExtensions.has(extname(source).toLowerCase())) {
    diagnostics.push(sourceDiagnostic(code.extension, `${label} entry has an unsupported extension.`, loaded.configPath));
  }
  if (!localEntryExists(loaded.context.projectRoot, entry)) {
    diagnostics.push(sourceDiagnostic(code.missing, `${label} entry must name an existing regular file.`, loaded.configPath));
  }
  return diagnostics;
};

const validateBin = (loaded: LoadedConfig): Diagnostic[] => {
  const bin = loaded.config.bin;
  if (bin === undefined || bin === false) return [];
  if (!isRecord(bin)) {
    return [sourceDiagnostic('AB4700', 'Bin configuration must be false or an object of bin entries.', loaded.configPath)];
  }
  const diagnostics: Diagnostic[] = [];
  for (const [name, rawDeclaration] of Object.entries(bin)) {
    if (!isSafePackageOutputName(name)) {
      diagnostics.push(sourceDiagnostic(
        'AB4701',
        `Bin name ${JSON.stringify(name)} must be a safe stable output name.`,
        loaded.configPath,
      ));
    }
    if (typeof rawDeclaration !== 'string' && !isRecord(rawDeclaration)) {
      diagnostics.push(sourceDiagnostic(
        'AB4702',
        `Bin ${JSON.stringify(name)} must be an entry path or an object with an entry path.`,
        loaded.configPath,
      ));
      continue;
    }
    const declaration = rawDeclaration as string | AgentBundleBinEntry;
    diagnostics.push(...validatePackageEntryPath(
      `Bin ${JSON.stringify(name)}`,
      typeof declaration === 'string' ? declaration : declaration.entry,
      { empty: 'AB4702', extension: 'AB4704', missing: 'AB4705', outside: 'AB4703' },
      loaded,
    ));
  }
  return diagnostics;
};

const outputShapeRecovery =
  'Declare output.distPath as a non-empty project-root-relative path string or remove the output block.';
const outputPathRecovery =
  'Use a project-root-contained relative POSIX path; pass the CLI --output flag for per-invocation absolute locations.';
const outputReservedRecovery =
  'Choose a directory outside the framework, VCS, dependency, and source namespaces.';

const validateOutput = (loaded: LoadedConfig): Diagnostic[] => {
  if (!Object.hasOwn(loaded.config, 'output')) return [];
  const output = loaded.config.output as unknown;
  if (!isArtifactOutputConfig(output)) {
    return [sourceDiagnostic(
      'AB4707',
      'Output configuration must be an object with an optional distPath string.',
      loaded.configPath,
      outputShapeRecovery,
    )];
  }
  if (!Object.hasOwn(output, 'distPath')) return [];
  const distPath = output.distPath;
  const issue = artifactDistPathIssue(distPath);
  switch (issue) {
    case undefined:
      return [];
    case 'shape':
      return [sourceDiagnostic(
        'AB4707',
        'Output distPath must be a non-empty string when declared.',
        loaded.configPath,
        outputShapeRecovery,
      )];
    case 'path':
      return [sourceDiagnostic(
        'AB4708',
        `Output distPath ${JSON.stringify(distPath)} must be a project-root-contained relative POSIX path without backslashes, ".." traversal, or empty segments, and cannot resolve to the project root.`,
        loaded.configPath,
        outputPathRecovery,
      )];
    case 'reserved': {
      const firstSegment = (distPath as string).split('/')[0]!;
      return [sourceDiagnostic(
        'AB4709',
        `Output distPath ${JSON.stringify(distPath)} uses reserved first path segment ${JSON.stringify(firstSegment)}.`,
        loaded.configPath,
        outputReservedRecovery,
      )];
    }
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
};

const validateEventRoutes = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  const selectedTargets = loaded.context.selectedTargets.length > 0
    ? loaded.context.selectedTargets
    : (loaded.config.targets ?? registry.defaultTargetNames());
  const diagnostics: Diagnostic[] = [];

  for (const route of discovered.routeGraph?.events ?? []) {
    const declaredTargets = route.config['targets'];
    if (
      declaredTargets !== undefined &&
      (!Array.isArray(declaredTargets) ||
        declaredTargets.length === 0 ||
        declaredTargets.some((target) => typeof target !== 'string' || target.trim().length === 0))
    ) {
      diagnostics.push(sourceDiagnostic(
        'AB4825',
        `Event route ${route.provenance.relativePath} config.targets must be a nonempty array of target names.`,
        route.source,
      ));
      continue;
    }
    const targets = declaredTargets === undefined
      ? selectedTargets
      : [...new Set(declaredTargets as readonly string[])];
    for (const target of targets) {
      if (!registry.has(target)) {
        diagnostics.push({
          code: 'AB4824',
          message: `Event route ${route.provenance.relativePath} selects unknown target ${JSON.stringify(target)}.`,
          severity: 'error',
          sourcePath: route.source,
          target,
        });
        continue;
      }
      const capabilityName = `event:${route.event}`;
      const capability = registry.capabilityState?.(target, capabilityName);
      if (capability === undefined) {
        if (registry.supports(target, capabilityName)) continue;
        diagnostics.push({
          code: 'AB4824',
          message: `Event route ${route.provenance.relativePath} requires ${capabilityName}, unavailable on ${target}.`,
          severity: 'error',
          sourcePath: route.source,
          target,
        });
        continue;
      }
      switch (capability.state) {
        case 'supported':
        case 'degraded':
          break;
        case 'unavailable':
        case 'prohibited':
          diagnostics.push({
            code: 'AB4824',
            message: `Event route ${route.provenance.relativePath} requires ${capabilityName}, ${capability.state} on ${target}: ${capability.reason}`,
            severity: 'error',
            sourcePath: route.source,
            target,
          });
          break;
        default: {
          const exhaustive: never = capability;
          return exhaustive;
        }
      }
    }
  }
  return diagnostics;
};

const validateLib = (loaded: LoadedConfig): Diagnostic[] => {
  const lib = loaded.config.lib;
  if (lib === undefined || lib === false) return [];
  if (typeof lib !== 'string' && !isRecord(lib)) {
    return [sourceDiagnostic('AB4710', 'Lib configuration must be false, an entry path, or an object with an entry path.', loaded.configPath)];
  }
  const declaration = lib as string | AgentBundleLibEntry;
  const diagnostics = validatePackageEntryPath(
    'Lib',
    typeof declaration === 'string' ? declaration : declaration.entry,
    { empty: 'AB4711', extension: 'AB4713', missing: 'AB4714', outside: 'AB4712' },
    loaded,
  );
  if (typeof declaration !== 'string' && declaration.dts !== undefined && typeof declaration.dts !== 'boolean') {
    diagnostics.push(sourceDiagnostic('AB4715', 'Lib dts must be a boolean.', loaded.configPath));
  }
  return diagnostics;
};

/**
 * AB4731 / AB4732: a conventional package entry file exists but explicit
 * `bin` / `lib` configuration never references it, so the convention is
 * silently shadowed — a confusable state worth one informational nudge.
 * `bin: false` / `lib: false` are deliberate opt-outs and stay silent.
 */
const packageConventionShadowNudges = (loaded: LoadedConfig): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const root = loaded.context.projectRoot;

  const bin = loaded.config.bin;
  if (bin !== undefined && bin !== false && isRecord(bin)) {
    const conventional = conventionalCliEntrySource(root);
    const referenced = conventional !== undefined && Object.values(bin).some((declaration) => {
      const entry = typeof declaration === 'string'
        ? declaration
        : isRecord(declaration) ? (declaration as AgentBundleBinEntry).entry : undefined;
      return nonemptyString(entry) && resolve(root, entry) === conventional;
    });
    if (conventional !== undefined && !referenced) {
      diagnostics.push(nudgeDiagnostic(
        'AB4731',
        `${relativePosix(root, conventional)} is present but explicit bin configuration does not reference it; the conventional package bin is shadowed.`,
        conventional,
        'Optional: remove the explicit bin configuration to adopt the src/cli.ts convention, reference the file from a bin entry, or remove the file to silence this nudge.',
      ));
    }
  }

  const lib = loaded.config.lib;
  if (lib !== undefined && lib !== false && (typeof lib === 'string' || isRecord(lib))) {
    const conventional = conventionalIndexEntrySource(root);
    const entry = typeof lib === 'string' ? lib : (lib as AgentBundleLibEntry).entry;
    if (
      conventional !== undefined &&
      !(nonemptyString(entry) && resolve(root, entry) === conventional)
    ) {
      diagnostics.push(nudgeDiagnostic(
        'AB4732',
        `${relativePosix(root, conventional)} is present but explicit lib configuration does not reference it; the conventional library entry is shadowed.`,
        conventional,
        'Optional: remove the explicit lib configuration to adopt the src/index.ts convention, point it at the file, or remove the file to silence this nudge.',
      ));
    }
  }

  return diagnostics;
};

const warningDiagnostic = (
  code: string,
  message: string,
  sourcePath: string,
  recovery: string,
): Diagnostic => ({ code, message, recovery, severity: 'warning', sourcePath });

const isSafePayloadName = (name: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(name);

interface DeclaredPayload {
  readonly name: string;
  /** Absolute source directory. */
  readonly source: string;
  readonly targets: readonly string[];
}

const selectedTargetNamesFor = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): readonly string[] => loaded.context.selectedTargets.length > 0
  ? loaded.context.selectedTargets
  : (loaded.config.targets ?? registry.defaultTargetNames());

/** Well-shaped payload declarations; malformed entries are reported by validatePayload and skipped here. */
const declaredPayloads = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): readonly DeclaredPayload[] => {
  const configured = loaded.config.payload;
  if (configured === undefined || !isRecord(configured)) return [];
  const selectedTargets = selectedTargetNamesFor(loaded, registry);
  const payloads: DeclaredPayload[] = [];
  for (const [name, declaration] of Object.entries(configured)) {
    const source = payloadDeclarationSource(loaded.context.projectRoot, declaration);
    if (source === undefined) continue;
    const targets = typeof declaration === 'string' ? undefined : declaration.targets;
    payloads.push({
      name,
      source,
      targets: declaredTargetsOr(targets, selectedTargets),
    });
  }
  return payloads;
};

const directoryHasFiles = (source: string): boolean => {
  try {
    const entries = readdirSync(source, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() || (entry.isDirectory() && directoryHasFiles(resolve(source, entry.name))));
  } catch {
    return false;
  }
};

const newestFileMtime = (root: string, skipDirectory: (name: string) => boolean): number => {
  let newest = 0;
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // A racing deletion never fails validation.
      }
    }
  };
  visit(root);
  return newest;
};

const ignoredSourceDirectoryNames = new Set(['.agent-bundle', '.git', 'dist', 'node_modules']);

/** AB4740: one payload declaration's optional `targets` restriction. */
const payloadTargetDiagnostics = (
  name: string,
  targets: unknown,
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
  if (targets === undefined) return [];
  if (!Array.isArray(targets) || !targets.every(nonemptyString)) {
    return [sourceDiagnostic(
      'AB4740',
      `Payload ${JSON.stringify(name)} targets must be an array of nonempty strings.`,
      loaded.configPath,
    )];
  }
  return targets
    .filter((target: string) => !registry.has(target))
    .map((target: string) => sourceDiagnostic(
      'AB4740',
      `Payload ${JSON.stringify(name)} selects unknown target ${JSON.stringify(target)}.`,
      loaded.configPath,
    ));
};

/**
 * AB4740-AB4743 and the AB4750 freshness nudge: shape, destination-name,
 * source-path, and existence checks for the prebuilt `payload` block.
 * Missing or empty payloads warn here (development flows never require the
 * consumer's own build to have run); `agent-bundle build` refuses them with
 * AB4747/AB4748.
 */
const validatePayload = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
  freshness: boolean,
): Diagnostic[] => {
  const configured = loaded.config.payload;
  if (configured === undefined) return [];
  if (!isRecord(configured)) {
    return [sourceDiagnostic('AB4740', 'Payload configuration must be an object of payload directories.', loaded.configPath)];
  }
  const diagnostics: Diagnostic[] = [];
  const sources: { name: string; source: string }[] = [];
  for (const [name, declaration] of Object.entries(configured)) {
    if (!isSafePayloadName(name) || reservedPayloadDestinations.has(name)) {
      const diagnostic = sourceDiagnostic(
        'AB4741',
        `Payload destination ${JSON.stringify(name)} must be a safe directory name outside the compiler-owned artifact namespaces.`,
        loaded.configPath,
      );
      diagnostics.push(name === 'bin'
        ? {
            ...diagnostic,
            recovery: 'Rename the payload destination; use claude.bin to declare Claude Code plugin executables.',
          }
        : diagnostic);
    }
    const entry = payloadDeclarationEntry(declaration);
    if (entry === undefined) {
      diagnostics.push(sourceDiagnostic(
        'AB4740',
        `Payload ${JSON.stringify(name)} must be a source directory path or an object with a source path.`,
        loaded.configPath,
      ));
      continue;
    }
    if (typeof declaration !== 'string') {
      diagnostics.push(...payloadTargetDiagnostics(name, declaration.targets, loaded, registry));
    }
    const source = payloadDeclarationSource(loaded.context.projectRoot, declaration);
    if (source === undefined) {
      diagnostics.push(sourceDiagnostic(
        'AB4742',
        `Payload ${JSON.stringify(name)} source must resolve inside the project root.`,
        loaded.configPath,
      ));
      continue;
    }
    sources.push({ name, source });
    if (!existsSync(source)) {
      diagnostics.push(warningDiagnostic(
        'AB4743',
        `Payload ${JSON.stringify(name)} directory ${JSON.stringify(entry)} does not exist yet.`,
        loaded.configPath,
        'Run the project\'s own build to produce the prebuilt payload before "agent-bundle build".',
      ));
      continue;
    }
    if (!statSync(source).isDirectory()) {
      diagnostics.push(sourceDiagnostic(
        'AB4742',
        `Payload ${JSON.stringify(name)} source ${JSON.stringify(entry)} must name a directory.`,
        loaded.configPath,
      ));
      continue;
    }
    if (!directoryHasFiles(source)) {
      diagnostics.push(warningDiagnostic(
        'AB4743',
        `Payload ${JSON.stringify(name)} directory ${JSON.stringify(entry)} contains no files.`,
        loaded.configPath,
        'Run the project\'s own build to produce the prebuilt payload before "agent-bundle build".',
      ));
    }
  }
  for (const left of sources) {
    for (const right of sources) {
      if (left === right) continue;
      const duplicate = left.source === right.source && left.name < right.name;
      const nested = left.source !== right.source && isInside(left.source, right.source);
      if (!duplicate && !nested) continue;
      diagnostics.push(sourceDiagnostic(
        'AB4742',
        `Payload ${JSON.stringify(left.name)} source contains payload ${JSON.stringify(right.name)}; payload directories must be disjoint.`,
        loaded.configPath,
      ));
    }
  }
  // The freshness nudge walks every project and payload file's mtime, so
  // flows that discard non-error source diagnostics skip it entirely.
  const existing = freshness ? sources.filter((payload) => existsSync(payload.source)) : [];
  if (existing.length > 0) {
    const newestSource = newestFileMtime(
      loaded.context.projectRoot,
      (name) => ignoredSourceDirectoryNames.has(name),
    );
    for (const payload of existing) {
      const newestPayload = newestFileMtime(payload.source, () => false);
      if (newestPayload !== 0 && newestSource > newestPayload) {
        diagnostics.push({
          code: 'AB4750',
          message: `Prebuilt payload ${JSON.stringify(payload.name)} is older than the newest project source file; it may be stale.`,
          recovery: 'Optional: rerun the project\'s own build so the packaged payload reflects the current sources.',
          severity: 'info',
          sourcePath: loaded.configPath,
        });
      }
    }
  }
  return diagnostics;
};

const safePrebuiltArgumentPattern = /^[A-Za-z0-9%+,\-./:=@_]+$/u;

/**
 * AB4744/AB4745: one prebuilt reference (an MCP entry or a hook handler)
 * must resolve inside a declared payload whose targets cover the component,
 * and should already exist on disk. Missing files warn — the payload comes
 * from the consumer's own build step — and `agent-bundle build` refuses them
 * with AB4748.
 */
const validatePrebuiltReference = (
  label: string,
  declaration: AgentBundlePrebuiltEntry,
  componentTargets: readonly string[],
  loaded: LoadedConfig,
  payloads: readonly DeclaredPayload[],
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (!nonemptyString(declaration.prebuilt)) {
    return [sourceDiagnostic('AB4744', `${label} prebuilt entry must be a nonempty path.`, loaded.configPath)];
  }
  const source = resolve(loaded.context.projectRoot, declaration.prebuilt);
  if (!isInside(loaded.context.projectRoot, source)) {
    return [sourceDiagnostic('AB4744', `${label} prebuilt entry must resolve inside the project root.`, loaded.configPath)];
  }
  const payload = owningPayload(payloads, source);
  if (payload === undefined) {
    diagnostics.push(sourceDiagnostic(
      'AB4744',
      `${label} prebuilt entry ${JSON.stringify(declaration.prebuilt)} must resolve inside a directory declared in the payload block.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  for (const target of componentTargets) {
    if (!payload.targets.includes(target)) {
      diagnostics.push(sourceDiagnostic(
        'AB4744',
        `${label} prebuilt entry needs payload ${JSON.stringify(payload.name)} on target ${JSON.stringify(target)}, but the payload does not select it.`,
        loaded.configPath,
      ));
    }
  }
  if (!localEntryExists(loaded.context.projectRoot, declaration.prebuilt)) {
    diagnostics.push(warningDiagnostic(
      'AB4745',
      `${label} prebuilt entry ${JSON.stringify(declaration.prebuilt)} does not exist yet.`,
      loaded.configPath,
      'Run the project\'s own build to produce the prebuilt file before "agent-bundle build".',
    ));
  }
  return diagnostics;
};

/**
 * AB4734: explicit `skills` configuration leaves a conventional
 * `src/skills/<name>/SKILL.md` document uncovered, so the convention is silently
 * shadowed — the skills-directory analogue of AB4731/AB4732/AB4733.
 */
const skillConventionShadowNudges = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => (discovered.shadowedConventionalSkills ?? []).map((source) => nudgeDiagnostic(
  'AB4734',
  `${relativePosix(loaded.context.projectRoot, source)} is present but explicit skills configuration does not cover it; the conventional skill is shadowed.`,
  source,
  'Optional: remove the explicit skills configuration to adopt the src/skills/<name>/SKILL.md convention, add the directory to skills, or remove it to silence this nudge.',
));

const legacyConventionalDocumentErrors = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => (discovered.legacyConventionalDocuments ?? []).map(({ kind, source }) => {
  const relativePath = relativePosix(loaded.context.projectRoot, source);
  const destination = `src/${relativePath}`;
  return sourceDiagnostic(
    'AB4736',
    `${relativePath} uses the removed top-level ${kind} convention and is no longer discovered.`,
    source,
    kind === 'skill'
      ? `Move the document to ${destination}, or cover its directory with explicit skills configuration.`
      : `Move the document to ${destination}.`,
  );
});

const isRspackHatchValue = (value: unknown): boolean =>
  typeof value === 'function' || isRecord(value);

const validateTools = (loaded: LoadedConfig): Diagnostic[] => {
  const tools = loaded.config.tools;
  if (tools === undefined) return [];
  if (!isRecord(tools)) {
    return [sourceDiagnostic('AB4720', 'Tools configuration must be an object.', loaded.configPath)];
  }
  const diagnostics: Diagnostic[] = [];
  for (const key of Object.keys(tools)) {
    if (key !== 'rsbuild' && key !== 'rspack') {
      diagnostics.push(sourceDiagnostic(
        'AB4721',
        `Tools configuration key ${JSON.stringify(key)} is not a supported escape hatch; use rsbuild or rspack.`,
        loaded.configPath,
      ));
    }
  }
  const rsbuild = (tools as Record<string, unknown>).rsbuild;
  if (rsbuild !== undefined && !isRecord(rsbuild)) {
    diagnostics.push(sourceDiagnostic('AB4722', 'Tools rsbuild must be an Rsbuild environment-config object.', loaded.configPath));
  }
  const rspack = (tools as Record<string, unknown>).rspack;
  if (
    rspack !== undefined &&
    !isRspackHatchValue(rspack) &&
    !(Array.isArray(rspack) && rspack.every(isRspackHatchValue))
  ) {
    diagnostics.push(sourceDiagnostic(
      'AB4723',
      'Tools rspack must be an Rspack config object, a mutator function, or an array of both.',
      loaded.configPath,
    ));
  }
  return diagnostics;
};

export interface ValidateSourceOptions {
  /**
   * Compute the AB4750 payload-freshness nudge, a full-project mtime walk.
   * Defaults to true; flows that discard non-error source diagnostics pass
   * false to skip the walk.
   */
  readonly payloadFreshness?: boolean;
  /**
   * Judge the project as a release build (`agent-bundle build`) rather than
   * development preparation. Development flows keep the labeled version
   * fallback; a release refuses to package a project that has no release
   * identity at all (AB4013).
   */
  readonly release?: boolean;
}

/**
 * AB4008-AB4011: the package-identity axes derived from `package.json`
 * (issue #94). The package version is authoritative release identity, so a
 * conflicting `plugin.version` and any invalid derived value surface as
 * warnings — never errors: a missing package.json (or missing name/version
 * fields) stays a normal, silent development state with a labeled fallback.
 */
const packageIdentityIssueCode = (kind: PackageIdentityIssueKind): string => {
  switch (kind) {
    case 'invalid-name':
      return 'AB4009';
    case 'invalid-version':
      return 'AB4010';
    case 'outside-root':
      return 'AB4011';
    case 'unparsable':
      return 'AB4011';
    default: {
      const exhaustive: never = kind;
      throw new TypeError(`Unknown package identity issue kind ${String(exhaustive)}.`);
    }
  }
};

const validatePackageIdentity = (loaded: LoadedConfig, release: boolean): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const identity = snapshotPackageIdentity(loaded.context.projectRoot);
  const packageJsonPath = join(loaded.context.projectRoot, 'package.json');
  for (const issue of identity.issues) {
    diagnostics.push(warningDiagnostic(
      packageIdentityIssueCode(issue.kind),
      issue.message,
      packageJsonPath,
      'Correct the package.json field so the derived package identity is valid, then validate again.',
    ));
  }
  const plugin = loaded.config.plugin as unknown;
  const pluginVersion =
    typeof plugin === 'object' && plugin !== null && !Array.isArray(plugin)
      ? (plugin as Record<string, unknown>).version
      : undefined;
  if (
    identity.packageVersion !== undefined &&
    typeof pluginVersion === 'string' &&
    pluginVersion.trim().length > 0 &&
    pluginVersion !== identity.packageVersion
  ) {
    diagnostics.push(warningDiagnostic(
      'AB4008',
      `Config plugin.version ${JSON.stringify(pluginVersion)} differs from package.json version ${JSON.stringify(identity.packageVersion)}; the package version is authoritative for release identity.`,
      loaded.configPath,
      'Align plugin.version with the package.json version, or update package.json.',
    ));
  }
  const declared = typeof pluginVersion === 'string' && pluginVersion.trim().length > 0;
  if (release && !declared && identity.packageVersion === undefined) {
    // A development-only fallback may exist, but it can never produce a
    // release artifact (issue #94): with no authored plugin.version and no
    // valid package.json version, this project has no release identity to
    // stamp into manifests, host projections, or compiled surfaces.
    diagnostics.push({
      code: 'AB4013',
      message: 'This project has no release version: plugin.version is omitted and package.json declares no valid semantic version, so the build would package the development fallback.',
      recovery: `Add a valid semantic "version" to package.json, or declare plugin.version in the config. Development commands keep the labeled ${developmentFallbackVersion} fallback.`,
      severity: 'error',
      sourcePath: packageJsonPath,
    });
  }
  return diagnostics;
};

/**
 * The stage-1 script-route gate (#102): conventional `src/scripts/` routes
 * ship through the explicit-`scripts` pipeline, so every discovered script
 * route that pipeline cannot ship yet is a hard error naming its explicit
 * resolution. Discovery is not a packaging choice - a route never
 * disappears silently.
 */
const validateConventionalScripts = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const configured = configuredScriptNames(loaded.config);
  for (const route of discovered.routeGraph?.scripts ?? []) {
    const relativePath = route.provenance.relativePath;
    const judgment = judgeScriptRoute(route, configured);
    switch (judgment) {
      case 'shippable':
      // Rendered scripts ship through the Agent renderer pipeline (#102
      // stage 3); AB4807 is retired and never reused.
      case 'rendered':
        break;
      case 'nested':
        diagnostics.push({
          code: 'AB4808',
          message: `Conventional script ${relativePath} nests below the src/scripts/ root; conventional scripts ship as direct children only.`,
          recovery: 'Move the module directly under src/scripts/, prefix a path segment with "_" to keep it private, or declare it under scripts in config with a flat name.',
          severity: 'error',
          sourcePath: route.source,
        });
        break;
      case 'conflicting':
        diagnostics.push({
          code: 'AB4809',
          message: `Conventional script ${relativePath} and the configured script ${JSON.stringify(scriptRouteName(route))} share one script identity; the compiler never chooses silently.`,
          recovery: `Point the scripts.${scriptRouteName(route)} config entry at ${relativePath} to claim the module, or rename one of the two scripts.`,
          severity: 'error',
          sourcePath: route.source,
        });
        break;
      default: {
        const unreachable: never = judgment;
        throw new TypeError(`Unhandled script route judgment ${String(unreachable)}.`);
      }
    }
  }
  return diagnostics;
};

/**
 * The routed-CLI packaging gate (#102): a generated-mode `src/cli/**`
 * surface compiles into one framework-generated bin, so an explicit `bin`
 * entry shadowing the generated executable's name is a hard error naming its
 * explicit resolution. Discovery is not a packaging choice — a route never
 * disappears silently. (AB4816, the stage-2 rendered-command gate, is
 * retired: rendered commands render through the dispatcher since stage 3.)
 */
const validateConventionalCliRoutes = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const cli = discovered.routeGraph?.cli;
  if (cli?.mode !== 'generated') return diagnostics;
  const bin = loaded.config.bin;
  if ((cli.commands ?? []).length > 0 && bin !== false && bin !== undefined && isRecord(bin)) {
    const pluginName = loaded.config.plugin.name;
    if (Object.hasOwn(bin, pluginName)) {
      diagnostics.push({
        code: 'AB4813',
        message: `The explicit bin entry ${JSON.stringify(pluginName)} and the generated src/cli/ command executable share one bin name; the compiler never chooses silently.`,
        recovery: `Rename the bin.${pluginName} entry, or remove the src/cli/ routes to keep the explicit bin.`,
        severity: 'error',
        sourcePath: loaded.configPath,
      });
    }
  }
  return diagnostics;
};

export const validateSource = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
  options?: ValidateSourceOptions,
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
  // `plugin.version` is optional since #94 stage 3: omitting it derives the
  // version from package.json. Declaring it as anything but a nonempty
  // string is still a mistake with no defensible reading.
  if (pluginVersion !== undefined && (typeof pluginVersion !== 'string' || pluginVersion.trim().length === 0)) {
    diagnostics.push(
      sourceDiagnostic(
        'AB4001',
        'Plugin metadata version must be a nonempty string when it is declared; omit it to derive the version from package.json.',
        loaded.configPath,
      ),
    );
  }
  diagnostics.push(...validatePluginLogo(loaded, pluginRecord));

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

  const payloads = declaredPayloads(loaded, registry);
  diagnostics.push(...validateAssets(loaded));
  diagnostics.push(...validatePackageIdentity(loaded, options?.release === true));
  diagnostics.push(...validateBin(loaded));
  diagnostics.push(...validateHooks(loaded, registry, payloads));
  diagnostics.push(...validateLib(loaded));
  diagnostics.push(...validateMcp(loaded, registry, payloads));
  diagnostics.push(...validateOutput(loaded));
  diagnostics.push(...validatePayload(loaded, registry, options?.payloadFreshness !== false));
  diagnostics.push(...validateRuntime(loaded));
  diagnostics.push(...validateCommands(loaded, discovered, registry));
  diagnostics.push(...validateRules(loaded, discovered, registry));
  diagnostics.push(...validateScripts(loaded, registry));
  diagnostics.push(...validateTools(loaded));
  if (loaded.config.state !== undefined && loaded.config.state !== false) {
    diagnostics.push(sourceDiagnostic(
      'AB4818',
      'State configuration accepts only false; omit it to discover src/state.ts.',
      loaded.configPath,
    ));
  }
  diagnostics.push(...packageConventionShadowNudges(loaded));
  diagnostics.push(...skillConventionShadowNudges(loaded, discovered));
  diagnostics.push(...legacyConventionalDocumentErrors(loaded, discovered));
  // Route overrides are validated during discovery; source validation must
  // still observe the config getter so hostile accessors fail closed as AB7001.
  void loaded.config['routes'];
  // Route-graph collisions (AB4800-AB4804) are compiled during discovery;
  // they are project-source errors, so they gate inspect and build here.
  diagnostics.push(...(discovered.routeGraph?.diagnostics ?? []));
  diagnostics.push(...(discovered.state?.diagnostics ?? []));
  diagnostics.push(...validateEventRoutes(loaded, discovered, registry));
  // The stage-1 gate for conventional script routes rides beside the graph's
  // own collisions: rendered, nested, and config-conflicting script routes
  // stay hard errors until later #102 stages ship them.
  diagnostics.push(...validateConventionalScripts(loaded, discovered));
  // The stage-2 gate for routed CLI commands: rendered command routes and
  // explicit-bin shadowing stay hard errors, never silent omissions.
  diagnostics.push(...validateConventionalCliRoutes(loaded, discovered));

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
  const components = [
    model.metadata,
    ...Object.values(model.extensions),
    ...model.targets,
    ...model.skills,
    ...(model.commands ?? []),
    ...(model.rules ?? []),
    ...model.hooks,
    ...model.mcpServers,
    ...(model.mcpApps ?? []),
    ...model.scripts,
    ...(model.assets ?? []),
    ...(model.packageBuild?.bins ?? []),
    ...(model.packageBuild?.lib === undefined ? [] : [model.packageBuild.lib]),
    ...(model.payloads ?? []),
  ];
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

  for (const skill of model.skills) {
    for (const document of Object.values(skill.hostDocuments ?? {})) {
      diagnostics.push(...document.diagnostics.filter((diagnostic) =>
        diagnostic.code === 'AB3008' || diagnostic.code === 'AB3009' || diagnostic.code === 'AB3010',
      ));
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
      } else if (!registry.supports(target, 'hooks')) {
        diagnostics.push({
          code: 'AB4204',
          message: `Target ${JSON.stringify(target)} cannot emit hook ${hook.event}.`,
          severity: 'error',
          sourcePath: hook.provenance.sourcePath,
          target,
        });
      }
    }
    if (hook.eventRoute?.runtime === 'shared' && hook.eventRoute.fallback === 'none') {
      for (const target of hook.targets) {
        const runtimeHost = model.mcpServers.some((server) =>
          server.generatedRoutes !== undefined && server.targets.includes(target));
        if (runtimeHost) continue;
        diagnostics.push({
          code: 'AB4817',
          message: `Event route ${hook.eventRoute.event} requires the shared runtime on ${target}, but no generated MCP entry hosts it.`,
          recovery: 'Add a generated MCP route server, or explicitly set event config.runtime to standalone or config.fallback to standalone.',
          severity: 'error',
          sourcePath: hook.provenance.sourcePath,
          target,
        });
      }
    }
  }

  for (const nativeHook of model.nativeHooks ?? []) {
    if (!registry.has(nativeHook.target)) {
      diagnostics.push({
        code: 'AB4206',
        message: `Native hook selects unknown target ${JSON.stringify(nativeHook.target)}.`,
        severity: 'error',
        sourcePath: nativeHook.provenance.sourcePath,
        target: nativeHook.target,
      });
    } else if (!registry.supports(nativeHook.target, 'hooks')) {
      diagnostics.push({
        code: 'AB4207',
        message: `Target ${JSON.stringify(nativeHook.target)} cannot emit native hooks.`,
        severity: 'error',
        sourcePath: nativeHook.provenance.sourcePath,
        target: nativeHook.target,
      });
    }
    if (nativeHook.issue === 'source-invalid') {
      diagnostics.push({
        code: 'AB4208',
        message: `Native hook source for target ${JSON.stringify(nativeHook.target)} must return a string or undefined.`,
        severity: 'error',
        sourcePath: nativeHook.provenance.sourcePath,
        target: nativeHook.target,
      });
    } else if (nativeHook.issue === 'source-error') {
      diagnostics.push({
        code: 'AB4209',
        message: `Native hook source for target ${JSON.stringify(nativeHook.target)} failed.`,
        severity: 'error',
        sourcePath: nativeHook.provenance.sourcePath,
        target: nativeHook.target,
      });
    }
  }

  for (const script of model.scripts) {
    for (const target of script.targets) {
      if (!registry.has(target)) {
        diagnostics.push({
          code: 'AB4406',
          message: `Script ${JSON.stringify(script.name)} selects unknown target ${JSON.stringify(target)}.`,
          severity: 'error',
          sourcePath: script.provenance.sourcePath,
          target,
        });
      }
    }
  }

  for (const server of model.mcpServers) {
    const transportDiagnostic = unsupportedMcpTransportDiagnostic(server);
    if (transportDiagnostic !== undefined) diagnostics.push(transportDiagnostic);
    for (const target of server.targets) {
      if (!registry.has(target)) {
        diagnostics.push({
          code: 'AB4320',
          message: `MCP server ${JSON.stringify(server.name)} selects unknown target ${JSON.stringify(target)}.`,
          severity: 'error',
          sourcePath: server.provenance.sourcePath,
          target,
        });
      }
    }
    if (server.source !== undefined) {
      const output = server.args?.[0];
      if (typeof output !== 'string' || !/^mcp\/mcp-[a-z0-9-]+-[a-f\d]{8}\.mjs$/u.test(output)) {
        diagnostics.push({
          code: 'AB4321',
          message: `MCP server ${JSON.stringify(server.name)} has an unsafe local output alias.`,
          severity: 'error',
          sourcePath: server.provenance.sourcePath,
        });
      }
    }
  }

  for (const app of model.mcpApps ?? []) {
    const server = model.mcpServers.find((candidate) => candidate.id === app.serverId);
    for (const target of app.targets) {
      if (!registry.has(target)) {
        diagnostics.push({
          code: 'AB4336',
          message: `MCP App ${JSON.stringify(app.name)} selects unknown target ${JSON.stringify(target)}.`,
          severity: 'error',
          sourcePath: app.provenance.sourcePath,
          target,
        });
      } else if (server === undefined || !server.targets.includes(target)) {
        diagnostics.push({
          code: 'AB4337',
          message: `MCP App ${JSON.stringify(app.name)} selects target ${JSON.stringify(target)} outside its owning server.`,
          severity: 'error',
          sourcePath: app.provenance.sourcePath,
          target,
        });
      }
    }
  }

  const outputs = new Map<string, string>();
  const recordOutput = (generatedPath: string, source: string, target: string): void => {
    const firstSource = outputs.get(generatedPath);
    if (firstSource === undefined) {
      outputs.set(generatedPath, source);
      return;
    }
    diagnostics.push({
      code: 'AB4102',
      generatedPath,
      message: `Multiple inputs produce ${JSON.stringify(generatedPath)}; first source is ${firstSource}.`,
      severity: 'error',
      sourcePath: source,
      target,
    });
  };
  for (const target of model.targets) {
    for (const skill of model.skills) {
      const hostDocument = skill.hostDocuments?.[target.name];
      const generatedSkill = hostDocument !== undefined && !hostDocument.passThrough;
      if (generatedSkill) {
        recordOutput(
          posix.join(target.name, 'skills', skill.name, 'SKILL.md'),
          skill.source,
          target.name,
        );
        for (const sidecar of hostDocument.sidecars) {
          recordOutput(
            posix.join(target.name, 'skills', skill.name, sidecar.relativePath),
            sidecar.source ?? skill.source,
            target.name,
          );
        }
      } else if (skill.markdown !== undefined) {
        recordOutput(
          posix.join(target.name, 'skills', skill.name, 'SKILL.md'),
          skill.source,
          target.name,
        );
      }
      const generatedSidecars = new Set(
        generatedSkill ? hostDocument.sidecars.map((sidecar) => sidecar.relativePath) : [],
      );
      for (const resource of skill.resources) {
        if (generatedSkill && (resource.relativePath === 'SKILL.md' || generatedSidecars.has(resource.relativePath))) {
          continue;
        }
        recordOutput(
          posix.join(target.name, 'skills', skill.name, resource.relativePath),
          resource.source,
          target.name,
        );
      }
    }
    for (const asset of model.assets ?? []) {
      if (!asset.targets.includes(target.name)) continue;
      recordOutput(posix.join(target.name, 'assets', asset.relativePath), asset.source, target.name);
    }
    for (const command of model.commands ?? []) {
      if (!command.targets.includes(target.name)) continue;
      recordOutput(posix.join(target.name, 'commands', `${command.name}.md`), command.source, target.name);
    }
    for (const rule of model.rules ?? []) {
      if (!rule.targets.includes(target.name)) continue;
      recordOutput(posix.join(target.name, 'rules', `${rule.name}.mdc`), rule.source, target.name);
    }
    for (const payload of model.payloads ?? []) {
      if (!payload.targets.includes(target.name)) continue;
      for (const file of payload.files) {
        recordOutput(posix.join(target.name, payload.name, file.relativePath), file.source, target.name);
      }
    }
    for (const bin of model.hostBins ?? []) {
      if (bin.target !== target.name) continue;
      for (const file of bin.files) {
        recordOutput(posix.join(target.name, 'bin', file.relativePath), file.source, target.name);
      }
    }
    for (const directory of model.hostOutputStyles ?? []) {
      if (directory.target !== target.name) continue;
      for (const file of directory.files) {
        recordOutput(posix.join(target.name, 'output-styles', file.relativePath), file.source, target.name);
      }
    }
    for (const directory of model.hostWorkflows ?? []) {
      if (directory.target !== target.name) continue;
      for (const file of directory.files) {
        recordOutput(posix.join(target.name, 'workflows', file.relativePath), file.source, target.name);
      }
    }
  }

  return diagnostics;
};
