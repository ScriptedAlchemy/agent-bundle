---
name: host-test
description: Inspect host-test logs or probe hook, MCP, conversation, session, subagent, and lineage data.
---

# Host test probe

This plugin records every hook event the host dispatches to it, plus every
call to its own MCP servers, into one NDJSON log and a durable state summary.
Nothing it records is sent anywhere; the log stays on this machine.

## Inspect or probe

For a log or identity question, call the `host-test` MCP server's `dump` tool
and report the relevant observed ids and log path. Existing records may answer
the question without a live probe. The `dump` call itself is recorded;
distinguish absent evidence from an unsupported host capability.

For a requested live probe, generate only the evidence needed:

- Run a harmless shell command such as `pwd` for tool-hook evidence.
- Create a small scratch file for file-edit-hook evidence.
- If `host-test-raw` exposes `probe`, call it with your role (`root` or
  `subagent`) as the note.
- For parent/subagent lineage, ask a subagent to run the shell and available
  probe calls, then dump the resulting records. A log-only request does not
  require spawning an agent.

Dump the resulting records and report the relevant ids verbatim, without
editing the log. Do not include unrelated payloads in the response.

Never delete or rewrite the log by hand; the `reset` tool is the only way to
clear it, and only when the user asks for a fresh probe.
