import { parseRuntimeVersion } from '../core/runtime.ts';

/**
 * Node floor the generated-executable compiler profile assumes. Must stay
 * aligned with this package's `engines.node` (`>=22.19.0`).
 */
export const generatedExecutableNodeFloor = '22.19.0';

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

export const generatedExecutableSyntax = generatedExecutableSyntaxFor(generatedExecutableNodeFloor);

/**
 * License comments stay inside the executable. `linked` would emit a
 * `<name>.LICENSE.txt` sibling, but artifact provenance
 * (`createArtifactManifestFiles`) and the package build both require an
 * exact planned file set — an unplanned license asset fails the build —
 * so `inline` is the only mode that keeps licenses in the artifact and
 * preserves the self-contained single-file guarantee.
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
