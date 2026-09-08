# Repository guidance

## Scope and completion

Carry requested changes through the relevant implementation, inspection, and
verification. Resolve failures introduced by the change before reporting done.
Continue independent authorized work while a missing decision blocks another
part; a skill recipe alone is not a reason to expand scope or stop for approval.

Load guidance for the task it actually covers. Keep skill descriptions concise
and specific, and put substantial conditional procedures in linked references.
Preserve operational invariants; avoid blanket document reads, arbitrary output
counts, and repeated checks without new evidence.

## Code hygiene

- Extract and rewire together: migrate production callers and delete the old
  implementation in the same change. Added production modules must be reachable
  from an application, CLI, route, or hook entrypoint; isolated tests do not
  establish that a capability is mounted.
- Reuse the request/response helpers in `dev/http.ts` (`readBody`, `readJsonBody`,
  `responseJson`, `singleHeader`, diagnostics and path helpers) and the canonical
  `core/strict-json.ts`, `core/errors.ts`, `core/paths.ts`, and `core/freeze.ts`.
  Duplicating them can fork security bounds. Resolve import cycles with a shared
  leaf module, as in `config/conventional-entry.ts`, rather than copying code.
- Error classes have one exported definition; duplicate classes break
  `instanceof` identity across callers.
- When adding, moving, or removing code, check production reachability, including
  dynamic loading and public entrypoints. Text-match counts and passing lint or
  typechecks alone do not prove a file is unused. Remove confirmed obsolete code
  within the requested scope; do not delete unrelated code on sight.
- Match checks to changed behavior. Code changes use the local gate below and
  affected integration/packed coverage. For instruction-only edits, validate
  syntax, links, and relevant skill rendering or packaging instead of rebuilding
  unrelated applications. Rstest and typecheck require fresh `dist`; when running
  them, build first and preserve `scripts/dist-freshness.mjs` enforcement.

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

## Generated plugin output

Generated executables are self-contained. Preserve these compiler boundaries:

- `packages/agent-bundle/src/build/rslib.ts` uses `autoExternal: false`,
  `bundle: true`, and `splitChunks: false`. Do not externalize dependencies on
  the author's behalf. MCP App views inline scripts and styles into one HTML.
- Each compilation judges its own external/module records. Only Node built-ins,
  `pnpapi`, and emitted siblings may remain external (`AB6005`). Imports supplied
  through the author's `tools` hatch are still subject to `AB6005` and may not
  escape bundling.
- Build persists `agent-bundle.compile-evidence.json`; `validate --artifact`
  checks it against the file table (`AB6039`). A matching digest proves byte
  identity, not that all imports resolved. Preserve the packed test that removes
  source and runs the generated executable in a clean consumer.
- Consumer dependencies require `AB7014` evidence: prebuilt
  `runtimeDependencies`, packed declaration references, or consumer install
  scripts. `AB7015` requires an npm-installable specifier. The framework's runtime
  modules do not create implicit process dependencies.
- The emitted-module walk handles what the compiler cannot see: expression
  imports, uncompiled/copied scripts, and every module of a build using the
  author's `tools` hatch. It must not grow a parallel resolver for records the
  compiler already judged. Literal imports left in compiled output still need
  recorded authority; ignore comments do not make them safe.

For changes to bundling or artifact validation, inspect `src/build/compiler.ts`,
`external-policy.ts`, `dependency-audit-plugin.ts`, `compile-evidence.ts`,
`package-build.ts`, and `validate-artifact-modules.ts` under
`packages/agent-bundle`, choosing the files that own the affected behavior.

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
  exports, after `pnpm build`, since TypeDoc compiles the declarations under
  `packages/agent-bundle/dist`.
- The site is desktop-first, like the Workbench. Wide tables scroll; code
  samples wrap at roughly 90 columns so they render without horizontal
  overflow at the default content width.

## Changesets

- Every PR that changes a publishable package (`packages/agent-bundle`,
  `packages/rsc-runtime`, `packages/rsc-markdown-stream`,
  `packages/create-agent-bundle` — anything except `tests/**`) must include
  exactly one changeset: `pnpm changeset` or a
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

- Review the actual diff against the integration base for correctness, duplicate
  helpers, noisy comments, placeholder prose, and casts or defensive branches
  that conceal errors. Preserve real trust-boundary checks. Report material
  findings and their resolution; no fixed edit quota or review transcript format
  is required.
- Before merging code changes, get an independent reviewer for concrete merge
  risks, including missing integration, documentation, or changesets. Prefer
  `change-risk-reviewer` when available. Use a different model from the author,
  and do not use Grok for review. Review relevant follow-up changes after fixes;
  reuse unchanged evidence. Coordinate reviewers with explicit file scope and
  preserve unrelated work.
- Address every review thread with a fix or precise reason. Re-check threads
  after a push; unresolved threads on an already-merged PR need a follow-up.
  PRs use squash merges. Merge only within the user's authorization.
- `main` has no required status checks (owner decision, 2026-09-06), so the local
  gate is the merge gate. Before merging code changes, run the following on a
  branch that contains current `origin/main`: `pnpm build`, `pnpm typecheck`,
  `pnpm lint`, and `pnpm test:unit`, plus integration/packed tests that exercise
  changed modules. Output-root, watcher, or public-type changes require the whole
  integration pool. Run
  `pnpm docs:site:build` when website or public exports changed. Record commands
  and results in the PR. Scope instruction-only checks as described above.
- A completed red CI run is a failed gate even when GitHub allows merging.
  After an authorized merge, watch the tip commit's CI and prioritize restoring
  green `main` before starting new work. Fix or revert failures attributable to
  the merge and coordinate unrelated failures with their owners. Superseded
  CI/Package preview runs may be cancelled by a newer push; docs/release runs
  must finish their deployment or publication.
- Use `gh pr update-branch` only for a reported conflict. Never use `--admin` or
  force-push `main`.

## Vendored repos

- `repos/` is **read-only reference material**. Do not edit, format, or import from `repos/**`.
- Application code imports the published npm package (`effect`), never a path under `repos/`.
- For unfamiliar Effect behavior, consult `repos/effect/LLMS.md` and the
  relevant linked stream, scope, concurrency, or error guidance. Known local
  patterns and installed types can answer routine edits without reading them all.
- Editor search, file watching, and auto-import exclude `repos/**`
  (`.vscode/settings.json`). Subtree updates ride the same named chore as
  the Effect RC re-pin — see `docs/effect-conventions.md`.
