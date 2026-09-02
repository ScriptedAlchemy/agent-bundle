---
name: service-readiness
description: Reviews service health evidence and records an auditable readiness decision.
---
# Service readiness

## When to use

Use this Skill when a release, incident decision, or service handoff needs a
clear health verdict backed by named checks and current evidence.

## Required resources

- Apply [the service status policy](references/status-policy.md) before
  classifying a healthy, degraded, or blocked result.
- Deliver the decision with [the readiness report](assets/readiness-report.md).

## Workflow

1. Identify the service and collect its current summary and every labelled
   check. Record the command, time, result, and evidence source.
2. Classify any failing check with the status policy. A degraded service is not
   release-ready until its failing check has an approved mitigation.
3. State the readiness verdict only after confirming availability and the
   service-specific release threshold.
4. Complete the report with the status, checks, evidence, owner, and next
   action. Do not omit a failing check from the final decision.

## Final report requirements

State `ready`, `degraded`, `blocked`, or `needs evidence`; reproduce the
service summary; list each labelled check and its status; identify the owner
and due date for every non-passing check; and name the next required action.
