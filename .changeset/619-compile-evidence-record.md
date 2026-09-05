---
'agent-bundle': patch
---

Record compile evidence beside the emitted files: `agent-bundle build`
writes `agent-bundle.compile-evidence.json` at the artifact root;
`agent-bundle validate --artifact` verifies it against the manifest
file table (`AB6039`). (#638)
