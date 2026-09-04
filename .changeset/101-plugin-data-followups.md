---
"agent-bundle": patch
---

Harden `agent-bundle uninstall cursor` and the emitted `install.mjs --uninstall` around the Cursor `PLUGIN_DATA` directory: a symlinked `~/.cursor/agent-bundle` or `agent-bundle/plugin-data` ancestor is refused (`AB7007`) before the recorded directory is read or purged; a default rerun over a `--keep-data` remnant whose preserved `state/` or `PLUGIN_DATA` has since been removed or emptied by hand (an empty directory is pruned, never kept as data) now consumes the remnant (receipt, empty plugin root, recorded host and `plugin-data` directories) instead of staying a `not-installed` no-op forever; and `agent-bundle doctor` names the `PLUGIN_DATA` directory in `AB7307` only when it is this home's real, non-empty directory, reporting a remnant whose preserved state is gone as exhausted instead of inventing `state/`. Follow-up to the review threads on #452. (#519)
