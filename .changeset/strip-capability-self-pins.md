---
"agent-bundle": minor
---

Remove `capabilityRevision` and `capabilitySha256` from manifest targets,
`CapabilityEvidence`, and `TargetAdapterMetadata`, and rename
`TargetHookContract.capabilityRevision` to `hostContractRevision`. Hash pins
remain for vendored external schemas, including the Agent Skills schema.
