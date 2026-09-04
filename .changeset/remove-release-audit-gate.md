---
"agent-bundle": patch
---

Remove the release audit gate: the `audit:release` script that ran `scripts/audit-packed-release.mjs` (external consumer install, npm advisory and signature checks, CycloneDX SBOM, LICENSE/NOTICE tarball checks) is replaced by `lint:release`, which runs publint and attw only, and the packaged README no longer states that the release gate fails on missing license files (#487)
