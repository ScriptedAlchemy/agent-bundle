import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type { CliProjectionFlagDefault } from './public.ts';
import type {
  CompiledCliOption,
  RouteInputArrayItemSchema,
  RouteInputPropertySchema,
  RouteInputSchema,
} from './types.ts';

/** The explicit JSON Schema metadata representable as CLI flags. */
export const cliArgvGrammar = 'object JSON Schema with string, number, boolean, enum, or scalar-array properties';

interface ScalarBase {
  readonly choices?: readonly string[];
  readonly kind: 'boolean' | 'enum' | 'number' | 'string';
}
interface StaticInputSchemaProperty {
  readonly base: ScalarBase;
  readonly defaultValue?: unknown;
  readonly description?: string;
  readonly hasDefault: boolean;
  readonly key: string;
  readonly optional: boolean;
  readonly repeated: boolean;
}

/** Option names the generated CLI shell owns; schema keys must not project onto them. */
export const reservedCliOptionNames: ReadonlySet<string> = Object.freeze(new Set([
  'help',
  'json',
  'ndjson',
  'version',
]));

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
 * Why one canonical key cannot appear on a command at all, whatever it is
 * spelled: the shell keys parsed values by canonical key, so a key it owns
 * (`yes` on a confirming command, which the shell reads and strips) is
 * unreachable by the route even under a `name` override. Reported through
 * `CliOptionPolicy.overrideError`; `detail` continues the message subject
 * without a final period.
 */
export interface CliReservedKey {
  readonly detail: string;
  readonly recovery?: string;
}

/**
 * What one caller adds to the default argv policy. `label` names the schema's
 * owner in AB4814 messages (`CLI route <path>` when absent); a
 * projected tool relabels them so the tool module, not a CLI route, is named.
 * `overrides` are the projection's per-key `flags`; a failure they cause —
 * a spelling that is not kebab-case, reserved, or claimed twice, a default
 * outside the key's kind — is reported through `overrideError`, whose detail
 * continues `flags.<key>...`, instead of as a grammar error of the schema.
 * `reserved` extends the shell-owned spellings (`yes` for a confirming
 * command); `reservedKeys` names canonical keys the shell owns outright, each
 * with the detail `overrideError` reports for it.
 */
export interface CliOptionPolicy {
  readonly label?: string;
  readonly overrideError?: (detail: string, recovery?: string) => Diagnostic;
  readonly overrides?: Readonly<Record<string, CliOptionOverride>>;
  readonly reserved?: readonly string[];
  readonly reservedKeys?: Readonly<Record<string, CliReservedKey>>;
}

const grammarRecovery = `Restrict config.inputJsonSchema to the bounded argv grammar (${cliArgvGrammar}), then inspect again.`;

const argvError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4814',
  message,
  recovery: grammarRecovery,
  severity: 'error',
  sourcePath,
});

const defaultLabel = (relativePath: string): string => `CLI route ${relativePath}`;

const optionNameOf = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
  .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
  .toLowerCase();

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type CliPropertyProjection =
  | { readonly diagnostic: Diagnostic }
  | {
    readonly option: CompiledCliOption;
    /** True when a projection override made a canonical-required key optional on argv. */
    readonly relaxed?: true;
  };

/** The resolved policy one projection runs under: the label, the reserved set, and the override reporter. */
interface ResolvedCliOptionPolicy {
  readonly label: string;
  readonly overrideError: (detail: string, recovery?: string) => Diagnostic;
  readonly overrides: Readonly<Record<string, CliOptionOverride>>;
  readonly reserved: ReadonlySet<string>;
  readonly reservedKeys: Readonly<Record<string, CliReservedKey>>;
  readonly sourcePath: string;
}

const resolvePolicy = (policy: CliOptionPolicy, relativePath: string, sourcePath: string): ResolvedCliOptionPolicy => {
  const label = policy.label ?? defaultLabel(relativePath);
  return {
    label,
    // Without a reporter an override failure is a grammar error of the owner,
    // which is what a caller passing overrides without one would read anyway.
    overrideError: policy.overrideError ?? ((detail) => argvError(`${label} ${detail}.`, sourcePath)),
    overrides: policy.overrides ?? {},
    reserved: new Set([...reservedCliOptionNames, ...(policy.reserved ?? [])]),
    reservedKeys: policy.reservedKeys ?? {},
    sourcePath,
  };
};

