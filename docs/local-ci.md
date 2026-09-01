# Local CI gate

`pnpm check:local-ci` proves what the hosted CI gate proves, on the
development machine, in one command — including the full Node matrix. It
exists because a hosted Verify leg takes ~13–16 minutes while a many-core
development machine can run all three legs plus the release gates
concurrently in less wall time. The local-merge workflow it enables:

1. Run `pnpm check:local-ci` on the branch's HEAD commit.
2. If the gate is green, the branch is mergeable — merge it.
3. Hosted CI still runs on the merged commit (push to `main`) and stays the
   asynchronous post-merge safety net; if it disagrees with the local run,
   the hosted result wins and the merge gets a follow-up fix.

For quick iteration, `pnpm check:local-ci --current-node-only` runs a single
Verify-equivalent leg on whatever Node is currently active, with the repo's
normal local worker derivation. It skips the Node matrix and the
examples/release/micro-eval gates, so it is a fast signal, not a merge gate.

## What it runs

Every leg is an isolated git worktree pinned to the HEAD commit (uncommitted
changes are not covered — the runner warns), with its own `node_modules` and
its own `TMPDIR` (`.worktrees/local-ci/tmp/<leg>`, recreated every run).
The private temp root keeps concurrent legs from observing each other's
temp traffic: suites that assert temp-root hygiene (for example
`cli.test.ts` scans `os.tmpdir()` for leaked `agent-bundle-artifact-*`
directories) only ever see their own leg's directories, so a sibling leg's
in-flight work cannot fail them — while a directory the leg itself leaks
still fails its own scan. Legs live under `.worktrees/local-ci/`
(gitignored), are reused across runs for warm caches, and can be recreated
with `--fresh`.

| Local leg | Node | Steps | Mirrors hosted job |
| --- | --- | --- | --- |
| `verify-node22` | 22.19.x | `install`, `playwright install chrome`, `build`, `lint:package`, `typecheck`, `lint`, `test:unit`, `test:integration` | `verify (22.19.0)` |
| `verify-node24` | 24.x | same | `verify (24)` |
| `verify-node26` | 26.x | same | `verify (26)` |
| `gates-node22` | 22.19.x | `install`, `examples:check`, `check:release`, `eval:spot` | `examples-check`, `release-gates`, `rsc-runtime-micro-eval` |

The three hosted Node-22.19 jobs fold into one `gates-node22` worktree
because each of their entry scripts starts from `pnpm build` in a fresh
install, which one worktree provides just as well as three.

`gates-node22` runs the full `check:release`, a strict superset of the hosted
per-PR release-gates job (`check:release:ci`): it additionally runs the
scaffolder template matrix that the hosted side defers to the nightly
`packed-matrix` job, so local green covers both the per-PR and nightly packed
pools.

All four legs run concurrently. The summary table (leg × step × status ×
duration × test census) is printed and written to
`.worktrees/local-ci/summary.md` (plus `summary.json`); per-step logs land in
`.worktrees/local-ci/logs/`. The command exits non-zero if any step fails.

## Node provisioning

The runner introduces no new tooling. For each hosted runtime line
(22.19.x, 24.x, 26.x) it resolves a Node binary from, in order:

1. `AGENT_BUNDLE_LOCAL_CI_NODE_22` / `_24` / `_26` — a Node binary or bin
   directory, for machines with bespoke layouts;
2. `mise where node@<line>`;
3. `~/.nvm/versions/node/*`;
4. the current process's Node, if it matches the line.

Every resolved binary is version-checked against the hosted line before use.
If a line is missing, the runner fails with the exact install command (e.g.
`mise install node@22.19`). pnpm itself is pinned by reusing the entrypoint
that launched the runner, executed on each leg's own Node, so `pnpm`, its
lifecycle children, and `pnpm exec node` all agree on the leg's runtime —
`node_modules` trees (native modules such as the rspack bindings) are never
shared across Node ABIs, while the content-addressed pnpm store is shared
safely.

## Parallelism and time budgets

The integration pool derives workers from cores
(`rstest.integration.config.ts`), tuned for a leg that owns the machine. The
runner instead slices the machine: with N concurrent Verify legs each leg
gets `min(4, cores / (2 N))` integration workers
(`AGENT_BUNDLE_INTEGRATION_MAX_WORKERS`) and `cores / N` unit workers
(`--pool.maxWorkers`), and full runs pin `AGENT_BUNDLE_TEST_TIME_SCALE=4` —
the same polling-budget scale hosted CI uses — because four legs sharing a
machine is exactly the contention that scale exists for. Exporting
`AGENT_BUNDLE_TEST_TIME_SCALE` yourself (e.g. when the machine is also
running other heavy work) overrides the default; the integration config
never lets it drop below what its own pool shape requires.

## What is deliberately not covered

- **dependency-review** runs as a GitHub-side action against the GitHub
  advisory database on the PR diff; it has no local equivalent and stays a
  hosted-only, PR-time check.
- **package-preview** (pkg.pr.new) and the **release publish** workflow are
  publish-side effects, not checks; nothing about them gates a merge.
- **native-host-smoke** needs signed-in Claude/Codex CLIs and is opt-in even
  on hosted CI.
- **Environment skew**: hosted runners are `ubuntu-latest` with the exact
  glibc/OS package set `--with-deps` installs, and hosted Verify installs
  branded Chrome fresh. A green local run on a different distro, glibc, or
  Chrome build is strong but not identical evidence — this is the main
  reason hosted CI remains the post-merge safety net. The local `browsers`
  step only validates/installs the browser itself (`playwright install
  chrome`); the OS dependencies (`--with-deps`) are one-time machine setup
  and may need root.
- **Job isolation**: hosted gives every job a fresh VM; local legs reuse
  worktrees for speed. `--fresh` restores cold-start fidelity when staleness
  is suspected.
