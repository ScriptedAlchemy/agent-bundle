---
"agent-bundle": patch
---

Make `dev --install-host` restart idempotently from a stable project path, remove its receipt-owned host registration on exit, report dangling Claude or Codex marketplace sources as `AB7333` in Doctor, and let `uninstall --force` remove them. (#676)
