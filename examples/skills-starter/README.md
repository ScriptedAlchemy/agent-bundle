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

1. **Overview** opens on the Bundle dashboard. Its ordered Author, Build,
   Exercise, and Evaluate stages link to the pages where the corresponding
   evidence lives; the status below them is the current artifact epoch.
2. **Skills** defaults to `release-review`. Compare the authored `SKILL.md`,
   linked checklist and policy resources, and the generated target document;
   the page also marks the explicit deterministic eval coverage.
3. **Artifacts** defaults to the Claude target. Change the target to compare
   the portable, Codex, and Claude output trees and their provenance.
4. **Evals** defaults to the `release-readiness` suite. Run its deterministic
   `release-artifact-is-ready` case and inspect the passing trial. It consumes
   only the checked-in evidence fixture, so no model login or API key is needed.
5. To practice repair, make a reversible policy edit, press **Rebuild**, and
   wait for the failed or idle result rather than a Building state. Restore the
   checked-in policy and rebuild. The prior eval becomes stale for the changed
   epoch; rerun `release-readiness` to record current, repaired evidence.

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
