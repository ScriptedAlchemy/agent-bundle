import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { digest } from '../core/digest.ts';
import { CodedError } from '../core/errors.ts';
import { assertInside, isInsideOrEqual, joinArtifact } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { resolveMcpPathTokens } from '../services/mcp-path-tokens.ts';
import {
  readTargetMcpServer,
  type TargetMcpRuntimeContract,
} from '../services/mcp-runtime.ts';

/**
 * The effective launch of one web-exposed MCP server (#620 follow-up): the
 * browser presentation profile never selects a host artifact, so the launch
 * comes from the declared projections the composite root actually ships.
 * Exactly one normalized launch may be in effect: an explicit `target` is
 * validated against the declared projections that launch the server; without
 * one, every candidate projection's launch descriptor is normalized and
 * compared, and only materially identical launches proceed unprompted.
 * Selection is resolved before any process spawns — candidates are never
 * launched to discover which works.
 */

export type WebLaunchSelectionErrorCode =
  | 'launch-ambiguous'
  | 'launch-missing'
  | 'target-not-launchable';

export class WebLaunchSelectionError extends CodedError<WebLaunchSelectionErrorCode> {
  /** The declared projections that launch the server, for the caller's message. */
  readonly candidates: readonly string[];

  constructor(code: WebLaunchSelectionErrorCode, message: string, candidates: readonly string[]) {
    super('WebLaunchSelectionError', code, message);
    this.candidates = Object.freeze([...candidates]);
  }
}

export interface SelectedWebLaunch {
  /** Content identity of the normalized launch descriptor the selection resolves to. */
  readonly launchId: string;
  /** Every candidate projection whose normalized launch equals the selection. */
  readonly sharedTargets: readonly string[];
  /** The deterministic representative projection the session opens with. */
  readonly target: string;
}

export interface SelectWebLaunchOptions {
  readonly artifactRoot: string;
  /** The projections the artifact manifest declares for this composite root. */
  readonly declaredTargets: readonly string[];
  readonly registry: TargetRegistry;
  /** Explicit projection choice; validated, never a fallback. */
  readonly requestedTarget?: string;
  readonly serverName: string;
  readonly workspaceRoot: string;
}

interface LaunchCandidate {
  readonly launchId: string;
  readonly target: string;
}

const normalizedStdioArgument = (
  value: string,
  artifactRoot: string,
  cwd: string,
): string => {
  if (
    !isAbsolute(value) &&
    !value.startsWith('./') &&
    !value.startsWith('../') &&
    !value.includes('/') &&
    !value.includes('\\')
  ) return value;
  const resolved = resolve(cwd, value);
  return isInsideOrEqual(artifactRoot, resolved) ? resolved : value;
};

/**
 * The normalized-launch runtime view of one projection: env values pass
 * through the target's stdio-argument rule after token resolution, exactly
 * as `resolveMcpStdioLaunch` normalizes them for `mcp run` — a target that
 * serializes the plugin-root anchor as a `./` path (Codex) compares equal to
 * one that interpolates a token for the same root.
 */
const identityRuntime = (runtime: TargetMcpRuntimeContract): TargetMcpRuntimeContract => ({
  manifestPath: runtime.manifestPath,
  readModernServers: (document) => runtime.readModernServers(document),
  resolveStdioArgument: (value, roots) => runtime.resolveStdioArgument(value, roots),
  resolveValue: (field, roots, value) => {
    if (field !== 'env') return runtime.resolveValue(field, roots, value);
    const resolution = runtime.resolveValue(field, roots, value);
    return { ...resolution, value: runtime.resolveStdioArgument(resolution.value, roots) };
  },
});

/**
 * The content identity of one projection's launch for the named server, or
 * undefined when the projection does not launch it. The plugin-data root is
 * a shared placeholder — identity compares descriptors, it allocates no
 * state — so two projections binding the same durable-state layout digest
 * equally whatever data root a later session mounts.
 */
