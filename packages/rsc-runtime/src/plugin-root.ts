import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { available, type AgentPluginIdentity, type Observed } from './agent-request.js';

/**
 * The environment variable every emitted shell receives with the code root
 * in the host's own spelling.
 */
export const PLUGIN_ROOT_ENV_ANCHOR = 'AGENT_BUNDLE_PLUGIN_ROOT';

/** The optional environment override for the framework state root. */
export const PLUGIN_STATE_ROOT_ENV_ANCHOR = 'AGENT_BUNDLE_STATE_ROOT';

/** The state directory below a root-anchored code root. */
export const PLUGIN_STATE_DIRECTORY = 'state';

export type PluginStateAnchor = 'root' | 'user-data';

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
  /** Where `stateRoot` anchors when `AGENT_BUNDLE_STATE_ROOT` is unset; `'root'` by default. */
  readonly stateAnchor?: PluginStateAnchor;
  /** The user home `'user-data'` anchors under; `os.homedir()` by default. */
  readonly home?: string;
}

/** The code and framework-state roots a generated shell resolved once. */
export interface ResolvedPluginRoot extends AgentPluginIdentity {
  /** The same value as an observed request axis, ready for `runAgentRequest({ plugin })`. */
  readonly identity: Observed<AgentPluginIdentity>;
  /** `native` when `AGENT_BUNDLE_PLUGIN_ROOT` supplied the root, `derived` for the fallback. */
  readonly source: 'native' | 'derived';
  /** `native` when `AGENT_BUNDLE_STATE_ROOT` supplied the state root. */
  readonly stateSource: 'native' | 'derived';
}

/** A host that passed its manifest through literally leaves `${CLAUDE_PLUGIN_ROOT}`-style tokens in the value. */
const unexpandedToken = /\$\{[^}]*\}/u;

const defaultWarn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const safePluginSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

/** One stable, filesystem-safe segment per installed code root. */
export const pluginStateSegment = (root: string): string => {
  const canonicalRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  const name = basename(canonicalRoot);
  return safePluginSegment.test(name) ? `${name}-${digest}` : `plugin-${digest}`;
};

/** The user-level directory that holds framework state for installed plugins. */
export const userStateHome = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string => {
  const xdgStateHome = env.XDG_STATE_HOME ?? '';
  return xdgStateHome.trim() === ''
    ? join(home, '.agent-bundle', PLUGIN_STATE_DIRECTORY)
    : join(xdgStateHome, 'agent-bundle');
};

/** The framework state root for one installed plugin. */
export const userDataStateRoot = (
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
  home?: string,
): string => join(userStateHome(env, home), pluginStateSegment(root));

/**
 * Resolves the code root and framework state root once per generated process.
 * The code root identifies the installed artifact; the state root holds the
 * SQLite kernel, notice ledger, and lineage journal.
 *
 * `AGENT_BUNDLE_PLUGIN_ROOT` wins when it is set to a non-blank, expanded
 * value (`source: 'native'`), taken exactly as written — a path is never
 * trimmed. A blank value or one still carrying a `${…}`
 * token is treated as unset — the token case is reported once on stderr,
 * because it means the host did not expand its manifest — and the shell's
 * `fallback` anchors the plugin (`source: 'derived'`).
 *
 * `AGENT_BUNDLE_STATE_ROOT` independently overrides `stateRoot`; otherwise it
 * derives below the code root or the user's state home according to
 * `stateAnchor`.
 */
export const resolvePluginRoot = (options: ResolvePluginRootOptions): ResolvedPluginRoot => {
  const env = options.env ?? process.env;
  const declared = env[PLUGIN_ROOT_ENV_ANCHOR] ?? '';
  let root: string;
  let source: 'native' | 'derived';
  if (declared.trim() === '') {
    root = resolve(options.fallback);
    source = 'derived';
  } else if (unexpandedToken.test(declared)) {
    (options.warn ?? defaultWarn)(
      `[agent-bundle] ${PLUGIN_ROOT_ENV_ANCHOR} is the unexpanded token ${JSON.stringify(declared)}; anchoring the plugin on ${resolve(options.fallback)} instead.`,
    );
    root = resolve(options.fallback);
    source = 'derived';
  } else {
    // The value is a path: trimming would move the anchor, so only the
    // blank check above looks at a trimmed copy.
    root = resolve(declared);
    source = 'native';
  }
  const derivedStateRoot = options.stateAnchor === 'user-data'
    ? userDataStateRoot(root, env, options.home)
    : join(root, PLUGIN_STATE_DIRECTORY);
  const declaredStateRoot = env[PLUGIN_STATE_ROOT_ENV_ANCHOR] ?? '';
  let stateRoot: string;
  let stateSource: 'native' | 'derived';
  if (declaredStateRoot.trim() === '') {
    stateRoot = derivedStateRoot;
    stateSource = 'derived';
  } else if (unexpandedToken.test(declaredStateRoot)) {
    (options.warn ?? defaultWarn)(
      `[agent-bundle] ${PLUGIN_STATE_ROOT_ENV_ANCHOR} is the unexpanded token ${JSON.stringify(declaredStateRoot)}; anchoring state on ${derivedStateRoot} instead.`,
    );
    stateRoot = derivedStateRoot;
    stateSource = 'derived';
  } else {
    stateRoot = resolve(declaredStateRoot);
    stateSource = 'native';
  }
  return Object.freeze({
    identity: available<AgentPluginIdentity>({ root, stateRoot }, source),
    root,
    source,
    stateRoot,
    stateSource,
  });
};
