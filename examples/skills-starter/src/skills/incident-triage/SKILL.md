---
name: incident-triage
description: Triages production incidents with evidence-first containment and a clear operational handoff.
---
# Incident triage

## When to use

Use this Skill when an alert, customer report, or operator observation suggests
an active production incident and the team needs a fast, auditable first pass.

## Required resources

- Follow [the triage runbook](references/triage-runbook.md) for the first 30 minutes.
- Record the handoff with [the incident update template](assets/incident-update.md).

## Workflow

1. Establish impact: affected users, services, regions, start time, and the
   strongest known symptom. Separate observed facts from hypotheses.
2. Preserve evidence before changing the system: relevant request IDs, logs,
   metrics, deploys, feature flags, and dependency health.
3. Choose the smallest reversible containment action. State its expected signal
   and rollback condition before executing it.
4. Re-evaluate impact after containment. Escalate when severity, ownership, or
   blast radius remains uncertain.
5. Produce an incident update with timeline, current impact, actions, owners,
   open questions, and the next update time.

## Guardrails

- Never claim root cause from correlation alone.
- Never expose credentials, customer payloads, or private identifiers.
- Never make a destructive or irreversible change without explicit authority.
