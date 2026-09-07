---
'agent-bundle': patch
---

Correct four portable client records in the pinned capability table and the
`INSTALL.md` and host-reference text rendered from them: GitHub Copilot CLI
records `.plugin/plugin.json` as the one manifest location its published order
puts ahead of the emitted root (the emitted root still wins over
`.claude-plugin/plugin.json`) and `.mcp.json` as the MCP location it publishes
for a plugin, and narrows its `mcp` row to the listed stdio server it was
proven on; CodeWhale's `mcp` row names the remote endpoint,
header, secret-URL, redirect and `capabilities.network_hosts` restrictions its
plugin boundary imposes, and that the host declaration rides in
`extensions["net.codewhale"]`, which only an authored `portable.extensions`
emits; VS Code's `chat.pluginLocations` action carries the `register` role,
since it loads the directory in place (Cline keeps `install`, because its
action copies the tree); and Hermes records the new `repository` install source
for `hermes plugins install <owner>/<repository> --no-enable`, a Git repository
rather than an indexed marketplace name. A `register` action is now refused
against anything but a local directory, a non-local install names its source in
the generated instructions, and the generated host reference gains an
install-source column in both locales. (#732)
