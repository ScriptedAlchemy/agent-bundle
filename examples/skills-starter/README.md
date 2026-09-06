# Skills Starter

From the repository root, launch this example with:

```bash
pnpm example:skills
```

The command validates and builds the project, starts the foreground development
server, and opens the Agent Bundle Workbench. No API key or native host login is
required. Both eval suites are deterministic and read only checked-in fixtures.

## What is authored

- `agent-bundle.config.ts` declares the plugin and its portable, Codex, Claude,
  and Cursor targets. Skills, commands, and rules under `src/` are discovered
  automatically by convention, the model described in
  [`docs/framework-mode.md`](../../docs/framework-mode.md).
- `src/skills/incident-triage/SKILL.md` guides a production incident from first
  signal through containment, evidence collection, and a handoff-ready update.
- `src/skills/dependency-upgrade/SKILL.md` plans dependency upgrades with API,
  runtime, rollout, and rollback checks.
- `src/skills/release-review/SKILL.md` defines the evidence, severity, workflow,
  and final-report requirements for an explicit release review.
- Each Skill links its own `references/` checklist or runbook and reusable
  `assets/` handoff or planning template.
- `src/commands/review-release.md` and `src/rules/release-safety.mdc` provide
  host-native static content without an MCP server or executable renderer.
- `evals/release-readiness.eval.ts` defines the deterministic
  `release-artifact-is-ready` case and its checked-in evidence fixture.
- `evals/engineering-operations.eval.ts` directly exercises the incident and
  dependency-upgrade Skills with evidence and rollback/stop conditions.

## Workbench walkthrough

1. The shell header summarizes build health and current diagnostics.
2. Under **Application → Skills**, select `dependency-upgrade`,
   `incident-triage`, or `release-review`. Browse its linked checklists and
   report templates. Use the inspector to compare Source and Generated output
   and see whether a target copied or adapted the authored document. Every
   Skill shows its deterministic outcome-eval coverage;
   it is labeled indirect because the deterministic harness cannot observe host
   Skill activation.
3. Under **Application → Rules / Commands**, open authored and generated
   content directly. Unsupported hosts show their capability reason; nothing runs.
4. **Advanced → Artifact** shows each target's output tree and provenance.
5. **Advanced → Evals → Runs** defaults to the `release-readiness` suite. Run its deterministic
   `release-artifact-is-ready` case and inspect the passing trial. It consumes
   only the checked-in evidence fixture, so no model login or API key is needed.
6. To practice repair, make a reversible policy edit, press **Rebuild**, and
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
release-readiness verdict. Generated output is written to `artifact/`; its root
contract is `artifact/agent-bundle.manifest.json`. The `.agent-bundle/` directory
contains development state and is not source material.
