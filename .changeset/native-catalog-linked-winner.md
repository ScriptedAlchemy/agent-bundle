---
"agent-bundle": patch
---

Native Playground catalog readers no longer reject a sidecar that a concurrent publisher has just hard-linked into place but not yet released its staging file for. Hard-link publication legitimately leaves the sidecar doubly linked until the winner unlinks its `.stage-` file; a loser (or any reader) arriving inside that window previously failed with `Native Playground catalog snapshot is invalid.` instead of adopting the winner. The extra link is now accounted for by identity — exactly one same-epoch staging sibling shares the sidecar's dev/ino, or the still-open handle reports a single link once the staging file is gone — and any other extra hard link stays rejected as aliasing.
