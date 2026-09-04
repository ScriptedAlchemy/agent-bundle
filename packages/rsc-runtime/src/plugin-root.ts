import { join, resolve } from 'node:path';

import { available, type AgentPluginIdentity, type Observed } from './agent-request.js';

/**
 * The environment variable every emitted stdio entry, hook wrapper, and
 * artifact CLI receives with the plugin install root in the host's own
 * spelling (`${CLAUDE_PLUGIN_ROOT}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`,
 * `./` on Codex). `agent-bundle` exports the same name as `pluginRootEnvAnchor`.
 */
export const PLUGIN_ROOT_ENV_ANCHOR = 'AGENT_BUNDLE_PLUGIN_ROOT';

/** The directory below the anchor where durable state (SQLite kernel, notice ledger, lineage journal) lives. */
export const PLUGIN_STATE_DIRECTORY = 'state';

export interface ResolvePluginRootOptions {
  /** The environment to read; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where the plugin anchors when the host supplies no `AGENT_BUNDLE_PLUGIN_ROOT`:
   * the artifact root (the parent of `mcp/`, `bin/`, `hooks/`) for artifact
   * shells, or the caller's `.agent-bundle` directory for the npm package bin.
   */
  readonly fallback: string;
  /** Receives one line when the anchor is present but unexpanded; stderr by default. */
  readonly warn?: (message: string) => void;
}

/** The anchor a generated shell resolved once and mounts everything on. */
export interface ResolvedPluginRoot extends AgentPluginIdentity {
  /** The same value as an observed request axis, ready for `runAgentRequest({ plugin })`. */
  readonly identity: Observed<AgentPluginIdentity>;
  /** `native` when `AGENT_BUNDLE_PLUGIN_ROOT` supplied the root, `derived` for the fallback. */
  readonly source: 'native' | 'derived';
}

/** A host that passed its manifest through literally leaves `${CLAUDE_PLUGIN_ROOT}`-style tokens in the value. */
const unexpandedToken = /\$\{[^}]*\}/u;

const defaultWarn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * The one resolution of the plugin root / durable-state anchor (#468). The
 * generated MCP entry, its Flight worker, the routed CLI executable, its
 * render worker, and the hook wrappers all call this once at startup, mount
 * SQLite at `stateRoot`, and publish `identity` on every request they open,
 * so `(await agent()).plugin.stateRoot` is by construction the directory the
 * kernel, the notice ledger, and the lineage journal use.
 *
 * `AGENT_BUNDLE_PLUGIN_ROOT` wins when it is set to a non-empty, expanded
 * value (`source: 'native'`). An empty value or one still carrying a `${…}`
 * token is treated as unset — the token case is reported once on stderr,
 * because it means the host did not expand its manifest — and the shell's
 * `fallback` anchors the plugin (`source: 'derived'`). Both roots are made
 * absolute against the working directory, as the kernel always did.
 */
export const resolvePluginRoot = (options: ResolvePluginRootOptions): ResolvedPluginRoot => {
  const env = options.env ?? process.env;
  const declared = env[PLUGIN_ROOT_ENV_ANCHOR]?.trim() ?? '';
  let root: string;
  let source: 'native' | 'derived';
  if (declared === '') {
    root = resolve(options.fallback);
    source = 'derived';
  } else if (unexpandedToken.test(declared)) {
    (options.warn ?? defaultWarn)(
      `[agent-bundle] ${PLUGIN_ROOT_ENV_ANCHOR} is the unexpanded token ${JSON.stringify(declared)}; anchoring the plugin on ${resolve(options.fallback)} instead.`,
    );
    root = resolve(options.fallback);
    source = 'derived';
  } else {
    root = resolve(declared);
    source = 'native';
  }
  const stateRoot = join(root, PLUGIN_STATE_DIRECTORY);
  return Object.freeze({
    identity: available<AgentPluginIdentity>({ root, stateRoot }, source),
    root,
    source,
    stateRoot,
  });
};
