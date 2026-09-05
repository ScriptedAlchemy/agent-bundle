import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import {
  parseInputSchema,
  type InputSchemaExtractionOptions,
  type InputSchemaResolutionFailure,
  type ParsedInputSchemaEntry,
  type ResolvedSchemaOrigin,
  type ScalarBase,
  type StaticInputSchemaProperty,
} from './input-schema.ts';
import type { CliProjectionFlagDefault } from './public.ts';
import type {
  CompiledCliOption,
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
} from './types.ts';

/**
 * The bounded zod-to-argv grammar (#102 stage 2). A routed CLI command's
 * `inputSchema` is projected onto argv statically — the module is parsed,
 * never executed. Parsing and property-chain interpretation are shared with
 * the route JSON-Schema projection; argv-specific naming and flag policy stay
 * here.
 */
export const cliArgvGrammar =
  'z.object of z.string/z.number/z.boolean/z.enum/z.array chains with optional/default/describe and bounded validation-only refinements';

/** Option names the generated CLI shell owns; schema keys must not project onto them. */
export const reservedCliOptionNames: ReadonlySet<string> = Object.freeze(new Set([
  'help',
  'json',
  'ndjson',
  'version',
]));

/**
 * The statically extracted argv projection of one CLI route module's
 * `inputSchema` export. `found` is false when the module has no extractable
 * `export const inputSchema` declaration (the route-contract diagnostic owns
 * that state); `options` is absent whenever a diagnostic fired; `origin` is
 * where the schema is declared whenever that is known; `relaxed` is the
 * projection's, as `ProjectedCliOptions` documents.
 */
export interface ExtractedCliArgv extends ProjectedCliOptions {
  readonly found: boolean;
  readonly origin?: ResolvedSchemaOrigin;
}

/**
 * How a CLI projection module (`<tool>.cli.{ts,tsx}`, #596) respells one
 * canonical key on argv: the validated `flags.<key>` entry, applied inside
 * the one option policy so the kebab-case, reserved-name, and collision rules
 * judge the final spellings.
 */
export interface CliOptionOverride {
  readonly aliases?: readonly string[];
  readonly default?: CliProjectionFlagDefault;
  readonly description?: string;
  readonly name?: string;
  readonly required?: false;
}

/**
 * What one caller adds to the default argv policy. `label` names the schema's
 * owner in AB4814/AB4838/AB4839 messages (`CLI route <path>` when absent); a
 * projected tool relabels them so the tool module, not a CLI route, is named.
 * `overrides` are the projection's per-key `flags`; a failure they cause —
 * a spelling that is not kebab-case, reserved, or claimed twice, a default
 * outside the key's kind — is reported through `overrideError`, whose detail
 * continues `flags.<key>...`, instead of as a grammar error of the schema.
 * `reserved` extends the shell-owned spellings (`yes` for a confirming
 * command).
 */
export interface CliOptionPolicy {
  readonly label?: string;
  readonly overrideError?: (detail: string) => Diagnostic;
  readonly overrides?: Readonly<Record<string, CliOptionOverride>>;
  readonly reserved?: readonly string[];
}

const grammarRecovery = `Restrict the inputSchema initializer to the bounded argv grammar (${cliArgvGrammar}), then inspect again.`;

const argvError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4814',
  message,
  recovery: grammarRecovery,
  severity: 'error',
  sourcePath,
});

const resolutionRecovery = 'Declare the schema inline, or reference a top-level `export const` of a module reached through relative imports inside the project (alias chains such as `export const inputSchema = shared` are followed); then inspect again.';

const defaultLabel = (relativePath: string): string => `CLI route ${relativePath}`;

/**
 * The parser (input-schema.ts) words every grammar issue for the CLI route
 * it was written for, `CLI route <relativePath> ...`; a caller projecting
 * another owner's schema (a tool route with a CLI projection) reads the same
 * issue under its own label.
 */
const relabelIssue = (issue: string, relativePath: string, label: string): string => {
  const prefix = defaultLabel(relativePath);
  return label !== prefix && issue.startsWith(prefix) ? `${label}${issue.slice(prefix.length)}` : issue;
};

