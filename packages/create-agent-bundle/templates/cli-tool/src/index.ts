/** The package's library export: emitted to dist/ with declarations by the `src/index.ts` convention. */

export interface Greeting {
  readonly message: string;
  readonly name: string;
}

export const greet = (name: string): Greeting => {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('A name is required.');
  return { message: `Hello, ${trimmed}!`, name: trimmed };
};
