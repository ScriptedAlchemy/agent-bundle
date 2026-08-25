---
name: release-review
description: Reviews release evidence and issues an auditable readiness verdict.
---
# Release review

## When to use

Use this Skill when a release candidate needs a go/no-go verdict supported by
checked, reproducible evidence.

## Required resources

- Read [the release checklist](references/checklist.md) to inspect the artifact.
- Apply [the release readiness policy](references/release-policy.md) to classify findings.
- Deliver the result with [the release readiness report template](assets/report-template.md).

## Workflow

1. Gather evidence for each checklist item. Cite the command, artifact path,
   observed result, and reproduction steps for every finding.
2. Classify each finding using the policy severity. A blocker prevents a
   `ready` verdict; unresolved non-blockers must still be disclosed.
3. Decide the verdict only after all required evidence is recorded. Use
   `ready` only when there are no blockers.
4. Complete every section of the report template: verdict, evidence, findings,
   blockers, and required follow-up.

## Final report requirements

The final report must state `ready`, `not ready`, or `needs evidence`; list
all evidence reviewed; give each finding a severity and reproduction; and make
the blocker count explicit. Do not issue `ready` when evidence is missing or a
blocker remains.
