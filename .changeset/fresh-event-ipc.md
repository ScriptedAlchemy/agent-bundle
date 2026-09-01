---
"agent-bundle": patch
---

Cancel shared event renders when their IPC client disconnects, decode split
UTF-8 request bytes incrementally, refuse to unlink live runtime sockets,
preserve event-route timeout milliseconds until native host projection, and
assign a fresh diagnostic to missing shared runtime hosts.
