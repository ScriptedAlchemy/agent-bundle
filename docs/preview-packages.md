# Preview packages (pkg.pr.new)

pkg.pr.new is the only package distribution channel. Every CI package-preview
run publishes real, installable tarballs of all four publishable workspace
packages (`agent-bundle`,
`@agent-bundle/runtime`, `rsc-markdown-stream`, `create-agent-bundle`) to
[pkg.pr.new](https://pkg.pr.new),
a free continuous-release registry keyed by commit SHA and pull request.
Consumers pin these previews by commit SHA; no npm registry credential is
needed or expected.

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

`@1` resolves to the last preview published for PR #1, commit `5685521` at the
time of its merge, which is the state that landed on `main`.

## Pin an exact commit

Any commit whose package-preview run completed can be installed by SHA (short SHAs
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
package to that exact preview version inside the preview tarballs. Those peers
are the optional `@agent-bundle/runtime` peer declared by `agent-bundle` and
the optional compiler/runtime release-pair record declared by
`create-agent-bundle` (`@agent-bundle/runtime` itself has no `agent-bundle`
peer). A regular `dependencies` entry that names a sibling workspace package
is rewritten to that sibling's same-sha tarball URL: `@agent-bundle/runtime`'s
`rsc-markdown-stream` dependency resolves to the renderer preview of the same
commit. Installing both packages from the same sha therefore works with stock npm, no
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

## How a Version Packages merge flows

Versioning is driven by Changesets (`.changeset/README.md`). Every PR that
changes a publishable package carries a `.changeset/*.md`; on each push to
`main`, `.github/workflows/release.yml` runs `changesets/action`, which keeps
a machine-owned **Version Packages** pull request up to date with the pending
bumps and `CHANGELOG.md` entries. Merging that PR versions the packages. The
`Release packages` workflow calls the reusable `Package preview` workflow,
which publishes and resolves all four
`https://pkg.pr.new/ScriptedAlchemy/agent-bundle/<package>@<sha>` URLs. The
release job depends on that proof and runs `pnpm check:release` against the
same Version Packages commit. A green run records `preview-release`; a push
that only refreshes the Version Packages PR records
`version-maintenance-only`.

## Where previews come from

`.github/workflows/package-preview.yml` runs
`pnpm preview:publish` (`pkg-pr-new publish --previewVersion --peerDeps
--no-compact --no-template './packages/agent-bundle' './packages/rsc-runtime'
'./packages/rsc-markdown-stream' './packages/create-agent-bundle'`)
after a full build. Pull requests invoke the workflow directly and cancel a
superseded run for the same PR. On `main`, the serialized `Release packages`
workflow calls it as a reusable workflow and waits for all four URLs to
resolve before continuing. The "Publish pkg.pr.new preview" check on a PR or
commit links to the exact URLs for that build. Previews are built from the same
`pnpm build` output the release gates verify; they are not npm releases and
carry preview version strings.