/** AB4838 for a reference the static resolver cannot follow; AB4839 for a reference cycle. */
const resolutionError = (
  failure: InputSchemaResolutionFailure,
  label: string,
  sourcePath: string,
): Diagnostic => {
  const chain = failure.chain.join(' -> ');
  return {
    code: failure.kind === 'cycle' ? 'AB4839' : 'AB4838',
    message: failure.kind === 'cycle'
      ? `${label} inputSchema: ${chain} is a reference cycle.`
      : `${label} inputSchema: ${chain} ${failure.reason}.`,
    recovery: resolutionRecovery,
    severity: 'error',
    sourcePath,
  };
};

const optionNameOf = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
  .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
  .toLowerCase();

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface CliPropertyProjection {
  readonly diagnostic?: Diagnostic;
  readonly option?: CompiledCliOption;
  /** True when a projection override made a canonical-required key optional on argv. */
  readonly relaxed?: boolean;
}

/** The resolved policy one projection runs under: the label, the reserved set, and the override reporter. */
interface ResolvedCliOptionPolicy {
  readonly label: string;
  readonly overrideError: (detail: string) => Diagnostic;
  readonly overrides: Readonly<Record<string, CliOptionOverride>>;
  readonly reserved: ReadonlySet<string>;
  readonly sourcePath: string;
}

const resolvePolicy = (policy: CliOptionPolicy, relativePath: string, sourcePath: string): ResolvedCliOptionPolicy => ({
  label: policy.label ?? defaultLabel(relativePath),
  // Without a reporter an override failure is a grammar error of the owner,
  // which is what a caller passing overrides without one would read anyway.
  overrideError: policy.overrideError
    ?? ((detail) => argvError(`${policy.label ?? defaultLabel(relativePath)} ${detail}.`, sourcePath)),
  overrides: policy.overrides ?? {},
  reserved: new Set([...reservedCliOptionNames, ...(policy.reserved ?? [])]),
  sourcePath,
});

const describeKind = (base: ScalarBase): string =>
  base.kind === 'enum' ? `one of ${(base.choices ?? []).map((choice) => JSON.stringify(choice)).join(', ')}` : base.kind;

/** True when `value` is one value of the property's scalar base. */
const matchesKind = (base: ScalarBase, value: unknown): boolean => {
  switch (base.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && (base.choices ?? []).includes(value);
    default: {
      const unreachable: never = base.kind;
      throw new TypeError(`Unhandled scalar base ${String(unreachable)}.`);
    }
  }
};

/**
 * The argv policy for one schema property: flag rule, kebab-case naming, and
 * reserved names, applied to the final spelling — a projection's `name` and
 * `aliases` included — and the projection's `default` judged against the
 * key's kind.
 */
