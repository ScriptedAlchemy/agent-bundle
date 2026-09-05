import { isBuiltin } from 'node:module';
import { posix } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isRecord } from '../core/strict-json.ts';
import { artifactDiagnostic } from './artifact-diagnostics.ts';
import type { CompileResult, ExternalIR, ExternalKind } from './compile-result.ts';

/** A request a generated executable may load at run time: a Node built-in, or Yarn PnP's runtime API. */
export const isAllowedExternalRequest = (request: string): boolean => isBuiltin(request) || request === 'pnpapi';

const isRelativeRequest = (request: string): boolean => request.startsWith('./') || request.startsWith('../');

export const classifyExternal = (
  request: string,
  options: { readonly asset: string; readonly emittedAssets: ReadonlySet<string> },
): ExternalKind => {
  if (isAllowedExternalRequest(request)) return 'builtin';
  if (isRelativeRequest(request)) {
    const target = posix.join(posix.dirname(options.asset), request);
    if (target !== '..' && !target.startsWith('../') && options.emittedAssets.has(target)) {
      return 'artifact-relative';
    }
  }
  return 'package';
};

const externalMessage = (external: ExternalIR): string => {
  switch (external.kind) {
    case 'package':
      return `Compiled module ${JSON.stringify(external.asset)} keeps ${JSON.stringify(external.request)} external (${external.externalType})`
        + `${external.userRequest === external.request ? '' : `, imported as ${JSON.stringify(external.userRequest)},`}`
        + `${external.issuers.length === 0 ? '' : ` from ${external.issuers.join(', ')}`}; `
        + (isRelativeRequest(external.request)
          ? 'it names no module emitted by this artifact.'
          : 'a generated executable bundles everything but Node built-ins.');
    case 'artifact-relative':
    case 'builtin':
      throw new Error(`Allowed external ${JSON.stringify(external.request)} has no diagnostic message.`);
    default: {
      const exhaustive: never = external.kind;
      throw new Error(`Unknown external kind ${JSON.stringify(exhaustive)}.`);
    }
  }
};

export const selfContainmentDiagnostics = (result: CompileResult): readonly Diagnostic[] =>
  result.externals
    .filter((external) => external.kind === 'package')
    .toSorted((left, right) =>
      left.asset.localeCompare(right.asset) || left.request.localeCompare(right.request))
    .map((external) => artifactDiagnostic('AB6005', externalMessage(external), external.asset));

const isPackageRequest = (request: string): boolean =>
  !isAllowedExternalRequest(request) && !isRelativeRequest(request);

/**
 * The package requests a statically inspectable `externals` declaration
 * (string, object map, or arrays thereof) would externalize. An object entry
 * whose value is `false` opts out of externalization. Relative requests are
 * left to compile time, where `classifyExternal` knows the emitted assets.
 * RegExp and function declarations are not inspected: what they externalize
 * is known only at compile time, where the compilation's own externals are
 * judged.
 */
export const externalizedSpecifiers = (externals: unknown): readonly string[] => {
  if (Array.isArray(externals)) return externals.flatMap(externalizedSpecifiers);
  if (typeof externals === 'string') return isPackageRequest(externals) ? [externals] : [];
  if (externals instanceof RegExp || typeof externals === 'function' || !isRecord(externals)) return [];
  return Object.entries(externals)
    .filter(([request, value]) => value !== false && isPackageRequest(request))
    .map(([request]) => request);
};
