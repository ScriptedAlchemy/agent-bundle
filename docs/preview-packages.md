# Preview packages (pkg.pr.new)

Nothing is published to npm yet, deliberately: the current package names are
placeholders, and npm publishing is deferred until the final name is chosen
(it will then use [npm package provenance](https://docs.npmjs.com/generating-provenance-statements);
the manifests and release workflow are already wired for it). Until then
pkg.pr.new is the release channel. Every CI package-preview run publishes real,
installable tarballs of both workspace packages to [pkg.pr.new](https://pkg.pr.new)
— a free continuous-release registry keyed by commit SHA and pull request.
These are the packages to install until a first npm release is cut.

## Install the latest preview

Reference a pull request number to track its most recent build:

```sh
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@1
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/rsc-runtime@1
```

`@1` resolves to the last preview published for PR #1 — commit `5685521` at the
time of its merge, which is the state that landed on `main`.

## Pin an exact commit

Any commit that had a package-preview run can be installed by SHA (short SHAs
work), which is the right form for lockfiles and reproducible setups:

```sh
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@5685521
npm i https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/rsc-runtime@5685521
```

pnpm and yarn accept the same URLs (`pnpm add <url>`, `yarn add agent-bundle@<url>`).

Previews carry the version string `0.0.0-preview-<sha>`, and the publish
rewrites the `agent-bundle` peer range inside the `@agent-bundle/rsc-runtime`
preview tarball to that exact preview version (`--peerDeps`). Installing both
packages from the same sha therefore works with stock npm — no
`--legacy-peer-deps` needed. Mixing two different shas fails with `ERESOLVE`
by design; use one sha (or one PR number) for both URLs. Previews published
before the peer rewrite landed (PR #46) still carry the original
`agent-bundle@^0.1.0` range, so pair-installing those older shas with npm
still requires `--legacy-peer-deps`.

## Where previews come from

`.github/workflows/package-preview.yml` runs
`pnpm preview:publish` (`pkg-pr-new publish --previewVersion --peerDeps
--no-compact --no-template './packages/agent-bundle' './packages/rsc-runtime'`)
after a full build, on every pull request and on every push to `main`. Runs for
`main` pushes use a per-commit concurrency group, so overlapping pushes
cannot cancel one another and every `main` commit has an installable
snapshot. (PR runs cancel superseded builds for the same PR — only the
latest preview of a PR matters.) The "Publish pkg.pr.new preview"
check on a PR or commit links to the exact URLs for that build. Previews are
built from the same `pnpm build` output the release gates verify; they are
not npm releases and carry preview version strings.
