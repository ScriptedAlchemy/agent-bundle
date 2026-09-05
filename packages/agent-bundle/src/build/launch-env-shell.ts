/**
 * The operator `.env` layer of an installed pack (#469): a plain-Node module
 * aliased into every artifact shell that runs plugin code — the stdio MCP
 * entry, the hook wrappers, the artifact CLI executable — so an installed
 * pack reads `<plugin root>/.env` and `.env.local` (or `AGENT_BUNDLE_ENV_FILE`)
 * at launch the way `agent-bundle mcp run` composes them: filling only the
 * variables the host did not set, never logging a value.
 */
export const launchEnvRuntimeSpecifier = 'agent-bundle/launch-env';

// This module is imported by the hook contract and may be re-bundled by a
// consumer, so it stays free of filesystem probing and
// `new URL(…, import.meta.url)`: `launchEnvRuntimePath` lives in
// `entry-shell.ts` beside the other paths.

/**
 * The generated module that applies the layer, served virtually to each
 * shell's compilation and imported by the shell before anything else.
 *
 * Why a module and not a statement in the shell body: Rspack inlines the
 * modules of a single-chunk bundle into one scope, and every inlined module
 * — a statically imported handler as much as a `loadEntry: () => import()`
 * target — evaluates before the entry module's own body. A statement in the
 * shell therefore ran after every consumer module had already read
 * `process.env` at its top level. ESM import order is what the bundler does
 * preserve, so the layer is the shell's first import and evaluates before
 * the handler, the route and provider modules, the state definition, and
 * the server module.
 */
export const launchEnvLayerSpecifier = 'agent-bundle/launch-env-layer';

/**
 * The import the hook wrappers and the artifact CLI bin place first. The
 * stdio MCP shell imports its prelude instead (`stdioPreludeImport` in
 * `entry-shell.ts`), which applies this same layer after installing the
 * stdout guard: stdout is the protocol wire there, while hooks and the CLI
 * legitimately write it.
 */
export const operatorEnvLayerImport = `import ${JSON.stringify(launchEnvLayerSpecifier)};`;

/** The imports the layer statement needs, shared with the stdio prelude. */
export const operatorEnvLayerImports: readonly string[] = [
  "import { fileURLToPath } from 'node:url';",
  `import { applyOperatorEnv, operatorEnvPluginRoot } from ${JSON.stringify(launchEnvRuntimeSpecifier)};`,
];

/**
 * The statement that applies the layer. Every artifact shell lives one
 * directory below the plugin root (`mcp/`, `hooks/`, `bin/`), so the fallback
 * anchor — used when the host set no `AGENT_BUNDLE_PLUGIN_ROOT` — is the
 * bundle's parent directory, the same fallback the durable-state kernel uses
 * (`import.meta.url` stays native in the emitted ESM, so it names the bundle).
 *
 * A stdio MCP shell embeds its server's manifest `env` block as build-time
 * literals (`manifestEnv`): the host merges that block into the child
 * environment before launch, and only a shell that knows the defaults can
 * let the file beat them while an exported variable still wins. Hook
 * wrappers and the CLI bin have no manifest env and embed none.
 */
export const operatorEnvLayerStatement = (manifestEnv?: Readonly<Record<string, string>>): string => {
  const defaults = Object.entries(manifestEnv ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const manifestField = defaults.length === 0
    ? ''
    : `manifestEnv: ${JSON.stringify(Object.fromEntries(defaults))}, `;
  return `applyOperatorEnv({ ${manifestField}pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });`;
};

/** The source of the env-only layer module. */
export const operatorEnvLayerModuleSource = (manifestEnv?: Readonly<Record<string, string>>): string =>
  [...operatorEnvLayerImports, '', operatorEnvLayerStatement(manifestEnv), ''].join('\n');

/** The layer as the virtual module an Rslib entry serves beside its wrapper. */
export const operatorEnvLayerVirtualModule = (
  manifestEnv?: Readonly<Record<string, string>>,
): { readonly name: string; readonly source: string } => ({
  name: launchEnvLayerSpecifier,
  source: operatorEnvLayerModuleSource(manifestEnv),
});
