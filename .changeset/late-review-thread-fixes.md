---
"agent-bundle": patch
---

Address the post-merge review findings on the dev epoch gate, native catalog,
portable validation, and inspection (#408):

- `agent-bundle dev` leases the adopted epoch until another epoch replaces it
  or the server closes, so store retention cannot delete the advertised
  last-good build during a run of failing rebuilds; an epoch that cannot be
  leased is not adopted and the failure is published as `AB7211` status.
- The `dev.contracts` matrix opens the configured server on a target whose
  manifest actually carries it, applies the session timeout per request instead
  of once for the whole matrix, and observes live progress through the session
  trace; lifecycle fixtures no longer depend on the SDK client's private
  `_notificationHandlers` map (`ContractMatrixClient` from `agent-bundle/test`
  gains an optional `observeProgress` seam, exported as
  `ContractMatrixProgressSource`).
- A Native Playground catalog reader waits for a hard-link publisher to release
  its staging link before adopting the sidecar, and returns to discovery when
  that publication is rolled back instead of caching a withdrawn epoch.
- `agent-bundle build` and `validate --artifact` run the Agent Plugins byte lane
  over the emitted `portable/` tree (`AB6035`–`AB6037`), so standard-invalid
  documents fail before publication rather than only under `--host-validation`;
  header values reject every forbidden control character, not just CR/LF/NUL.
- `agent-bundle inspect` projects only the contract fields of an adapter
  capability row, so extension fields on JavaScript adapters cannot shadow the
  capability name or break `--json` serialization.
