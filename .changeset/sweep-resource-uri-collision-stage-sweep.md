---
"agent-bundle": patch
---

Reject two MCP App routes of one generated server that declare the same static `config.resourceUri` with the new `AB4829` diagnostic, naming both route files and the server, instead of registering whichever route was discovered first; the same URI on App routes of different servers still passes, since each generated server registers only its own Apps. Sweep staging files (`.<epoch>.stage-<pid>-<nonce>`) that an exited native Playground catalog publisher left orphaned on the next catalog publication: only singly linked entries of another epoch in the publisher's own directory are removed, a live winner's hard-linked staging entry, a running publisher's file, and foreign files are kept, and the sweep is bounded per publish (#430)
