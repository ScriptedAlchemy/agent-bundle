/**
 * The build-time project identity constant (issue #237). This package
 * subpath is replaced by the compiler in every compiled plugin surface —
 * Node script, CLI, MCP entry, hook, and package bundles, plus browser MCP
 * App bundles — with the exact identity the artifact manifests, `inspect`,
 * and dev status report. Plugin source imports it instead of maintaining a
 * hand-written `src/lib/version.ts`.
 */
export interface AgentBundleMeta {
  /** The host-native plugin slug from `plugin.name`; never the npm package name. */
  readonly name: string;
  /** The validated npm package name, absent for unpackaged development projects. */
  readonly packageName: string | undefined;
  /** The validated semantic release version, absent for unpackaged development projects. */
  readonly packageVersion: string | undefined;
  /**
   * The resolved plugin version: the authored `plugin.version` when declared,
   * otherwise the package.json version. A release build refuses to package a
   * project that has neither (AB4013), so a compiled artifact never carries
   * the development fallback.
   */
  readonly version: string;
}

/**
 * Every export must throw through a hoisted function declaration: the rslib
 * bundle emits `export default <binding>;` above the const initializers, so a
 * top-level `throw` or a `const`-backed default export surfaces a TDZ
 * ReferenceError instead of this message (the same contract as
 * `agent-bundle/mcp-apps`).
 */
function throwUnavailableEntrypoint(): never {
  throw new Error(
    'agent-bundle/meta is available only inside a surface Agent Bundle compiles; '
    + 'a plugin module reached it outside the compiler.',
  );
}

export const meta: AgentBundleMeta = throwUnavailableEntrypoint();

export const name: AgentBundleMeta['name'] = throwUnavailableEntrypoint();

export const packageName: AgentBundleMeta['packageName'] = throwUnavailableEntrypoint();

export const packageVersion: AgentBundleMeta['packageVersion'] = throwUnavailableEntrypoint();

export const version: AgentBundleMeta['version'] = throwUnavailableEntrypoint();

export default throwUnavailableEntrypoint();
