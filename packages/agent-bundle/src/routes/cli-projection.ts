import { extractRouteConfig, routeConfigGrammar } from './config-extract.ts';
import { scanRouteModuleExports, type RouteModuleExports } from './contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import { isRecord } from '../core/strict-json.ts';
import type { CliProjectionFlagConfig, CliProjectionFlagDefault } from './public.ts';
import { safeIdentitySegment, type CompiledAgentRoute, type RouteInputSchema } from './types.ts';

/**
 * The CLI surface projection of one MCP tool (#596): the colocated
 * `src/mcp/<server>/tools/<tool>.cli.{ts,tsx}` module. It is never a route —
 * discovery records it before route classification and pairs it with the
 * sibling tool route — and its `config` is read by the unchanged static
 * route-config grammar. This leaf owns the module's shape: how a path is
 * recognized, what the validated `config` may hold, whether the module
 * exports `mapInput`, and the `AB4843`–`AB4845` diagnostics.
 */

/** The file suffixes reserved for a tool's CLI projection module under `src/mcp/**`. */
export const cliProjectionSuffixes = ['.cli.ts', '.cli.tsx'] as const;

/** One `src/mcp/<server>/tools/<stem>.cli.{ts,tsx}` module, as discovery classifies it. */
export interface CliProjectionModule {
  readonly server: string;
  /** The tool route id the module projects: `tool:<server>/<stem>`. */
  readonly siblingId: string;
  /** The tool name, `<stem>` of `<stem>.cli.{ts,tsx}`. */
  readonly stem: string;
}

const projectionModulePath = /^src\/mcp\/(?<server>[^/]+)\/tools\/(?<stem>[^/]+)\.cli\.tsx?$/u;
const misplacedModulePath = /^src\/mcp\/[^/]+\/(?:resources|prompts|apps)\/[^/]+\.cli\.tsx?$/u;

/** `src/mcp/<server>/tools/<stem>.cli.{ts,tsx}` → its server, stem, and sibling tool id; undefined for every other path. */
export const classifyCliProjectionModule = (relativePath: string): CliProjectionModule | undefined => {
  const match = projectionModulePath.exec(relativePath);
  if (match?.groups === undefined) return undefined;
  const server = match.groups['server'];
  const stem = match.groups['stem'];
  if (server === undefined || stem === undefined) return undefined;
  return { server, siblingId: `tool:${server}/${stem}`, stem };
};

/** True for a `.cli.{ts,tsx}` module under `resources/`, `prompts/`, or `apps/`: only tool routes take a CLI projection (AB4843). */
export const isMisplacedCliProjectionModule = (relativePath: string): boolean => misplacedModulePath.test(relativePath);

/**
 * The validated `config` of a projection module: the closed key set of
 * `CliProjectionConfig` with `flags`/`positionals` keyed by canonical key
 * strings. Deep-frozen; every field is optional.
 */
export interface CliProjectionConfigRecord {
  readonly aliases?: readonly string[];
  readonly command?: readonly string[];
  readonly confirm?: boolean;
  readonly description?: string;
  readonly exitCode?: 'result' | 'zero';
  readonly flags?: Readonly<Record<string, CliProjectionFlagConfig>>;
  readonly positionals?: readonly string[];
}

/** What one projection module contributes, judged statically; `config` is empty whenever AB4844 fired on it. */
export interface ExtractedCliProjection {
  readonly config: CliProjectionConfigRecord;
  /** AB4844 (module contract) and AB4845 (grammar binding) in that order. */
  readonly diagnostics: readonly Diagnostic[];
  /** True when the module exports `mapInput` as a synchronous, non-generator function with a runtime binding. */
  readonly mapInput: boolean;
}

export interface CliProjectionExtractionOptions {
  /** Absolute project root; const string references inside `config` resolve inside it only. */
  readonly projectRoot?: string;
}

const projectionConfigKeys: readonly string[] = ['aliases', 'command', 'confirm', 'description', 'exitCode', 'flags', 'positionals'];

const flagConfigKeys: readonly string[] = ['aliases', 'default', 'description', 'name', 'required'];

const emptyProjectionConfig: CliProjectionConfigRecord = deepFreeze({});

const projectionSubject = (module: string, toolId: string): string => `CLI projection ${module} for ${toolId}`;

