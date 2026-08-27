# Skills Starter

From the repository root, launch this example with:

```bash
pnpm example:skills
```

The command validates and builds the project, starts the foreground development
server, and opens the Agent Bundle Workbench. No API key or native host login is
required. Both eval suites are deterministic and read only checked-in fixtures.

## What is authored

- `agent-bundle.config.ts` declares the plugin, its three Skills, and portable, Codex,
  and Claude targets.
- `skills/incident-triage/SKILL.md` guides a production incident from first
  signal through containment, evidence collection, and a handoff-ready update.
- `skills/dependency-upgrade/SKILL.md` plans dependency upgrades with API,
  runtime, rollout, and rollback checks.
- `skills/release-review/SKILL.md` defines the evidence, severity, workflow,
  and final-report requirements for an explicit release review.
- Each Skill links its own `references/` checklist or runbook and reusable
  `assets/` handoff or planning template.
- `evals/release-readiness.eval.ts` defines the deterministic
  `release-artifact-is-ready` case and its checked-in evidence fixture.
- `evals/engineering-operations.eval.ts` directly exercises the incident and
  dependency-upgrade Skills with evidence and rollback/stop conditions.

## Workbench walkthrough

1. **Overview** opens on the Bundle dashboard. It summarizes the three Skills,
   generated targets, build health, and the next useful actions.
2. **Skills** lists `dependency-upgrade`, `incident-triage`, and
   `release-review`. Browse their linked checklists and report templates. Switch
   between Source and Generated to see whether a target copied or adapted the
   authored document. Every Skill shows its deterministic outcome-eval coverage;
   it is labeled indirect because the deterministic harness cannot observe host
   Skill activation.
3. **Artifacts** defaults to the Claude target. Change the target to compare
   the portable, Codex, and Claude output trees and their provenance.
4. **Evals** defaults to the `release-readiness` suite. Run its deterministic
   `release-artifact-is-ready` case and inspect the passing trial. It consumes
   only the checked-in evidence fixture, so no model login or API key is needed.
5. To practice repair, make a reversible policy edit, press **Rebuild**, and
   wait for the failed or idle result rather than a Building state. Restore the
   checked-in policy and rebuild. The prior eval becomes stale for the changed
   build; rerun `release-readiness` to record current, repaired evidence.

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
