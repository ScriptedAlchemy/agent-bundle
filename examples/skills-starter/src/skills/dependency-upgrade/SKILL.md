---
name: dependency-upgrade
description: Plan, implement, or review a dependency upgrade that may change APIs, runtime support, generated output, or operational behavior.
---
# Dependency upgrade

Match the user's scope: a plan or compatibility review does not authorize
implementation, rollout, or publication. For implementation, complete the
requested upgrade and relevant validation before reporting it done.

Use [the compatibility checklist](references/compatibility-checklist.md) to
select checks for affected surfaces. For a proposal or rollout handoff, use
[the upgrade plan template](assets/upgrade-plan.md); mark unavailable evidence
explicitly rather than inventing a result or owner.

## Workflow

1. Record the current and proposed versions, why the change is needed, and the
   supported runtime/package-manager matrix.
2. Read primary release notes and migration guides. List removed APIs, default
   changes, peer requirements, and known regressions that intersect this repo.
3. Map affected imports, configuration, generated artifacts, consumers, and
   CI/release surfaces before editing.
4. When implementation is requested, make the smallest coherent change and run
   checks that exercise its affected behavior. Include builds or packed-consumer
   checks when emitted or published output is affected.
5. For release readiness, record rollout signals, rollback evidence, and real
   consumer verification. A planning task can finish with a concrete plan and
   clearly identified validation still needed before rollout.

## Final answer

State the compatibility decision, changed surfaces, evidence run, remaining
risk, rollout signal, and exact rollback trigger. Mark any item not yet
available for the requested scope.