const contractRecovery = 'Declare only command, aliases, confirm, description, exitCode, flags, and positionals, each in the shape CliProjectionConfig documents; then inspect again.';
const grammarRecovery = `Export the projection config as a single top-level \`export const config = { ... }\` object literal inside the static route-config grammar (${routeConfigGrammar}), then inspect again.`;
const mapInputRecovery = 'Export mapInput as one synchronous, non-generator function with a runtime binding — a function declaration (`export function mapInput(input) { ... }`), an arrow (`export const mapInput = (input) => ({ ... })`), or a function expression — or remove the export; then inspect again.';
const spellingRecovery = 'Use kebab-case option spellings without leading dashes that are neither reserved (help, json, ndjson, version, and yes when the command confirms) nor claimed by another option or alias; then inspect again.';

/** AB4844: the projection module's own contract — `config` shape and `mapInput` — is not met. */
export const cliProjectionContractError = (
  module: string,
  toolId: string,
  detail: string,
  sourcePath: string,
  recovery = contractRecovery,
): Diagnostic => ({
  code: 'AB4844',
  message: `${projectionSubject(module, toolId)}: ${detail}.`,
  recovery,
  severity: 'error',
  sourcePath,
});

/** AB4845: the projection does not bind to the tool's argv grammar (unknown key, spelling, command segment). */
export const cliProjectionBindingError = (
  module: string,
  toolId: string,
  detail: string,
  sourcePath: string,
  recovery = spellingRecovery,
): Diagnostic => ({
  code: 'AB4845',
  message: `${projectionSubject(module, toolId)}: ${detail}.`,
  recovery,
  severity: 'error',
  sourcePath,
});

/** AB4843: a `<stem>.cli.{ts,tsx}` module under `tools/` without the sibling tool route `<stem>.{ts,tsx}`. */
export const orphanCliProjectionError = (
  relativePath: string,
  module: CliProjectionModule,
  sourcePath: string,
): Diagnostic => ({
  code: 'AB4843',
  message: `${projectionSubject(relativePath, module.siblingId)}: has no sibling tool route src/mcp/${module.server}/tools/${module.stem}.{ts,tsx} to project; a projection is never a route of its own.`,
  recovery: 'Rename the module so its stem matches the tool route beside it, or prefix the file name with _ to park it; then inspect again.',
  severity: 'error',
  sourcePath,
});

/** AB4843 for the second of `<tool>.cli.ts` and `<tool>.cli.tsx`: a tool takes one projection module. */
export const duplicateCliProjectionError = (
  relativePath: string,
  existingRelativePath: string,
  module: CliProjectionModule,
  sourcePath: string,
): Diagnostic => ({
  code: 'AB4843',
  message: `${projectionSubject(relativePath, module.siblingId)}: ${existingRelativePath} already projects this tool, and a tool takes one projection module.`,
  recovery: 'Keep exactly one of the .cli.ts and .cli.tsx modules, or prefix one file name with _ to park it; then inspect again.',
  severity: 'error',
  sourcePath,
});

/**
 * AB4843: a `.cli.{ts,tsx}` module under `resources/`, `prompts/`, or
 * `apps/`, where no route takes a CLI projection. There is no tool to name,
 * so the subject is the module alone.
 */
export const misplacedCliProjectionError = (relativePath: string, sourcePath: string): Diagnostic => ({
  code: 'AB4843',
  message: `CLI projection ${relativePath}: sits under resources/, prompts/, or apps/, where no route takes the .cli suffix; only src/mcp/<server>/tools/<tool>.cli.{ts,tsx} projects a tool, and resources, prompts, and Apps have no argv surface to project.`,
  recovery: 'Move the module beside the tool route it projects, rename it so it does not end in .cli.ts or .cli.tsx, or prefix the file name with _ to park it; then inspect again.',
  severity: 'error',
  sourcePath,
});

/** The value when it is an array of strings (empty included), else undefined. */
export const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;

const isFlagDefault = (value: unknown): value is CliProjectionFlagDefault => {
  const scalar = (entry: unknown): entry is boolean | number | string =>
    typeof entry === 'boolean' || typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry));
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
};

const configReason = (diagnostic: Diagnostic, relativePath: string): string => {
  const prefix = `Route module ${relativePath} `;
  const message = diagnostic.message.endsWith('.') ? diagnostic.message.slice(0, -1) : diagnostic.message;
  return message.startsWith(prefix) ? `the module ${message.slice(prefix.length)}` : message;
};

type FlagValidation =
  | { readonly detail: string }
  | { readonly flag: CliProjectionFlagConfig };