const launchIdentityOf = async (
  options: SelectWebLaunchOptions,
  target: string,
): Promise<string | undefined> => {
  const { registry } = options;
  if (!registry.has(target) || !registry.supports(target, 'mcp')) return undefined;
  const runtime = registry.mcpRuntime(target);
  if (runtime === undefined) return undefined;
  const artifactRoot = resolve(options.artifactRoot);
  let document: unknown;
  try {
    document = parseJsonWithoutDuplicateKeys(await readFile(joinArtifact(artifactRoot, runtime.manifestPath), 'utf8'));
  } catch {
    return undefined;
  }
  const result = readTargetMcpServer(runtime, document, options.serverName);
  if (result.status !== 'found') return undefined;
  try {
    const resolved = resolveMcpPathTokens({
      roots: {
        pluginData: join(artifactRoot, '.web-launch-identity'),
        pluginRoot: artifactRoot,
        workspaceRoot: resolve(options.workspaceRoot),
      },
      runtime: identityRuntime(runtime),
      server: result.server,
      target,
    });
    if (resolved.kind === 'stdio') {
      const cwd = resolved.cwd === undefined
        ? artifactRoot
        : assertInside(artifactRoot, resolve(artifactRoot, resolved.cwd));
      return digest({
        args: resolved.args.map((argument) => normalizedStdioArgument(argument, artifactRoot, cwd)),
        command: resolved.command,
        cwd,
        env: resolved.env ?? {},
        kind: 'stdio',
      });
    }
    return digest({ headers: resolved.headers ?? {}, kind: 'streamable-http', url: resolved.url });
  } catch {
    // A projection whose descriptor cannot resolve is not a launch candidate.
    return undefined;
  }
};

const listOf = (targets: readonly string[]): string => targets.join(', ');

/**
 * Resolves the one effective launch of a web-exposed server across the
 * artifact's declared projections. Candidate order never matters: targets are
 * sorted before grouping, so a selection over reversed host declarations is
 * identical. Ambiguity is kept whenever normalized descriptors cannot prove
 * equivalence; nothing synthesizes a portable launch.
 */
export const selectWebLaunch = async (options: SelectWebLaunchOptions): Promise<SelectedWebLaunch> => {
  const targets = [...new Set(options.declaredTargets)].sort((left, right) => left.localeCompare(right));
  const candidates: LaunchCandidate[] = [];
  for (const target of targets) {
    const launchId = await launchIdentityOf(options, target);
    if (launchId !== undefined) candidates.push(Object.freeze({ launchId, target }));
  }
  const candidateNames = Object.freeze(candidates.map((candidate) => candidate.target));
  const requested = options.requestedTarget;
  if (requested !== undefined) {
    const candidate = candidates.find((entry) => entry.target === requested);
    if (candidate === undefined) {
      throw new WebLaunchSelectionError(
        'target-not-launchable',
        `Target ${JSON.stringify(requested)} is not a declared projection that launches MCP server ${JSON.stringify(options.serverName)}` +
        `${candidateNames.length === 0 ? '.' : `; declared projections that do: ${listOf(candidateNames)}.`}`,
        candidateNames,
      );
    }
    return Object.freeze({
      launchId: candidate.launchId,
      sharedTargets: Object.freeze(candidates
        .filter((entry) => entry.launchId === candidate.launchId)
        .map((entry) => entry.target)),
      target: candidate.target,
    });
  }
  if (candidates.length === 0) {
    throw new WebLaunchSelectionError(
      'launch-missing',
      `No declared projection of this artifact launches MCP server ${JSON.stringify(options.serverName)}; ` +
      'the server has no launch binding to open the App with.',
      candidateNames,
    );
  }
  const launchIds = new Set(candidates.map((candidate) => candidate.launchId));
  if (launchIds.size > 1) {
    throw new WebLaunchSelectionError(
      'launch-ambiguous',
      `The declared projections launch MCP server ${JSON.stringify(options.serverName)} differently; ` +
      `pick one explicitly with ?target=<${listOf(candidateNames)}>.`,
      candidateNames,
    );
  }
  const representative = candidates[0]!;
  return Object.freeze({
    launchId: representative.launchId,
    sharedTargets: candidateNames,
    target: representative.target,
  });
};