const describeKind = (base: ScalarBase): string =>
  base.kind === 'enum' ? `one of ${(base.choices ?? []).map((choice) => JSON.stringify(choice)).join(', ')}` : base.kind;

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
 * The argv policy for one schema property: reserved keys, the flag rule,
 * kebab-case naming, and reserved names, applied to the final spelling — a
 * projection's `name` and `aliases` included — and the projection's
 * `default` judged against the key's kind.
 */
const cliOptionFor = (
  property: StaticInputSchemaProperty,
  policy: ResolvedCliOptionPolicy,
): CliPropertyProjection => {
  const { key } = property;
  // A key the shell owns is judged before any spelling: no `name` reaches it.
  const reservedKey = policy.reservedKeys[key];
  if (reservedKey !== undefined) {
    return { diagnostic: policy.overrideError(reservedKey.detail, reservedKey.recovery) };
  }
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
      // Help shows the effective default; only the projection's own default
      // is also recorded in `defaults` for the shell to apply.
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
 * diagnostic fired. `defaults` maps, keys sorted, each canonical key whose
 * projection override declared a CLI `default` to that literal — the
 * schema's own `.default()` values are not in it; absent when no override
 * did. `relaxed` lists, sorted, the canonical-required keys a projection
 * override (`required: false` or a CLI `default`) made optional on argv;
 * absent when none was.
 */
export interface ProjectedCliOptions {
  readonly defaults?: Readonly<Record<string, CliProjectionFlagDefault>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly options?: readonly CompiledCliOption[];
  readonly relaxed?: readonly string[];
}

interface SpellingClaim {
  readonly key: string;
  readonly overridden: boolean;
}

const projectOptions = (
  entries: readonly { readonly property: StaticInputSchemaProperty }[],
  policy: ResolvedCliOptionPolicy,
): ProjectedCliOptions => {
  const defaults: Record<string, CliProjectionFlagDefault> = {};
  const diagnostics: Diagnostic[] = [];
  const options: CompiledCliOption[] = [];
  const relaxed: string[] = [];
  const seenSpellings = new Map<string, SpellingClaim>();
  for (const entry of entries) {
    const projected = cliOptionFor(entry.property, policy);
    if ('diagnostic' in projected) {
      diagnostics.push(projected.diagnostic);
      continue;
    }
    if (projected.relaxed === true) relaxed.push(entry.property.key);
    const option = projected.option;
    const override = policy.overrides[option.key] ?? {};
    if (override.default !== undefined) defaults[option.key] = override.default;
    const spellings = [option.option, ...(option.aliases ?? [])];
    const collision = spellings.flatMap((spelling, index) => {
      const claimed = seenSpellings.get(spelling);
      return claimed === undefined
        ? []
        : [{
          claim: { key: option.key, overridden: index > 0 || override.name !== undefined },
          claimed,
          spelling,
        }];
    })[0];
    if (collision !== undefined) {
      const { claim, claimed, spelling } = collision;
      diagnostics.push(claim.overridden || claimed.overridden
        ? policy.overrideError(
          `flags spell --${spelling} for both ${JSON.stringify(claimed.key)} and ${JSON.stringify(claim.key)}; two options collide on one spelling`,
        )
        : argvError(
          `${policy.label} properties ${JSON.stringify(claimed.key)} and ${JSON.stringify(claim.key)} both project onto --${spelling}.`,
          policy.sourcePath,
        ));
      continue;
    }
    for (const [index, spelling] of spellings.entries()) {
      seenSpellings.set(spelling, { key: option.key, overridden: index > 0 || override.name !== undefined });
    }
    options.push(option);
  }
  if (diagnostics.length > 0) return { diagnostics };
  const sortedDefaults = Object.fromEntries(
    Object.entries(defaults).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    ...(Object.keys(sortedDefaults).length === 0 ? {} : { defaults: sortedDefaults }),
    diagnostics: [],
    options: [...options].sort((left, right) => left.option.localeCompare(right.option)),
    ...(relaxed.length === 0 ? {} : { relaxed: [...relaxed].sort((left, right) => left.localeCompare(right)) }),
  };
};

const scalarBaseOfSchema = (schema: RouteInputArrayItemSchema): ScalarBase =>
  schema.type === 'string' && schema.enum !== undefined
    ? { choices: schema.enum, kind: 'enum' }
    : { kind: schema.type };

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
