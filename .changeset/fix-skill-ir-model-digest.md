---
"agent-bundle": patch
---

Fix root-independent model digest canonicalization for Skill IR fields added in #185.

`skillIr` and `hostDocuments` carried absolute filesystem paths into `modelDigest`, breaking cross-checkout identity for equivalent projects.
