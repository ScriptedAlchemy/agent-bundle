import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { unsupportedMcpTransportDiagnostic } from '../core/mcp-transport.ts';
import {
  defaultGeneratedRuntime,
  parseRuntimeVersion,
  satisfiesGeneratedRuntimeFloor,
} from '../core/runtime.ts';
import { parseNativeHookToolSelector } from '../core/types.ts';
import type {
  AgentBundleHookEntry,
  AgentBundleHookInput,
  AgentBundleMcpApp,
  AgentBundleMcpServer,
  AgentBundleScriptInput,
  CanonicalHookEvent,
  NormalizationTargetRegistry,
  NormalizedPlugin,
} from '../core/types.ts';
import type { DiscoveredProject } from './discover.ts';
import type { LoadedConfig } from './load.ts';
import type { SkillDocument } from './skill.ts';
import { referencedResources } from './skill-references.ts';
import { validateAgentSkillsFrontmatter } from '../schemas/agent-skills/contract.ts';

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

const validateHooks = (
  loaded: LoadedConfig,
  registry: NormalizationTargetRegistry,
): Diagnostic[] => {
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
        } else if (entry.targets !== undefined && !entry.targets.includes(selector.target)) {
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

const validVersionedUiUri = (value: string): boolean => {
  try {
    const uri = new URL(value);
    return uri.protocol === 'ui:' && /(?:^|[/-])v\d+(?:[./-]|$)/u.test(`${uri.hostname}${uri.pathname}`);
  } catch {
    return false;
  }
};

const validateMcpApps = (
  name: string,
  server: AgentBundleMcpServer,
  loaded: LoadedConfig,
  seenNames: Set<string>,
  seenUris: Set<string>,
): Diagnostic[] => {
  if (server.apps === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  if (server.entry === undefined) {
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
    if (!/^[a-z][a-z0-9-]*$/u.test(appName)) {
      diagnostics.push(sourceDiagnostic(
        'AB4324',
        `MCP App name ${JSON.stringify(appName)} must use stable lowercase kebab-case.`,
        loaded.configPath,
      ));
    } else if (seenNames.has(appName)) {
      diagnostics.push(sourceDiagnostic(
        'AB4325',
        `MCP App name ${JSON.stringify(appName)} is duplicated.`,
        loaded.configPath,
      ));
    }
    seenNames.add(appName);
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
    if (!nonemptyString(app.resourceUri) || !validVersionedUiUri(app.resourceUri)) {
      diagnostics.push(sourceDiagnostic(
        'AB4329',
        `MCP App ${JSON.stringify(appName)} resourceUri must be a versioned ui:// URI.`,
        loaded.configPath,
      ));
    } else if (seenUris.has(app.resourceUri)) {
      diagnostics.push(sourceDiagnostic(
        'AB4330',
        `MCP App resourceUri ${JSON.stringify(app.resourceUri)} is duplicated.`,
        loaded.configPath,
      ));
    }
    if (typeof app.resourceUri === 'string') seenUris.add(app.resourceUri);
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

const validateMcpServer = (
  name: string,
  value: unknown,
  loaded: LoadedConfig,
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
  if (variants.length !== 1) {
    diagnostics.push(sourceDiagnostic(
      'AB4304',
      `MCP server ${JSON.stringify(name)} must define exactly one of entry, command, or url.`,
      loaded.configPath,
    ));
    return diagnostics;
  }
  diagnostics.push(...validateStringList(server.targets, 'targets', 'AB4305', loaded));

  if (entry !== undefined) {
    if (!nonemptyString(entry)) {
      diagnostics.push(sourceDiagnostic('AB4306', `MCP server ${JSON.stringify(name)} entry must be a nonempty path.`, loaded.configPath));
    } else if (!localEntryExists(loaded.context.projectRoot, entry)) {
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
    return [sourceDiagnostic('AB4500', 'Runtime configuration must be an object.', loaded.configPath)];
  }
  const keys = Object.keys(runtime);
  if (keys.length !== 1 || keys[0] !== 'node') {
    return [sourceDiagnostic(
      'AB4500',
      'Runtime configuration must contain exactly one node version.',
      loaded.configPath,
    )];
  }
  const node = runtime.node;
  const version = typeof node === 'string' ? parseRuntimeVersion(node) : undefined;
  if (version === undefined) {
    return [sourceDiagnostic(
      'AB4501',
      'Runtime node floor must be a version string such as "22.16" or "24.0.0".',
      loaded.configPath,
    )];
  }
  if (!satisfiesGeneratedRuntimeFloor(version)) {
    return [sourceDiagnostic(
      'AB4502',
      `Runtime node floor ${JSON.stringify(node)} cannot lower the Node.js ${defaultGeneratedRuntime.node} default.`,
      loaded.configPath,
    )];
  }
  return [];
};

const validateMcp = (loaded: LoadedConfig): Diagnostic[] => {
  const mcp = loaded.config.mcp;
  if (mcp === undefined) return [];
  if (!isRecord(mcp)) {
    return [sourceDiagnostic('AB4300', 'MCP configuration must be an object.', loaded.configPath)];
  }
  if (!isRecord(mcp.servers)) {
    return [sourceDiagnostic('AB4301', 'MCP configuration must define a servers object.', loaded.configPath)];
  }
  const names = new Set<string>();
  const uris = new Set<string>();
  return Object.entries(mcp.servers).flatMap(([name, server]) => {
    const diagnostics = validateMcpServer(name, server, loaded);
    return isRecord(server)
      ? [...diagnostics, ...validateMcpApps(name, server as AgentBundleMcpServer, loaded, names, uris)]
      : diagnostics;
  });
};

const validateSkill = (skill: SkillDocument): Diagnostic[] => {
  const diagnostics = [...skill.diagnostics];
  const name = skill.frontmatter.name;

  diagnostics.push(...validateAgentSkillsFrontmatter(skill.frontmatter).map((issue) => {
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

export const validateSource = (
  loaded: LoadedConfig,
  discovered: DiscoveredProject,
  registry: NormalizationTargetRegistry,
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

  diagnostics.push(...validateAssets(loaded));
  diagnostics.push(...validateHooks(loaded, registry));
  diagnostics.push(...validateMcp(loaded));
  diagnostics.push(...validateRuntime(loaded));
  diagnostics.push(...validateScripts(loaded, registry));

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
    ...model.hooks,
    ...model.mcpServers,
    ...(model.mcpApps ?? []),
    ...model.scripts,
    ...(model.assets ?? []),
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
      for (const resource of skill.resources) {
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
  }

  return diagnostics;
};
