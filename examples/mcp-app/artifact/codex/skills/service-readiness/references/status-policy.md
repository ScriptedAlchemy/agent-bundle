# Service status policy

## Evidence standard

Readiness evidence must identify the service, collection time, check label,
observed status, and source command or artifact. Missing or stale evidence is
not a passing check.

## Status classification

- **Healthy**: every required release check is passing.
- **Degraded**: availability remains sufficient, but a release threshold such
  as P95 latency is failing. Record an owner and mitigation before release.
- **Blocked**: availability or a critical safety check is failing. Do not
  release until new passing evidence is collected.
- **Needs evidence**: the service or any required check cannot be verified.

## Release decision

Issue `ready` only for a healthy service with current evidence. A degraded
service needs an explicit mitigation decision; a blocked service cannot pass;
and missing evidence requires a new check rather than an assumption.
