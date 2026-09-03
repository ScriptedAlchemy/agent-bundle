---
name: dependency-upgrade
description: Plans and verifies dependency upgrades with compatibility, rollout, and rollback evidence.
---
# Dependency upgrade

## When to use

Use this Skill for a library, runtime, toolchain, or platform upgrade that can
change public APIs, generated output, operational behavior, or support policy.

## Required resources

- Apply [the compatibility checklist](references/compatibility-checklist.md).
- Write the proposal with [the upgrade plan template](assets/upgrade-plan.md).

## Workflow

1. Record the current and proposed versions, why the change is needed, and the
   supported runtime/package-manager matrix.
2. Read primary release notes and migration guides. List removed APIs, default
   changes, peer requirements, and known regressions that intersect this repo.
3. Map affected imports, configuration, generated artifacts, consumers, and
   CI/release surfaces before editing.
4. Implement the smallest coherent increment and run focused contract tests,
   type checks, production builds, and packed-consumer checks.
5. Define rollout signals and a tested rollback path. Do not call the upgrade
   complete until shipped output and a real consumer both pass.

## Final answer

State the compatibility decision, changed surfaces, evidence run, remaining
risk, rollout signal, and exact rollback trigger.
