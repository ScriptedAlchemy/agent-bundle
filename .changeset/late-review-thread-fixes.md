---
"agent-bundle": patch
---

`agent-bundle dev` now leases the adopted epoch until another epoch replaces it
or the server closes, so store retention cannot delete the advertised last-good
build during a run of failing rebuilds, and an epoch that cannot be leased is
reported as `AB7211` instead of adopted; the `dev.contracts` matrix opens the
configured server on a target whose manifest carries it, applies the session
timeout per request, and observes lifecycle progress through the session trace
(`ContractMatrixClient` from `agent-bundle/test` gains an optional
`observeProgress` seam, `ContractMatrixProgressSource`). Native Playground
catalog readers wait for a hard-link publisher to release its staging link
before adopting the sidecar and return to discovery when that publication is
rolled back. `agent-bundle build` and `validate --artifact` run the Agent
Plugins byte lane over the emitted `portable/` tree (`AB6035`–`AB6037`) so
standard-invalid documents fail before publication rather than only under
`--host-validation`, and header values reject every forbidden control character.
`agent-bundle inspect` projects only the contract fields of an adapter
capability row, so JavaScript adapter extension fields cannot shadow the
capability name or break `--json`. (#408)
