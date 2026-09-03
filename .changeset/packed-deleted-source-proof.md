---
'agent-bundle': patch
---

Add the `packed-deleted-source` consumer proof level to `agent-bundle/test`.

`removeProjectSource` removes conventional project inputs and returns a frozen
receipt, while `openPackedMcpServer({ deletedSource })` verifies every receipt
path is still absent immediately before spawn and upgrades its provenance only
then.

The repository's single packed harness journey now builds once, removes the
fixture source and configuration, spawns once, asserts every route, and proves
the generated server serves its self-contained embedded MCP App resource.
Packed test and release scripts also accept both npm 11's array and npm 12's
package-keyed object forms of `npm pack --json`.