const validateFlag = (key: string, value: unknown): FlagValidation => {
  if (!isRecord(value)) return { detail: `config.flags.${key} must be an object` };
  const unknown = Object.keys(value).find((field) => !flagConfigKeys.includes(field));
  if (unknown !== undefined) return { detail: `config.flags.${key}.${unknown} is an unknown field` };
  const aliases = value.aliases === undefined ? undefined : stringArray(value.aliases);
  if (value.aliases !== undefined && aliases === undefined) return { detail: `config.flags.${key}.aliases must be an array of strings` };
  const defaultValue = value.default;
  if (defaultValue !== undefined && !isFlagDefault(defaultValue)) {
    return { detail: `config.flags.${key}.default must be a boolean, number, string, or an array of those` };
  }
  const description = value.description;
  if (description !== undefined && typeof description !== 'string') {
    return { detail: `config.flags.${key}.description must be a string` };
  }
  const name = value.name;
  if (name !== undefined && typeof name !== 'string') return { detail: `config.flags.${key}.name must be a string` };
  if (value.required !== undefined && value.required !== false) {
    return { detail: `config.flags.${key}.required may only be false (the canonical schema decides what is required)` };
  }
  return {
    flag: {
      ...(aliases === undefined ? {} : { aliases }),
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      ...(description === undefined ? {} : { description }),
      ...(name === undefined ? {} : { name }),
      ...(value.required === undefined ? {} : { required: false as const }),
    },
  };
};

interface ConfigValidation {
  readonly config?: CliProjectionConfigRecord;
  readonly details: readonly string[];
}

const validateProjectionConfig = (raw: Readonly<Record<string, unknown>>): ConfigValidation => {
  const details: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!projectionConfigKeys.includes(key)) details.push(`config.${key} is an unknown key`);
  }
  const aliases = raw['aliases'] === undefined ? undefined : stringArray(raw['aliases']);
  if (raw['aliases'] !== undefined && aliases === undefined) details.push('config.aliases must be an array of strings');
  const command = raw['command'] === undefined ? undefined : stringArray(raw['command']);
  if (raw['command'] !== undefined && (command === undefined || command.length === 0)) {
    details.push('config.command must be a non-empty array of command segment strings');
  }
  const confirm = raw['confirm'];
  if (confirm !== undefined && typeof confirm !== 'boolean') details.push('config.confirm must be a boolean');
  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') details.push('config.description must be a string');
  const exitCode = raw['exitCode'];
  if (exitCode !== undefined && exitCode !== 'result' && exitCode !== 'zero') {
    details.push('config.exitCode must be "result" or "zero" when declared');
  }
  const flags: Record<string, CliProjectionFlagConfig> = {};
  const declaredFlags = raw['flags'];
  if (declaredFlags !== undefined && !isRecord(declaredFlags)) {
    details.push('config.flags must be an object keyed by canonical inputSchema keys');
  } else if (declaredFlags !== undefined) {
    for (const [key, value] of Object.entries(declaredFlags)) {
      const validated = validateFlag(key, value);
      if ('detail' in validated) details.push(validated.detail);
      else flags[key] = validated.flag;
    }
  }
  const positionals = raw['positionals'] === undefined ? undefined : stringArray(raw['positionals']);
  if (raw['positionals'] !== undefined && positionals === undefined) {
    details.push('config.positionals must be an array of canonical inputSchema key strings');
  }
  if (details.length > 0) return { details };
  return {
    config: {
      ...(aliases === undefined ? {} : { aliases }),
      ...(command === undefined ? {} : { command }),
      ...(typeof confirm === 'boolean' ? { confirm } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(exitCode === 'result' || exitCode === 'zero' ? { exitCode } : {}),
      ...(declaredFlags === undefined ? {} : { flags }),
      ...(positionals === undefined ? {} : { positionals }),
    },
    details: [],
  };
};

const positionalSpellingRecovery = (key: string): string =>
  `Remove name and aliases from config.flags.${key}, or drop ${JSON.stringify(key)} from config.positionals so it is an option; then inspect again.`;

/**
 * Binds a validated config to the tool's canonical contract: `flags` and
 * `positionals` must name contract keys, a positional key takes no option
 * spelling, and `command` segments must be safe identity segments (AB4845);
 * relaxing a canonical-required key needs `mapInput` to supply it (AB4844).
 * Spelling rules run later, inside the one argv policy, on the final
 * `--options`.
 */
