# Repository guidance

## Code hygiene

- **Extract and rewire in one change.** Every dead module this repo has had to
  delete was born the same way: a refactor lifted helpers into a new file and
  never switched the original over, so the monolith kept its inline copy and
  the new file had zero importers from its first commit. If a commit adds
  `foo-codec.ts`, the same commit deletes the code it replaced and leaves
  `foo.ts` importing it. The follow-up PR that "wires it up" does not arrive.
- **A module with no production importer is not delivered.** This repo's
  dominant failure mode is a thoroughly tested service that nothing mounts.
  Before believing a capability exists, find the production caller, not the
  test. Before opening a PR, confirm every file it adds is reachable from
  `src/index.ts`, a route, a CLI entry, or a hook — a passing suite proves
  nothing about whether the code runs.
- **Look for the helper before writing it.** `dev/http.ts` owns request and
  response helpers (`diagnostic`, `requestError`, `isRequestDiagnostic`,
  `responseDiagnostic`, `responseJson`, `singleHeader`, `isJsonRequest`,
  `readBody`, `readJsonBody`, `rawPathname`, `decodedOpaqueSegment`);
  `core/strict-json.ts`, `core/errors.ts`, `core/paths.ts`, and
  `core/freeze.ts` own their equivalents. A route module that defines its own
  `readBody` has forked a security-relevant bound that will be fixed in one
  copy and not the other.
- **Never copy a helper to dodge an import cycle.** Move it to a leaf module
  both sides import — `config/conventional-entry.ts` is the pattern. A comment
  explaining why the copy exists documents the debt; it does not discharge it.
- **One class per name.** Two identical `class FooError` declarations in two
  modules are not interchangeable: `instanceof` against the wrong one silently
  returns `false`, so the `catch` that was supposed to handle it falls through.
  Error classes live with the code that throws them, exported once.
- **Delete on sight.** Unreferenced code is not free — it is read during
  review, matched by search, and copied by the next author who finds it before
  the live version. Removing it is a `patch` changeset, not a project.
- Neither `pnpm lint` nor `pnpm typecheck` reports an unreferenced module, so
  check by hand when a change adds or moves files:

  ```sh
  # any tracked file that mentions the module, other than itself
  git grep -l '<module-stem>' -- ':!repos'
  ```

  One hit means the module only mentions itself and nothing imports it. Watch
  for false positives from prose in `docs/**` and from strings that merely
  contain the name: `Symbol('epoch-staging')` in `dev/epoch-store.ts` was the
  only match for a 343-line dead file, which is why it read as reachable.
- Gate before pushing: `pnpm typecheck && pnpm lint && pnpm test:unit`, plus
  `pnpm build` first if the change touches `packages/rsc-runtime`.

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

- Every PR gets a self-review before merge: spawn a local reviewer subagent
  (`change-risk-reviewer` if available, else `generalPurpose`; prefer a
  different model from the author's, e.g. `gpt-5.6-sol-high`) with the repo
  path and the PR number or branch, asking for concrete merge risks only —
  bugs, breaking changes, missed tests, doc or changeset gaps — against the
  current diff vs `origin/main`. Fix or explicitly dismiss every finding in
  the PR description under a "Self-review" section (reviewer model, findings,
  disposition), run the reviewer once more after fixes, then merge on green
  CI.
- CI green first. Address every review thread, whoever opened it — fix it in
  the same PR or reply with a precise reason — and re-check for new threads
  after each push until none remain. Only then merge.
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
