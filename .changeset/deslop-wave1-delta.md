---
'agent-bundle': patch
'@agent-bundle/runtime': patch
---

Deslop pass over the Wave 1 delta: `config/normalize.ts` reuses the shared `core/freeze.ts` `deepFreeze` instead of a local copy, the internal `configClaimedSources` helper is no longer exported, the dev-lock URL publication settles through one named cleanup, and the rsc-runtime CLI binding drops a redundant `Object.freeze` (the request store snapshots and freezes capabilities itself). No behavior changes.
