# Repository guidance

## Workbench platform scope

- The developer Workbench is a desktop-only application.
- Design, implementation, and browser acceptance should target desktop viewports and desktop interaction patterns.
- Do not add mobile-specific layouts, responsive behavior, or mobile acceptance requirements unless the user explicitly requests them.
- A mobile-only layout defect is not a release blocker for this repository.

## Public examples

- Treat `examples/*` as user-facing products, not test fixtures.
- Use only public `agent-bundle` package exports and `workspace:*` dependencies.
- Validate examples at a 1440×900 desktop viewport; mobile support is not required.
- Never accept or capture a Workbench route while its loading state is still visible.
- Browser acceptance must cover populated state plus the documented stale-diagnostic and repair flow.

## Changesets

- Every PR that changes a publishable package (`packages/agent-bundle`,
  `packages/rsc-runtime`, `packages/create-agent-bundle` — anything except
  `tests/**`) must include exactly one changeset: `pnpm changeset` or a
  hand-written `.changeset/<slug>.md`. Private packages (`packages/workbench`,
  `examples/*`, `website`) are ignored and never named in a changeset.
- Pre-1.0 semver: `minor` = breaking, `patch` = everything else (features
  included). No `major` before 1.0.
- Summary: user-facing, imperative, names the command/export/config key,
  mentions diagnostic codes, ends with `(#PR)`. Not an implementation note.
- The `Changeset present` CI check fails without one; the `skip-changeset`
  label is the escape hatch for genuinely no-op changes only.
- The "Version Packages" PR is machine-owned. Never edit `CHANGELOG.md` or a
  publishable `package.json` `version` by hand. Details: `.changeset/README.md`.

## Pull requests

- Every PR: CI green first, then wait for the automated reviewer
  (`chatgpt-codex-connector`, posts within minutes of each push) to finish.
- Address every review thread — fix it in the same PR or reply with a precise
  reason — and reply on every thread. After each push, re-check for new
  threads and repeat until there are none. Only then merge.
- PRs are squash-merged. Review threads left on an already-merged PR must
  still be answered, in a follow-up PR.

## Vendored repos

- `repos/` is **read-only reference material**. Do not edit, format, or import from `repos/**`.
- Application code imports the published npm package (`effect`), never a path under `repos/`.
- Before writing Effect code, read `repos/effect/LLMS.md` and the linked
  `agent-patterns/effect-{stream,scope,concurrency,errors}.md`.
- Editor search, file watching, and auto-import exclude `repos/**`
  (`.vscode/settings.json`). Subtree updates ride the same named chore as
  the Effect RC re-pin — see `docs/effect-conventions.md`.
