import { proofLevelLabel } from './manifest.ts';
import type { RenderedRouteProvenance } from './types.ts';

export type AgentTestErrorCode =
  | 'assertion-failed'
  | 'command-not-found'
  | 'deleted-source-unverified'
  | 'invalid-input'
  | 'invalid-route-module'
  | 'manifest-unavailable'
  | 'packed-unavailable'
  | 'projection-failed'
  | 'render-failed'
  | 'result-rejected'
  | 'route-not-found'
  | 'server-not-found'
  | 'unsupported-route-kind';

/** How many characters of a captured value one diagnostic may print. */
const maxCapturedCharacters = 2000;

/** Bounded rendering of a captured value: diagnostics stay readable and never dump an unbounded document. */
export const captured = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= maxCapturedCharacters
    ? text
    : `${text.slice(0, maxCapturedCharacters)}… (${String(text.length - maxCapturedCharacters)} more characters omitted)`;
};

const provenanceLines = (provenance: RenderedRouteProvenance): readonly string[] => [
  `  proof level:  ${proofLevelLabel(provenance.proofLevel)}`,
  `  route:        ${provenance.routeId} (${provenance.kind})`,
  ...(provenance.serverId === undefined ? [] : [`  server:       ${provenance.serverId}`]),
  `  route source: ${provenance.source === 'manifest' ? 'compiler manifest' : 'module passed to renderRoute'}`,
  ...(provenance.relativePath === undefined ? [] : [`  module:       ${provenance.relativePath}`]),
  ...(provenance.modulePath === undefined || provenance.relativePath !== undefined
    ? []
    : [`  module:       ${provenance.modulePath}`]),
  ...(provenance.projectRoot === undefined ? [] : [`  project root: ${provenance.projectRoot}`]),
  ...(provenance.manifestDigest === undefined ? [] : [`  manifest:     route-graph digest ${provenance.manifestDigest}`]),
  `  targets:      ${provenance.targets.length === 0 ? 'none selected' : provenance.targets.join(', ')}`,
];

/**
 * Every harness failure. The message carries the route identity, the module
 * provenance, and the recovery step, so a failing consumer test never has to
 * be re-run under a debugger to learn which route and which proof level
 * produced it.
 */
export class AgentTestError extends Error {
  readonly code: AgentTestErrorCode;

  readonly provenance?: RenderedRouteProvenance;

  constructor(
    code: AgentTestErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: readonly string[];
      readonly provenance?: RenderedRouteProvenance;
      readonly recovery?: string;
    } = {},
  ) {
    const lines = [
      message,
      ...(options.provenance === undefined ? [] : provenanceLines(options.provenance)),
      ...(options.details ?? []).map((detail) => `  ${detail}`),
      ...(options.recovery === undefined ? [] : [`  recovery:     ${options.recovery}`]),
    ];
    super(lines.join('\n'), options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.name = 'AgentTestError';
    if (options.provenance !== undefined) this.provenance = options.provenance;
  }
}
