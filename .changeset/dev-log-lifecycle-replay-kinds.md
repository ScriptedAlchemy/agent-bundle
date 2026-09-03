---
"agent-bundle": patch
---

Stop the Workbench dropping every lifecycle-replay Dev Log record. The browser
log client re-declared the Dev Log vocabulary that
`agent-bundle/contracts/dev-logs` already exports, and the copy had drifted: its
`hook` kind list was missing `lifecycle.replay.started`, `.completed`, and
`.failed`, and its context allow-list was missing `routeId`. Records emitted by
the lifecycle replay service failed both checks and never reached the Logs view.
The client now imports the shared vocabulary, and `safeContextKeys` moves to the
dependency-free `dev-log-kinds` module so the service and the client cannot
diverge again.
