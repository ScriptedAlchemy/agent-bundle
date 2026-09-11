---
"agent-bundle": patch
---

Make `agent-bundle dev --install-host` remove stale manager-published entries while preserving neighboring host and user state, including rollback after a failed epoch publication. (#783)
