/**
 * The operator `.env` layer of an installed pack (#469): a plain-Node module
 * aliased into every artifact shell that runs plugin code — the stdio MCP
 * entry, the hook wrappers, the artifact CLI executable — so an installed
 * pack reads `<plugin root>/.env` and `.env.local` (or `AGENT_BUNDLE_ENV_FILE`)
 * at launch the way `agent-bundle mcp run` composes them: filling only the
 * variables the host did not set, never logging a value.
 */
export const launchEnvRuntimeSpecifier = 'agent-bundle/launch-env';

// This module is imported by the hook contract, which the installer bundle
// (`install-entry`) also carries and a consumer's own Rspack run re-bundles,
// so it must stay free of filesystem probing and `new URL(…, import.meta.url)`:
// `launchEnvRuntimePath` lives in `entry-shell.ts` beside the other paths.


/**
 * The import lines of the operator env layer. `fileURLToPath` is emitted
 * only when the module does not already import it, so a bundle never
 * declares one binding twice.
 */
export const operatorEnvImports = (options: { readonly importsFileUrlToPath: boolean }): readonly string[] => [
  ...(options.importsFileUrlToPath ? [] : ["import { fileURLToPath } from 'node:url';"]),
  `import { applyOperatorEnv, operatorEnvPluginRoot } from ${JSON.stringify(launchEnvRuntimeSpecifier)};`,
];

/**
 * The statement that applies the layer. Every artifact shell lives one
 * directory below the plugin root (`mcp/`, `hooks/`, `bin/`), so the fallback
 * anchor — used when the host set no `AGENT_BUNDLE_PLUGIN_ROOT` — is the
 * module's parent directory, the same fallback the durable-state kernel uses.
 */
export const operatorEnvStatement =
  "applyOperatorEnv({ pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });";