const bindProjectionConfig = (
  config: CliProjectionConfigRecord,
  contract: RouteInputSchema | undefined,
  mapInput: boolean,
  report: {
    readonly binding: (detail: string, recovery?: string) => Diagnostic;
    readonly contract: (detail: string, recovery?: string) => Diagnostic;
  },
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const [index, segment] of (config.command ?? []).entries()) {
    if (!safeIdentitySegment.test(segment)) {
      diagnostics.push(report.binding(
        `config.command[${index}] ${JSON.stringify(segment)} is not a safe identity segment`,
        'Use command segments of letters, digits, and inner ".", "_", "-" only, then inspect again.',
      ));
    }
  }
  // A positional is consumed as a bare argument; the parser never reads a
  // `--spelling` for it, so `name` and `aliases` would advertise spellings
  // that do not exist. `description`, `default`, and `required: false`
  // still apply to the key.
  for (const key of new Set(config.positionals ?? [])) {
    const flag = config.flags?.[key];
    if (flag === undefined) continue;
    const fields = [
      ...(flag.name === undefined ? [] : ['name']),
      ...(flag.aliases === undefined ? [] : ['aliases']),
    ];
    if (fields.length === 0) continue;
    diagnostics.push(report.binding(
      `config.flags.${key} is positional; ${fields.join(' and ')} ${fields.length === 1 && fields[0] === 'name' ? 'does' : 'do'} not apply to a bare argument`,
      positionalSpellingRecovery(key),
    ));
  }
  // Without a static contract the tool's own argv parse reports why
  // (AB4814/AB4838/AB4839, relabelled); nothing here can be judged.
  if (contract === undefined) return diagnostics;
  const keys = Object.keys(contract.properties);
  const keyRecovery = inputKeysRecovery(keys);
  const required = contract.required ?? [];
  for (const [key, flag] of Object.entries(config.flags ?? {})) {
    if (!keys.includes(key)) {
      diagnostics.push(report.binding(unknownInputKeyDetail('flags', key), keyRecovery));
      continue;
    }
    if (!mapInput && required.includes(key) && (flag.required === false || flag.default !== undefined)) {
      diagnostics.push(report.contract(relaxationWithoutMapInputDetail(key, flag), relaxationRecovery(key)));
    }
  }
  for (const key of config.positionals ?? []) {
    if (!keys.includes(key)) {
      diagnostics.push(report.binding(unknownInputKeyDetail('positionals', key), keyRecovery));
    }
  }
  return diagnostics;
};

/** AB4845 detail: `config.flags.<key>` or `config.positionals` names a key the tool's inputSchema lacks. */
export const unknownInputKeyDetail = (site: 'flags' | 'positionals', key: string): string =>
  site === 'flags'
    ? `config.flags.${key} names a key that is not in the tool's inputSchema`
    : `config.positionals names ${JSON.stringify(key)}, which is not a key of the tool's inputSchema`;

/** Recovery for `unknownInputKeyDetail`: the keys the tool's inputSchema does declare. */
export const inputKeysRecovery = (keys: readonly string[]): string =>
  `Name only keys of the tool's inputSchema (${keys.length === 0 ? 'it declares none' : keys.join(', ')}), then inspect again.`;

/**
 * AB4844 detail: `flags.<key>.required: false` or `flags.<key>.default`
 * relaxes a key the tool's inputSchema requires, and no `mapInput` exists to
 * supply it before the canonical schema validates.
 */
export const relaxationWithoutMapInputDetail = (key: string, flag: CliProjectionFlagConfig): string =>
  `config.flags.${key}.${flag.required === false ? 'required' : 'default'} relaxes ${JSON.stringify(key)}, which the tool's inputSchema requires, but the module exports no mapInput to supply it`;

export const relaxationRecovery = (key: string): string =>
  `Export a mapInput function that fills ${JSON.stringify(key)} before the canonical inputSchema validates, or keep the key required on the CLI; then inspect again.`;

/**
 * The AB4844 detail when an exported `mapInput` is not what the shell can
 * call: it must carry a runtime binding (no ambient `declare`), return the
 * mapped input directly (no generator), and return it synchronously (no
 * `async`), because the shell applies it inline before `inputSchema.parse`
 * and a Promise or iterator would reach the schema instead of the input.
 * A `mapInput` re-exported from another module is judged where it is
 * declared (`export { mapInput } from './shared.ts'` is followed like a
 * default re-export); one the scan cannot follow — a bare specifier, an
 * unreadable file, or a re-export cycle — is rejected rather than trusted,
 * since a projection has no run-time fallback judgment. Undefined when the
 * module exports no `mapInput` or exports an accepted one.
 */