const cliOptionFor = (
  property: StaticInputSchemaProperty,
  policy: ResolvedCliOptionPolicy,
): CliPropertyProjection => {
  const { key } = property;
  const override = policy.overrides[key] ?? {};
  const canonicallyRequired = !property.optional && !property.hasDefault;
  const relaxed = canonicallyRequired && (override.required === false || override.default !== undefined);
  const required = canonicallyRequired && !relaxed;
  if (property.base.kind === 'boolean' && required) {
    return {
      diagnostic: argvError(
        `${policy.label} property ${JSON.stringify(key)}: a required boolean cannot be expressed as a flag; add .optional() or .default(false).`,
        policy.sourcePath,
      ),
    };
  }

  const option = override.name ?? optionNameOf(key);
  if (!kebabCase.test(option)) {
    return {
      diagnostic: override.name === undefined
        ? argvError(
          `${policy.label} property ${JSON.stringify(key)} does not project onto a kebab-case option name.`,
          policy.sourcePath,
        )
        : policy.overrideError(`flags.${key}.name ${JSON.stringify(option)} is not a kebab-case option name`),
    };
  }
  if (policy.reserved.has(option)) {
    return {
      diagnostic: override.name === undefined
        ? argvError(
          `${policy.label} property ${JSON.stringify(key)} projects onto the reserved option --${option}.`,
          policy.sourcePath,
        )
        : policy.overrideError(`flags.${key}.name ${JSON.stringify(option)} is the reserved option --${option}`),
    };
  }
  const aliases = override.aliases ?? [];
  for (const [index, alias] of aliases.entries()) {
    if (!kebabCase.test(alias)) {
      return { diagnostic: policy.overrideError(`flags.${key}.aliases entry ${JSON.stringify(alias)} is not a kebab-case option name`) };
    }
    if (policy.reserved.has(alias)) {
      return { diagnostic: policy.overrideError(`flags.${key}.aliases entry ${JSON.stringify(alias)} is the reserved option --${alias}`) };
    }
    if (alias === option || aliases.indexOf(alias) !== index) {
      return { diagnostic: policy.overrideError(`flags.${key}.aliases repeats the spelling --${alias}`) };
    }
  }

  if (override.default !== undefined) {
    const values = Array.isArray(override.default) ? override.default : [override.default];
    const shape = property.repeated ? `an array of ${describeKind(property.base)}` : describeKind(property.base);
    if (property.repeated !== Array.isArray(override.default) || !values.every((value) => matchesKind(property.base, value))) {
      return { diagnostic: policy.overrideError(`flags.${key}.default ${JSON.stringify(override.default)} is not ${shape}`) };
    }
  }

  const description = override.description ?? property.description;
  return {
    ...(relaxed ? { relaxed } : {}),
    option: {
      ...(aliases.length === 0 ? {} : { aliases }),
      ...(property.base.choices === undefined ? {} : { choices: property.base.choices }),
      ...(override.default !== undefined
        ? { defaultValue: override.default }
        : property.hasDefault
          ? { defaultValue: property.defaultValue }
          : {}),
      ...(description === undefined ? {} : { description }),
      key,
      kind: property.base.kind,
      option,
      repeated: property.repeated,
      required,
    },
  };
};

/**
 * The option surface one schema projects onto; `options` is absent whenever a
 * diagnostic fired. `relaxed` lists, sorted, the canonical-required keys a
 * projection override (`required: false` or a CLI `default`) made optional on
 * argv; absent when none was.
 */
export interface ProjectedCliOptions {
  readonly diagnostics: readonly Diagnostic[];
  readonly options?: readonly CompiledCliOption[];
  readonly relaxed?: readonly string[];
}

/** Who claimed one `--spelling`: the key, and whether the projection's override spelled it. */
interface SpellingClaim {
  readonly key: string;
  readonly overridden: boolean;
}

/** The one argv projection policy: per-property rules, then option-name collisions, then deterministic order. */
const projectOptions = (
  entries: readonly ParsedInputSchemaEntry[],
  policy: ResolvedCliOptionPolicy,
): ProjectedCliOptions => {
  const diagnostics: Diagnostic[] = [];
  const options: CompiledCliOption[] = [];
  const relaxed: string[] = [];
  const seenSpellings = new Map<string, SpellingClaim>();
  for (const entry of entries) {
    if ('issue' in entry) {
      diagnostics.push(argvError(entry.issue, policy.sourcePath));
      continue;
    }
    const projected = cliOptionFor(entry.property, policy);
    if (projected.diagnostic !== undefined) {
      diagnostics.push(projected.diagnostic);
      continue;
    }
    if (projected.relaxed === true) relaxed.push(entry.property.key);
    const option = projected.option!;
    const override = policy.overrides[option.key] ?? {};
    const spellings: readonly SpellingClaim[] = [
      { key: option.key, overridden: override.name !== undefined },
      ...(option.aliases ?? []).map(() => ({ key: option.key, overridden: true })),
    ];
    const collision = [option.option, ...(option.aliases ?? [])]
      .map((spelling, index) => ({ claimed: seenSpellings.get(spelling), claim: spellings[index]!, spelling }))
      .find((candidate) => candidate.claimed !== undefined);
    if (collision !== undefined) {
      const { claim, claimed, spelling } = collision;
      diagnostics.push(claim.overridden || claimed!.overridden
        ? policy.overrideError(
          `flags spell --${spelling} for both ${JSON.stringify(claimed!.key)} and ${JSON.stringify(claim.key)}; two options collide on one spelling`,
        )
        : argvError(
          `${policy.label} properties ${JSON.stringify(claimed!.key)} and ${JSON.stringify(claim.key)} both project onto --${spelling}.`,
          policy.sourcePath,
        ));
      continue;
    }
    for (const [index, spelling] of [option.option, ...(option.aliases ?? [])].entries()) {
      seenSpellings.set(spelling, spellings[index]!);
    }
    options.push(option);
  }
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics: [],
    options: [...options].sort((left, right) => left.option.localeCompare(right.option)),
    ...(relaxed.length === 0 ? {} : { relaxed: [...relaxed].sort((left, right) => left.localeCompare(right)) }),
  };
};

