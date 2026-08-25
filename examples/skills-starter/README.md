# Skills Starter

From the repository root, launch this example with:

```bash
pnpm example:skills
```

The command validates and builds the project, starts the foreground development
server, and opens the Agent Bundle Workbench. No API key or native host login is
required. The release-readiness eval is deterministic and reads only its
checked-in fixture.

## What is authored

- `agent-bundle.config.ts` declares the plugin, its Skill, and portable, Codex,
  and Claude targets.
- `skills/release-review/SKILL.md` defines the evidence, severity, workflow,
  and final-report requirements for an explicit release review.
- `references/checklist.md` and `references/release-policy.md` provide the
  checklist and verdict policy loaded only when needed.
- `assets/report-template.md` is the reusable readiness report template.
- `evals/release-readiness.eval.ts` defines the deterministic
  `release-artifact-is-ready` case and its checked-in evidence fixture.

## Workbench walkthrough

1. Open **Overview** to see the active artifact epoch and its three targets.
2. Open **Skills**, select `release-review`, and compare the authored document
   with its generated target documents and linked resources.
3. Open **Evals**, run `release-readiness`, and inspect the passing
   `release-artifact-is-ready` trial. Its explicit invocation keeps authored
   Skill coverage distinct from automatic coverage.
4. Open **Artifacts** to inspect the portable, Codex, and Claude output trees
   and provenance.
5. Edit the release policy, press **Rebuild**, then return to **Evals**. If the
   previous run is marked stale for the changed artifact epoch, select that
   diagnostic and rerun `release-readiness` to repair it with current evidence.

## Noninteractive checks

After the repository-level `pnpm build` has built the local `agent-bundle`
workspace dependency, the package-local workflow is:

```bash
cd examples/skills-starter
pnpm validate
pnpm build
pnpm exec agent-bundle eval --case release-artifact-is-ready --trials 1
pnpm dev
```

Use `pnpm check` when you want validation and a build without starting the
Workbench; run the deterministic eval command separately when you need the
release-readiness verdict. Generated output is written to `dist/`; its root
contract is `dist/agent-bundle.manifest.json`. The `.agent-bundle/` directory
contains development state and is not source material.