const judgeMapInput = (exports: RouteModuleExports): string | undefined => {
  if (!exports.named.has('mapInput')) return undefined;
  if (exports.namedAmbient.has('mapInput')) {
    return 'mapInput is an ambient declaration (declare function or declare const), which emits no runtime binding for the shell to call';
  }
  const unresolved = exports.namedUnresolved.get('mapInput');
  if (unresolved !== undefined) {
    return `mapInput is re-exported from ${JSON.stringify(unresolved)}, which cannot be followed statically to a function`;
  }
  if (exports.namedGeneratorFunctions.has('mapInput')) {
    return exports.namedAsyncFunctions.has('mapInput')
      ? 'mapInput is an async generator function, which yields an async iterator instead of returning the mapped input'
      : 'mapInput is a generator function, which yields an iterator instead of returning the mapped input';
  }
  if (exports.namedAsyncFunctions.has('mapInput')) {
    return 'mapInput is an async function, which returns a Promise, but the shell applies mapInput synchronously before the canonical inputSchema validates';
  }
  if (!exports.namedFunctions.has('mapInput')) return 'mapInput is exported but is not statically a function';
  return undefined;
};

/**
 * Statically extracts one projection module: its `config` through the
 * unchanged route-config grammar (`extractRouteConfig`), validated against
 * the closed `CliProjectionConfig` key set and bound to the tool's contract,
 * and whether it exports a `mapInput` the shell can call (`judgeMapInput`
 * over `scanRouteModuleExports`). The module is parsed, never executed. Every
 * failure is `AB4844` (the module's own contract) or `AB4845` (binding to
 * the tool's argv grammar), addressed as
 * `CLI projection <module> for tool:<server>/<tool>: <detail>.` on the
 * module's own path; a module with any AB4844 extracts the empty config.
 */
export const extractCliProjection = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
  contract: RouteInputSchema | undefined,
  tool: CompiledAgentRoute,
  options: CliProjectionExtractionOptions = {},
): ExtractedCliProjection => {
  const report = {
    binding: (detail: string, recovery?: string): Diagnostic =>
      cliProjectionBindingError(relativePath, tool.id, detail, sourcePath, recovery),
    contract: (detail: string, recovery?: string): Diagnostic =>
      cliProjectionContractError(relativePath, tool.id, detail, sourcePath, recovery),
  };
  const diagnostics: Diagnostic[] = [];
  const exports = scanRouteModuleExports(moduleText, relativePath, { source: sourcePath });
  const mapInputDetail = judgeMapInput(exports);
  if (mapInputDetail !== undefined) diagnostics.push(report.contract(mapInputDetail, mapInputRecovery));
  const mapInput = exports.named.has('mapInput') && mapInputDetail === undefined;

  if (!exports.named.has('config')) {
    diagnostics.push(report.contract('the module exports no config', grammarRecovery));
    return deepFreeze({ config: emptyProjectionConfig, diagnostics, mapInput });
  }
  const extracted = extractRouteConfig(moduleText, relativePath, sourcePath, {
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
  });
  if (extracted.diagnostics.length > 0) {
    for (const diagnostic of extracted.diagnostics) {
      diagnostics.push(report.contract(configReason(diagnostic, relativePath), grammarRecovery));
    }
    return deepFreeze({ config: emptyProjectionConfig, diagnostics, mapInput });
  }
  // An `appResourceUri()` reference has no App to resolve against here; the
  // reference text is not a projection value.
  for (const reference of extracted.appReferences) {
    diagnostics.push(report.contract(
      `config references MCP App ${JSON.stringify(reference.reference)} at ${reference.position}; a CLI projection carries no App reference`,
    ));
  }
  const validated = validateProjectionConfig(extracted.config);
  for (const detail of validated.details) diagnostics.push(report.contract(detail));
  if (validated.config === undefined || diagnostics.length > 0) {
    return deepFreeze({ config: emptyProjectionConfig, diagnostics, mapInput });
  }
  diagnostics.push(...bindProjectionConfig(validated.config, contract, mapInput, report));
  return deepFreeze({ config: validated.config, diagnostics, mapInput });
};