const scalarBaseOfSchema = (schema: RouteInputArrayItemSchema): ScalarBase =>
  schema.type === 'string' && schema.enum !== undefined
    ? { choices: schema.enum, kind: 'enum' }
    : { kind: schema.type };

/** One canonical contract property in the shape the module parse produces, so both take the same policy. */
const staticPropertyOf = (
  key: string,
  schema: RouteInputPropertySchema,
  required: readonly string[],
): StaticInputSchemaProperty => ({
  base: schema.type === 'array' ? scalarBaseOfSchema(schema.items) : scalarBaseOfSchema(schema),
  ...(schema.default === undefined ? {} : { defaultValue: schema.default }),
  ...(schema.description === undefined ? {} : { description: schema.description }),
  hasDefault: schema.default !== undefined,
  key,
  optional: !required.includes(key),
  repeated: schema.type === 'array',
});

/**
 * Projects a route's canonical input contract — the `RouteInputSchema`
 * graph.ts normalized once, shared by every route bound to it — onto argv
 * with exactly the policy the module parse applies, so the command grammar
 * is a projection of the contract rather than a second reading of the
 * module.
 */
export const projectInputSchemaOptions = (
  schema: RouteInputSchema,
  relativePath: string,
  sourcePath: string,
  policy: CliOptionPolicy = {},
): ProjectedCliOptions => deepFreeze(projectOptions(
  Object.entries(schema.properties).map(([key, property]) => ({
    property: staticPropertyOf(key, property, schema.required ?? []),
  })),
  resolvePolicy(policy, relativePath, sourcePath),
));

/** Where the module's `inputSchema` references resolve, plus the option policy its owner runs under. */
export interface ExtractCliArgvOptions extends InputSchemaExtractionOptions {
  readonly policy?: CliOptionPolicy;
}

/**
 * Statically projects one CLI route module's `export const inputSchema`
 * declaration onto the argv contract. The module is parsed with the
 * TypeScript compiler and never executed; validation-only refinements pass
 * through uninterpreted because the real zod schema validates at run time. A
 * schema reached through a reference the resolver cannot follow is AB4838
 * (AB4839 for a cycle); grammar issues stay AB4814. A tool route with a CLI
 * projection is parsed the same way, under its own `policy.label`.
 */
export const extractCliArgv = (
  moduleText: string,
  relativePath: string,
  sourcePath: string,
  options: ExtractCliArgvOptions = {},
): ExtractedCliArgv => {
  const { policy = {}, ...extraction } = options;
  const resolved = resolvePolicy(policy, relativePath, sourcePath);
  const parsed = parseInputSchema(moduleText, relativePath, extraction);
  if (!parsed.found) return deepFreeze({ diagnostics: [], found: false });
  const origin = parsed.origin === undefined ? {} : { origin: parsed.origin };
  if (parsed.entries === undefined) {
    return deepFreeze({
      diagnostics: [
        ...parsed.issues.map((issue) => argvError(relabelIssue(issue, relativePath, resolved.label), sourcePath)),
        ...(parsed.resolution === undefined ? [] : [resolutionError(parsed.resolution, resolved.label, sourcePath)]),
      ],
      found: true,
      ...origin,
    });
  }
  const entries = parsed.entries.map((entry) =>
    'issue' in entry ? { issue: relabelIssue(entry.issue, relativePath, resolved.label) } : entry);
  return deepFreeze({ ...projectOptions(entries, resolved), found: true, ...origin });
};
