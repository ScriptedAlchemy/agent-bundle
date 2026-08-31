---
"agent-bundle": minor
---

Move the generated-executable build path onto fully documented bundler
surfaces (Rspack/Rslib/Rsbuild conformance audit).

- Generated wrapper entries and registry modules (the stdio MCP entry shell,
  `main` process envelopes, `agent-bundle/mcp-apps` registries) are now
  materialized as real files under the reserved `.agent-bundle-virtual/`
  directory for the duration of one Rslib build — replacing the experimental
  `rspack.experiments.VirtualModulesPlugin` and its undocumented
  real-file-overlay of the framework's own module as the entry anchor. The
  files never reach a published artifact and never count as authored source
  provenance; emitted bundles keep their behavior byte for byte (the only
  content shift is one scope-hoisting identifier now derived from the stable
  generated-entry name instead of the framework's install-dependent bundle
  filename).
- The self-contained-artifact invariant now closes the `output.externals`
  hole: a `tools` hatch that externalizes a reserved specifier
  (`agent-bundle/mcp-entry`, `agent-bundle/mcp-apps`, or any generated
  registry name) fails the build with a hard diagnostic — statically for
  string/RegExp/object externals, and via a post-build residual-import scan
  of every emitted bundle for function-form externals.
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
