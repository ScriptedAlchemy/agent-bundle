# Changesets

This repository versions its published packages with
[Changesets](https://github.com/changesets/changesets). A changeset is a small
Markdown file in this directory that names the packages a pull request
changes, the bump each one needs, and a user-facing summary. `changeset
version` folds pending changesets into `CHANGELOG.md` and `package.json`
versions; `changeset publish` (when enabled) publishes the result.

## Which packages get changesets

| Package                 | Path                           | Status                                   |
| ----------------------- | ------------------------------ | ---------------------------------------- |
| `agent-bundle`          | `packages/agent-bundle`        | publishable                              |
| `@agent-bundle/runtime` | `packages/rsc-runtime`         | publishable                              |
| `create-agent-bundle`   | `packages/create-agent-bundle` | publishable                              |
| `agent-bundle-workbench`| `packages/workbench`           | private, ignored                         |
| `@agent-bundle-example/*`, `@agent-bundle/rsc-agent-runtime-demo` | `examples/*` | private, ignored |
| `@agent-bundle/docs`    | `website`                      | private, ignored                         |

Private packages are listed under `ignore` in `config.json` and are also
excluded by `privatePackages.version: false`, so `pnpm changeset` never
prompts for them and a changeset must never name them. The workspace root
(`agent-bundle-workspace`) is not a workspace package and needs no entry. A
change that only touches private packages, `docs/**`, `agent-patterns/**`,
CI, or a publishable package's `tests/**` directory needs no changeset
(`changedFilePatterns` in `config.json` exempts `tests/**`).

## Rules

- **One changeset per pull request** that changes a publishable package's
  shipped surface (`src/**`, `bin/**`, `templates/**`, `package.json`,
  `README.md`, build config). Name every affected package in that one file.
  Split a PR instead of writing several changesets for it; the rare exception
  is a PR that intentionally ships two independent user-facing changes.
- **Semver before 1.0**: `minor` = breaking change (removed or renamed
  exports, CLI flags, config keys, diagnostic codes, on-disk formats, or
  changed defaults that require consumer action); `patch` = everything else,
  including new features. Do not use `major` until the first `1.0.0`; after
  1.0 the usual semver meanings apply.
- **Summary style**: user-facing, imperative, one paragraph. Lead with what
  changes for the consumer, name the affected command, export, or config key,
  and mention diagnostic codes (`AB` + four digits, see `docs/diagnostics.md`)
  when a diagnostic is added, removed, or reworded. Do not describe the implementation, the
  review thread, or internal refactors that leave behavior unchanged. End
  with the pull request reference in parentheses, `(#123)`, when the PR
  number is known.
- **Never edit `CHANGELOG.md` or a publishable `package.json` `version` by
  hand.** The "Version Packages" pull request is machine-owned; it is
  regenerated on every push to `main` and any manual edit is overwritten.
- **`skip-changeset` label**: a PR that changes publishable files but ships
  no observable change (comments, formatting, type-only refactors) may carry
  the `skip-changeset` label instead of a changeset. The `Changeset present`
  check honours the label; reviewers should challenge its use.

## Writing a changeset

Run `pnpm changeset` and follow the prompts, or create
`.changeset/<slug>.md` by hand:

```md
---
"agent-bundle": patch
"create-agent-bundle": patch
---

`agent-bundle doctor` now reports `AB6026` when a Cursor hook manifest points
at a missing built script instead of failing silently; scaffolded projects
pick up the same check. (#123)
```

Use a descriptive kebab-case slug (the generated random names are fine
too). Commit the file with the change it describes.

## Enforcement

`.github/workflows/changeset.yml` runs `pnpm changeset status
--since=origin/main` on every pull request. It fails when a publishable
package changed (per `changedFilePatterns`) and the PR adds no
`.changeset/*.md`. It is skipped for the `skip-changeset` label and for the
machine-owned `changeset-release/main` branch of this repository (not for a
fork or contributor branch of the same name). Docs-only PRs pass automatically
because they change no publishable package.

## Versioning decisions

- `agent-bundle` and `@agent-bundle/runtime` version **independently**
  (`fixed` and `linked` are empty). `agent-bundle` declares
  `@agent-bundle/runtime` as an *optional* peer with range `*`, and
  `@agent-bundle/runtime` does not depend on `agent-bundle`, so neither
  package needs to move when the other does. Preview tarballs pin the peer to
  the same commit (`docs/preview-packages.md`), which is a preview concern,
  not a version-coupling one. Revisit if the peer range ever becomes exact.
- `create-agent-bundle` versions independently; its templates pin
  `agent-bundle` explicitly rather than through a workspace range.
- `updateInternalDependencies: "patch"` with
  `bumpVersionsWithWorkspaceProtocolOnly: true`: only `workspace:` ranges
  between publishable packages would trigger dependent patch bumps, and
  there are none today.
- `access` stays `"restricted"` at the repository level until the release
  owner decides the npm package names and access policy
  (`docs/preview-packages.md`). `@agent-bundle/runtime` and
  `create-agent-bundle` already override it with `publishConfig.access`.

## Release flow

1. PRs merge to `main` with their changesets.
2. `.github/workflows/release.yml` runs `changesets/action` on every push to
   `main`. While changesets are pending it pushes `changeset-release/main`
   and opens or refreshes the **Version Packages** pull request, which
   deletes the consumed changesets, bumps versions, and writes `CHANGELOG.md`
   entries. Review it, never edit it. GitHub does not start workflows for
   events created with the built-in `GITHUB_TOKEN`, so for that PR to get
   PR CI the repository needs a `CHANGESETS_GITHUB_TOKEN` secret (fine-grained
   PAT or GitHub App installation token with `contents: write` and
   `pull-requests: write` on this repository); the workflow falls back to
   `GITHUB_TOKEN`, in which case close and reopen the PR to trigger CI.
3. Merging Version Packages pushes a `Version Packages` commit to `main`
   with no pending changesets. With publishing disabled (the default) the
   workflow then runs the release gates (`pnpm check:release`) and stops;
   nothing reaches npm.
4. Publishing is opt-in: set the repository variable
   `AGENT_BUNDLE_NPM_PUBLISH=true` and the `NPM_TOKEN` secret. The action
   then runs `pnpm release` (`pnpm check:release && changeset publish`) with
   npm provenance (`NPM_CONFIG_PROVENANCE=true`, `id-token: write`) and
   creates GitHub releases and tags.

Until publishing is enabled, installable previews come from pkg.pr.new
(`pnpm preview:publish`, `docs/preview-packages.md`).
