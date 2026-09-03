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

## Documentation site

- `website/` is the public Rspress docsite
  (<https://scriptedalchemy.github.io/agent-bundle/>), deployed from `main`
  by `.github/workflows/docs.yml`. It is user-facing product, held to the
  same accuracy bar as the code it describes.
- A PR that adds or changes user-facing behavior — a CLI command or flag,
  config key, public export or entry point, hook event or result rule, host
  target or artifact, diagnostic code, environment variable, or example —
  updates the matching page under `website/docs/en/**` **and** its
  `website/docs/zh/**` translation in the same PR. Ask the same question
  when writing the changeset: if the summary is user-facing, the docs almost
  certainly need the same change. Internal refactors, tests, and CI do not.
- Reference prose must match the source. State what the code does, not what
  the design intended; when unsure, read the adapter or validator before
  writing the sentence. Where the generated pages and hand-written pages
  disagree, the generated pages are right — fix the hand-written one.
- Never hand-edit generated pages: `website/docs/{en,zh}/api/**` comes from
  TypeDoc, and the hosts, events, and diagnostics reference pages are
  rendered at build time from `packages/agent-bundle/src/adapters/capabilities/*.json`
  and `docs/diagnostics.md`. Change the source, and the site follows.
- `pnpm docs:site:build` is the gate: typecheck, build, and Rspress's
  dead-link, dead-anchor, dead-image, and language-parity checks. Parity
  fails the build if one locale gains a page the other lacks. Run it before
  pushing anything under `website/`, and after any change to public
  exports, since TypeDoc compiles `packages/agent-bundle/src` directly.
- The site is desktop-first, like the Workbench. Wide tables scroll; code
  samples wrap at roughly 90 columns so they render without horizontal
  overflow at the default content width.

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
  (`chatgpt-codex-connector`) to finish. It does not re-review on its own
  after a rebase or force-push: after every push, post an `@codex review` PR
  comment if no fresh review appears within a few minutes, and confirm its
  summary comment cites the current head SHA before merging.
- Reviewer quota fallback: if the connector answers "usage limits reached", or
  no review arrives within about ten minutes of two `@codex review` requests,
  record the last-reviewed and unreviewed head SHAs in the PR body's "Review
  status" section and merge on green CI. Re-request the review once credits
  return; a thread it opens on an already-merged PR is answered in a
  follow-up PR like any other.
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
