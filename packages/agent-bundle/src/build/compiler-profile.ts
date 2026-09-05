import { parseRuntimeVersion } from '../core/runtime.ts';

/**
 * Node floor of the compiler host, aligned with this package's
 * `engines.node` (`>=22.19.0`). Generated Node executables target syntax
 * that this floor can parse.
 */
export const compilerHostNodeFloor = '22.19.0';

/**
 * ECMAScript syntax Rslib can emit for a generated-executable Node floor.
 * Node 22 runs ES2022 (class fields, top-level await, private methods)
 * without downleveling; a floor below 22 is not a supported engines range.
 */
export const generatedExecutableSyntaxFor = (floor: string): 'es2022' => {
  const version = parseRuntimeVersion(floor);
  if (version === undefined) {
    throw new Error(`Generated-executable Node floor ${JSON.stringify(floor)} is not major.minor[.patch].`);
  }
  if (version[0] < 22) {
    throw new Error(
      `Generated-executable Node floor ${floor} is below Node 22, the ES2022 baseline.`,
    );
  }
  return 'es2022';
};

export const generatedExecutableSyntax = generatedExecutableSyntaxFor(compilerHostNodeFloor);

/**
 * Policy for a future profile that enables minification: license comments
 * must stay inside the executable. The current profile sets `minify: false`,
 * so this option does not change today's emitted bytes. `linked` would emit a
 * `<name>.LICENSE.txt` sibling once minification is enabled, but artifact
 * provenance and package builds require an exact planned file set.
 */
export const generatedExecutableLegalComments = 'inline' as const;

/**
 * Public `output.sourceMap` opt-in. Sibling `.map` files have the same
 * unplanned-asset problem as linked LICENSE files, so the profile inlines
 * the map into the executable when the key is true.
 */
export const generatedExecutableSourceMap = (
  optIn: boolean,
): false | { readonly js: 'inline-source-map' } => (optIn ? { js: 'inline-source-map' } : false);
