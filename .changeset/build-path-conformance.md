---
"agent-bundle": minor
---

Harden the generated-executable build path (Rspack/Rslib/Rsbuild
conformance audit). One deliberate experimental surface remains:
`rspack.experiments.VirtualModulesPlugin` serves generated module sources,
behind a feature check with an actionable diagnostic.

- Generated wrapper entries and registry modules (the stdio MCP entry shell,
  `main` process envelopes, `agent-bundle/mcp-apps` registries) now live at
  dedicated, deterministic, guaranteed-nonexistent paths under the reserved
  `.agent-bundle-virtual/` namespace — replacing the undocumented
  real-file-overlay of the framework's own module as the entry anchor. The
  generated sources never reach the filesystem or a published artifact and
  never count as authored source provenance; emitted bundles keep their
  behavior byte for byte (the only content shift is one scope-hoisting
  identifier now derived from the stable generated-entry name instead of the
  framework's install-dependent bundle filename).
- The self-contained-artifact invariant now closes the `output.externals`
  hole: a `tools` hatch that externalizes a reserved specifier
  (`agent-bundle/mcp-entry`, `agent-bundle/mcp-apps`, or any generated
  registry name) fails the build with a hard diagnostic — statically for
  string/RegExp/object externals, and via a post-build residual-import scan
  of every emitted bundle for function-form externals.
- Dist cleaning is now a framework invariant rather than a profile default:
  scripts, MCP entries, hooks, and MCP Apps build sequentially into one
  shared staged root, so a `tools.rsbuild.output.cleanDistPath: true` hatch
  would delete sibling outputs already emitted there. It is pinned off after
  the hatch merge and asserted on the resolved environment config.
- Pre-build inspection assertions are keyed by the documented Rslib `lib.id`
  (`origin.environmentConfigs[id]` and the Rspack config `name`) instead of
  relying on undocumented array ordering, and reserved aliases use Rspack's
  exact-match (`$`) key form.
- Per-entry Rslib configs compose through Rslib's own documented
  `mergeRslibConfig` (merged by `id`) with the framework invariant hooks
  typed against each executing engine's own `Rspack.Configuration` and
  returning the config, removing every `as never` cast; the one remaining
  type seam between the public hatch types and Rslib's nested engine is a
  single documented conversion. The dual-engine reality of the hatch —
  Rslib's nested Rsbuild/Rspack (2.1.x line) on the executable path, the
  workspace `@rsbuild/core` (2.2.x) on the MCP Apps path — is now documented
  on `AgentBundleToolsConfig` and in the entry-conventions reference,
  steering hatch authors to the `{ rspack }` utils argument instead of
  importing `@rspack/core`.
- The unused direct `@rspack/core` dependency is dropped per Rslib guidance
  (its types resolve through `@rsbuild/core`), the `lib` build's declaration
  output is described accurately as a bundleless `.d.ts` graph, and the
  `mcp run` docs no longer claim programmatic builds load the same `.env`
  set (they load none).
