---
"agent-bundle": patch
---

Remove the release audit gate: `pnpm audit:release` no longer runs `scripts/audit-packed-release.mjs` (consumer install, `npm audit`, `npm audit signatures`, CycloneDX SBOM, and LICENSE/NOTICE tarball checks), and the packaged README no longer states that it fails on missing license files; `audit:release` is now publint plus attw only (#487)
