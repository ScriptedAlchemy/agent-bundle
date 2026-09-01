---
"@agent-bundle/runtime": patch
---

Narrow the documented CLI claim to the `runRscCli` compatibility path: it
still serializes the validated result as one JSON line and never invokes
`render`, while routed `src/cli/**` `.tsx` commands render through the Agent
renderer's dispatcher (#102 stage 3). Documentation and pin-test wording
only; no runtime behavior changes.
