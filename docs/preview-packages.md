# Preview packages (pkg.pr.new)

Nothing is published to npm yet, deliberately: the current package names are
placeholders, and npm publishing is deferred until the final name is chosen
(it will then use [npm package provenance](https://docs.npmjs.com/generating-provenance-statements);
the publish step exports `NPM_CONFIG_PROVENANCE=true` and runs the packed
release gates before `changeset publish`, and only runs at all when the
`AGENT_BUNDLE_NPM_PUBLISH` repository variable is `true` — see "How an npm
release will flow" below). Before enabling that path, the
release owner must resolve the repository-wide `"access": "restricted"`
policy for `agent-bundle`, which does not currently override it with
`publishConfig.access`. Until then
pkg.pr.new is the release channel. Every CI package-preview run publishes real,
installable tarballs of all four publishable workspace packages (`agent-bundle`,
`@agent-bundle/runtime`, `rsc-markdown-stream`, `create-agent-bundle`) to
[pkg.pr.new](https://pkg.pr.new)
— a free continuous-release registry keyed by commit SHA and pull request.
These are the packages to install until a first npm release is cut.

## Install the latest preview

Reference a pull request number to track its most recent build:

```sh
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@1
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@1
```

`@agent-bundle/runtime` depends on `rsc-markdown-stream`, the Markdown
renderer behind `MarkdownContent`; its preview tarball points that dependency
at the renderer's own preview of the same commit, so npm fetches it without a
separate install. Install the renderer directly only to use it on its own:

```sh
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/rsc-markdown-stream@1
```

The `create-agent-bundle` scaffolder is published to the same channel and is
meant to be run rather than installed:

```sh
npx https://pkg.pr.new/ScriptedAlchemy/agent-bundle/create-agent-bundle@<sha-or-pr> my-plugin
```

A scaffolded project pins `agent-bundle` to the preview of the same commit
the scaffolder came from, so both sides of the pairing rule below hold
automatically.

`@1` resolves to the last preview published for PR #1 — commit `5685521` at the
time of its merge, which is the state that landed on `main`.

## Pin an exact commit

Any commit that had a package-preview run can be installed by SHA (short SHAs
work), which is the right form for lockfiles and reproducible setups:

```sh
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@5685521
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@5685521
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/rsc-markdown-stream@5685521
```

pnpm and yarn accept the same URLs (`pnpm add <url>`, `yarn add agent-bundle@<url>`);
pnpm 11 additionally needs the `blockExoticSubdeps` setting described below.

Previews carry the version string `0.0.0-preview-<sha>`, and the publish
(`--peerDeps`) rewrites every peer range that points at a sibling workspace
package to that exact preview version inside the preview tarballs. Today that
is the optional `@agent-bundle/runtime` peer declared by `agent-bundle`
(`@agent-bundle/runtime` itself no longer declares an `agent-bundle` peer;
its peers are `react`, `react-dom`, and the optional `@rspack/core`). A regular
`dependencies` entry that names a sibling workspace package is rewritten to
that sibling's same-sha tarball URL: `@agent-bundle/runtime`'s
`rsc-markdown-stream` dependency resolves to the renderer preview of the same
commit. Installing both packages from the same sha therefore works with stock npm — no
`--legacy-peer-deps` needed. Mixing two different shas fails with `ERESOLVE`
by design; use one sha (or one PR number) for both URLs. Previews published
before the peer rewrite landed (PR #46, fixing #45) still carry the original
`agent-bundle@^0.1.0` range on the then-named `@agent-bundle/rsc-runtime`
package, so pair-installing those older shas with npm still requires
`--legacy-peer-deps`.

That rewrite is what pnpm 11 rejects by default: `blockExoticSubdeps` (default
`true` since pnpm 11) forbids a transitive dependency resolved from a tarball
URL, so `pnpm add` of a preview `@agent-bundle/runtime` fails with
`ERR_PNPM_EXOTIC_SUBDEP` on its rewritten `rsc-markdown-stream` dependency. Set
`blockExoticSubdeps: false` in the consuming project's `pnpm-workspace.yaml`,
or install previews with npm.

## How an npm release will flow

Versioning is driven by Changesets (`.changeset/README.md`). Every PR that
changes a publishable package carries a `.changeset/*.md`; on each push to
`main`, `.github/workflows/release.yml` runs `changesets/action`, which keeps
a machine-owned **Version Packages** pull request up to date with the pending
bumps and `CHANGELOG.md` entries. Merging that PR versions the packages but,
by default, publishes nothing: the workflow only runs the release gates
(`pnpm check:release`). Publishing turns on when the repository variable
`AGENT_BUNDLE_NPM_PUBLISH` is `true` *and* the `NPM_TOKEN` secret exists;
the action then runs `pnpm release` (`pnpm check:release && changeset
publish`) with npm provenance. Until then, previews below are the only
installable artifacts.

## Where previews come from

`.github/workflows/package-preview.yml` runs
`pnpm preview:publish` (`pkg-pr-new publish --previewVersion --peerDeps
--no-compact --no-template './packages/agent-bundle' './packages/rsc-runtime'
'./packages/rsc-markdown-stream' './packages/create-agent-bundle'`)
after a full build, on every pull request and on every push to `main`. Runs for
`main` pushes use a per-commit concurrency group, so overlapping pushes
cannot cancel one another and every `main` commit has an installable
snapshot. (PR runs cancel superseded builds for the same PR — only the
latest preview of a PR matters.) The "Publish pkg.pr.new preview"
check on a PR or commit links to the exact URLs for that build. Previews are
built from the same `pnpm build` output the release gates verify; they are
not npm releases and carry preview version strings.
