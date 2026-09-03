import type { Diagnostic } from './core/diagnostics.ts';
import { CodedError } from './core/errors.ts';

/**
 * The diagnostic the published `agent-bundle/meta` module raises when a
 * module evaluates it outside every surface the compiler replaces it in
 * (issue #386). It lives beside `meta.ts` rather than inside it so tests and
 * the Rstest presets can name the code and the recovery without evaluating
 * the throwing module.
 */
export const META_UNAVAILABLE_CODE = 'AB4760';

export type MetaUnavailableCode = typeof META_UNAVAILABLE_CODE;

export const META_UNAVAILABLE_MESSAGE =
  'agent-bundle/meta is available only inside a surface Agent Bundle compiles; '
  + 'a plugin module reached it outside the compiler, so no project identity is available.';

/**
 * The exact fix. `agentBundleRstest()` and `agentBundleBrowserRstest()` alias
 * the specifier to a generated module carrying the compiled identity, so a
 * unit or route-unit test never sees this diagnostic; a custom runner has to
 * alias it the same way.
 */
export const META_UNAVAILABLE_RECOVERY =
  'Run the test under agentBundleRstest() or agentBundleBrowserRstest() from agent-bundle/rstest, '
  + 'which alias agent-bundle/meta to the project identity the compiler stamps, or compile the surface with `agent-bundle build`. '
  + 'In a custom test runner, alias `agent-bundle/meta` (resolve.alias, exact match) to a module with the named exports '
  + '{ name, packageName, packageVersion, version, meta } — `meta` the frozen object of the other four, exported as both '
  + 'the named binding and the default export — computed from the project\'s agent-bundle.config.ts plugin name and '
  + 'package.json version; the `.agent-bundle/test/meta.mjs` module agentBundleRstest() writes is that module.';

/** The structured diagnostic, in the same shape every other AB code reports. */
export const metaUnavailableDiagnostic = (): Diagnostic => Object.freeze({
  code: META_UNAVAILABLE_CODE,
  message: META_UNAVAILABLE_MESSAGE,
  recovery: META_UNAVAILABLE_RECOVERY,
  severity: 'error',
});

/**
 * Thrown by every binding of the published `agent-bundle/meta` module. The
 * message carries the code and the recovery inline so a runner that prints
 * only `error.message` still shows the fix; `code`, `recovery`, and the
 * structured `diagnostic` stay addressable for programmatic reporting.
 */
export class MetaUnavailableError extends CodedError<MetaUnavailableCode> {
  readonly diagnostic: Diagnostic;

  readonly recovery: string;

  constructor() {
    const diagnostic = metaUnavailableDiagnostic();
    super(
      'AgentBundleMetaUnavailableError',
      META_UNAVAILABLE_CODE,
      `[${META_UNAVAILABLE_CODE}] ${diagnostic.message}\n  recovery: ${META_UNAVAILABLE_RECOVERY}`,
    );
    this.diagnostic = diagnostic;
    this.recovery = META_UNAVAILABLE_RECOVERY;
  }
}
