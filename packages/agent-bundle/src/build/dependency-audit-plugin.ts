import { rspack, type Rspack } from '@rslib/core';

import type { CompilationEvidence, CompilationExternal, CompilationModule } from './compile-result.ts';

export const artifactDependencyAuditPluginName = 'agent-bundle:dependency-audit';

/** `external <type> "<request>"`, optionally followed by `|<layer>|<issuer>` segments. */
const externalIdentifierType = /^external (\S+) /u;

const moduleResource = (module: Rspack.Module | null | undefined): string | undefined =>
  module?.nameForCondition() ?? module?.identifier();

const byString = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sortedUnique = (values: Iterable<string>): readonly string[] =>
  Object.freeze([...new Set(values)].sort(byString));

const collectExternals = (compilation: Rspack.Compilation): readonly CompilationExternal[] => {
  const issuersByRequest = new Map<string, { readonly externalType: string; readonly issuers: Set<string> }>();
  for (const module of compilation.modules) {
    if (!(module instanceof rspack.ExternalModule)) continue;
    const request = module.userRequest;
    const record = issuersByRequest.get(request) ?? {
      externalType: externalIdentifierType.exec(module.identifier())?.[1] ?? '',
      issuers: new Set<string>(),
    };
    for (const connection of compilation.moduleGraph.getIncomingConnections(module)) {
      const issuer = moduleResource(connection.originModule);
      if (issuer !== undefined) record.issuers.add(issuer);
    }
    issuersByRequest.set(request, record);
  }
  return Object.freeze([...issuersByRequest.entries()]
    .sort(([left], [right]) => byString(left, right))
    .map(([request, { externalType, issuers }]) => Object.freeze({
      externalType,
      issuers: sortedUnique(issuers),
      request,
    })));
};

const collectModules = (compilation: Rspack.Compilation): readonly CompilationModule[] => {
  const modules: CompilationModule[] = [];
  for (const module of compilation.modules) {
    if (!(module instanceof rspack.NormalModule)) continue;
    const resource = module.nameForCondition();
    modules.push(Object.freeze({ identifier: module.identifier(), ...(resource === undefined ? {} : { resource }) }));
  }
  return Object.freeze(modules.sort((left, right) => byString(left.identifier, right.identifier)));
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
    compiler.hooks.thisCompilation.tap(artifactDependencyAuditPluginName, (compilation) => {
      compilation.hooks.afterOptimizeModules.tap(artifactDependencyAuditPluginName, () => {
        this.#record(Object.freeze({
          compiler: compilation.compiler.name ?? '',
          externals: collectExternals(compilation),
          modules: collectModules(compilation),
        }));
      });
    });
  }
}
