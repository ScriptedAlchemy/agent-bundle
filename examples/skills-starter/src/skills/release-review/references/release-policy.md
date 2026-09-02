# Release readiness policy

## Evidence standard

Release evidence must be specific, reproducible, and tied to the candidate:
record the command, artifact path, observed result, and reproduction steps.
Missing or stale evidence is not proof of readiness.

## Severity

- **Blocker**: prevents safe release, violates a documented contract, or has no
  viable mitigation. Any blocker requires a `not ready` verdict.
- **Major**: materially degrades a supported workflow. It must have an owner,
  mitigation, and release decision recorded in the report.
- **Minor**: limited-scope issue with an agreed follow-up. It does not prevent
  `ready` when its evidence and owner are recorded.

## Verdict policy

Issue `ready` only when all required evidence is current and the blocker list
is empty. Issue `needs evidence` when required evidence is absent, stale, or
cannot be reproduced. Otherwise issue `not ready`.
