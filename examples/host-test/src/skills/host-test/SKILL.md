---
name: host-test
description: Probe what this host sends to plugin hooks and MCP servers. Use when asked to run the host-test probe, dump host lineage, or check which conversation, session, or subagent ids a hook or MCP call carries.
---

# Host test probe

This plugin records every hook event the host dispatches to it, plus every
call to its own MCP servers, into one NDJSON log and a durable state summary.
Nothing it records is sent anywhere; the log stays on this machine.

## When to use

- The user asks to "run the host-test probe", "dump the host log", or asks
  which ids (conversation, session, subagent, tool call) this host exposes.
- You are a subagent and were asked to prove what the host tells plugins
  about your parent.

## Steps

1. Run one shell command (for example `pwd`) so a tool hook fires.
2. Edit or create a small scratch file so a file-edit hook fires.
3. Call the `host-test` MCP server's `dump` tool with no arguments.
4. If a `probe` tool from the `host-test-raw` server is available, call it once
   with `note` set to your own role (`root` or `subagent`).
5. If you can spawn a subagent, ask it to do steps 1, 3, and 4 with
   `note: "subagent"` and to report the `log` path and the ids it saw.
6. Report the log path and the ids the dump shows, verbatim, without editing
   the log file.

Never delete or rewrite the log by hand; the `reset` tool is the only way to
clear it, and only when the user asks for a fresh probe.
