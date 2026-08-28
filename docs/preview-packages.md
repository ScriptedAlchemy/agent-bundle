# Preview packages (pkg.pr.new)

Nothing is published to npm yet. Every CI package-preview run publishes real,
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

## Where previews come from

`.github/workflows/package-preview.yml` runs
`pnpm preview:publish` (`pkg-pr-new publish './packages/agent-bundle'
'./packages/rsc-runtime'`) after a full build, on every pull request and on
every push to `main`. The "Publish pkg.pr.new preview" check on a PR or commit
links to the exact URLs for that build. Previews are built from the same
`pnpm build` output the release gates verify; they are not npm releases and
carry preview version strings.
