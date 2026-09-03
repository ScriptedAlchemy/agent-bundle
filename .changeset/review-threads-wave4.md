---
"agent-bundle": patch
"create-agent-bundle": patch
---

Harden the Codex plugin manifest, MCP probe reports, Doctor endpoint scans, CLI
help, and scaffolded README install instructions (#397).

- Reject line terminators, control characters, and backslash-form parent
  segments in the pinned Codex `plugin.json` `screenshots` paths, matching the
  component and interface-asset patterns; a manifest that relies on them now
  fails `AB6012` (pinned-schema rejection) and `AB6032` (Codex host validation)
  instead of validating. The Codex adapter is revision `1.9.0` and the composite
  `plugin` adapter `1.24.0`.
- Admit any-JSON `tool_input` on `permission/request` event envelopes only for
  the `codex` target, whose pinned schema declares it; `claude` envelopes keep
  the documented object requirement.
- `agent-bundle build --help` and `agent-bundle prepack --help` now state the
  `artifact` default for `--output` that those commands actually use.
- Workbench MCP probe reports keep `http(s)`/`ws(s)` documentation links while
  masking URL userinfo (`scheme://user:secret@host`) through the final authority
  delimiter, and fail closed on local-resource URIs such as `unix:///…` or
  `vscode://file/…` and on every other `scheme://…/…` form. Plugin-data
  directories are removed only after the transport teardown settles (bounded by
  a 10 s cap, with one fenced retry when a still-exiting child held the
  directory), a synchronously throwing `close()` no longer skips cleanup, a
  timeout's transport close is reused rather than duplicated, and Workbench
  shutdown (`server.close()`) joins in-flight probes and their detached
  cleanups.
- `agent-bundle doctor` probes runtime socket and lock endpoints eight at a
  time, so a directory of silent runtimes is bounded as a whole instead of
  costing one timeout per endpoint.
- `create-agent-bundle` renders README install instructions for the selected
  `--targets` (one `npx <bin> install <host>` line per installable host) instead
  of a hard-coded `install claude`; portable-only scaffolds explain that no
  installer bin is generated and name the `package.json` `bin` entry to restore
  alongside the config target to get one.
