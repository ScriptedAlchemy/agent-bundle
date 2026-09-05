import { rspack, type Rspack } from '@rslib/core';

import type { CompilationEvidence, CompilationExternal, CompilationModule } from './compile-result.ts';

const pluginName = 'agent-bundle:dependency-audit';

/**
 * `external <type> <request as JSON>`, optionally followed by `|<layer>|<issuer>`
 * segments. The JSON request is what the emitted code loads at run time; an
 * object-map external such as `{ 'left-pad': 'lp' }` names `"lp"` here and
 * `left-pad` in `userRequest`. An array request (`["lp", "default"]`) loads its
 * first element and reads the rest as property paths.
 */
const externalIdentifier = /^external (\S+) (".*?"|\[.*?\])(?:\||$)/u;

const runtimeRequest = (module: Rspack.ExternalModule): { readonly externalType: string; readonly request: string } => {
  const identifier = module.identifier();
  const match = externalIdentifier.exec(identifier);
  const parsed: unknown = match === null ? undefined : JSON.parse(match[2]!);
  const request = Array.isArray(parsed) ? parsed[0] : parsed;
  if (match === null || typeof request !== 'string') {
    throw new Error(`Rspack ExternalModule has an unexpected identifier: ${JSON.stringify(identifier)}.`);
  }
  return { externalType: match[1]!, request };
};

const moduleResource = (module: Rspack.Module | null | undefined): string | undefined =>
  module?.nameForCondition() ?? module?.identifier();

const collectExternals = (compilation: Rspack.Compilation): readonly CompilationExternal[] => {
  const byRequest = new Map<string, {
    readonly externalType: string;
    readonly issuers: Set<string>;
    readonly request: string;
    readonly userRequest: string;
  }>();
  for (const module of compilation.modules) {
    if (!(module instanceof rspack.ExternalModule)) continue;
    const { externalType, request } = runtimeRequest(module);
    const key = `${request}\u0000${module.userRequest}`;
    const record = byRequest.get(key) ?? {
      externalType,
      issuers: new Set<string>(),
      request,
      userRequest: module.userRequest,
    };
    for (const connection of compilation.moduleGraph.getIncomingConnections(module)) {
      const issuer = moduleResource(connection.originModule);
      if (issuer !== undefined) record.issuers.add(issuer);
    }
    byRequest.set(key, record);
  }
  return Object.freeze([...byRequest.values()]
    .map(({ externalType, issuers, request, userRequest }) => Object.freeze({
      externalType,
      issuers: Object.freeze([...issuers].sort()),
      request,
      userRequest,
    }))
    .sort((left, right) => left.request.localeCompare(right.request) || left.userRequest.localeCompare(right.userRequest)));
};

const collectModules = (compilation: Rspack.Compilation): readonly CompilationModule[] => {
  const modules: CompilationModule[] = [];
  for (const module of compilation.modules) {
    if (!(module instanceof rspack.NormalModule)) continue;
    const resource = module.nameForCondition();
    modules.push(Object.freeze({ identifier: module.identifier(), ...(resource === undefined ? {} : { resource }) }));
  }
  return Object.freeze(modules.sort((left, right) => left.identifier.localeCompare(right.identifier)));
};

/**
 * Records what one compilation resolved — externals with their issuers and
 * bundled modules — once the module graph is final and before any asset is
 * emitted.
 */
export class ArtifactDependencyAuditPlugin {
  readonly #record: (evidence: CompilationEvidence) => void;

  constructor(record: (evidence: CompilationEvidence) => void) {
    this.#record = record;
  }

  apply(compiler: Rspack.Compiler): void {
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      compilation.hooks.afterOptimizeModules.tap(pluginName, () => {
        const compilerName = compilation.compiler.name;
        if (compilerName === undefined) {
          throw new Error('Rspack compilation has no compiler name; Rslib must name each lib with its entry id.');
        }
        this.#record(Object.freeze({
          compiler: compilerName,
          externals: collectExternals(compilation),
          modules: collectModules(compilation),
        }));
      });
    });
  }
}
