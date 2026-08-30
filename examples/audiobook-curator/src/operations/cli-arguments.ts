/**
 * Shared argv toolkit for every operation's `cli.parse` projection. The
 * framework's CLI contract is a bare `(argv) => input` function, so option
 * lookup, flag validation, and positional handling live here once instead of
 * being repeated in each command.
 */

export const optionValue = (args: readonly string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
};

export const assertOptions = (args: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>): void => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) continue;
    if (flags.has(argument)) continue;
    if (valued.has(argument)) {
      index += 1;
      if (args[index] === undefined || args[index]!.startsWith('--')) throw new Error(`${argument} requires a value.`);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
};

export const positionalArguments = (args: readonly string[], valued: ReadonlySet<string>): readonly string[] => {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valued.has(args[index]!)) {
      index += 1;
    } else if (!args[index]!.startsWith('--')) {
      positional.push(args[index]!);
    }
  }
  return positional;
};

export const onePath = (args: readonly string[], valued: ReadonlySet<string>, command: string): string => {
  const positional = positionalArguments(args, valued);
  if (positional.length !== 1) throw new Error(`${command} requires exactly one path.`);
  return positional[0]!;
};

export const requiredOption = (args: readonly string[], option: string, command: string): string => {
  const value = optionValue(args, option);
  if (value === undefined) throw new Error(`${command} requires ${option}.`);
  return value;
};

export const optionChoice = <T extends string>(
  args: readonly string[],
  option: string,
  choices: readonly T[],
): T | undefined => {
  const value = optionValue(args, option);
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) throw new Error(`${option} must be one of: ${choices.join(', ')}.`);
  return value as T;
};

export const numberOption = (args: readonly string[], option: string): number | undefined => {
  const value = optionValue(args, option);
  return value === undefined ? undefined : Number(value);
};

/** Spread helper that omits the key entirely when the option is absent, so parsed inputs never carry explicit `undefined` entries. */
export const optionalField = <K extends string, V>(key: K, value: V | undefined): Readonly<Partial<Record<K, V>>> =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
