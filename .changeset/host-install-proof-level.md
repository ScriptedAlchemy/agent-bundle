---
"agent-bundle": minor
---

Add the `host-install` consumer proof level for real public-path installation
into isolated Claude, Codex, and Cursor homes. The source-built proof fixture
exercises Skills, Hooks, and MCP registration without model calls or packed
artifact claims, validates Cursor's emitted documents against the pinned
schemas, and records only path-relative evidence.

The level now also carries the real-host token proofs deferred from the
canonical Skill IR work. The Codex proof asserts the installed cache copy of a
skill's `agents/openai.yaml` sidecar is byte-identical to the built artifact and
valid against the pinned schema, and that the installed `.codex-plugin/plugin.json`
carries its `interface` block. The Cursor proof asserts the installed hooks and
MCP documents keep `${CURSOR_PLUGIN_ROOT}` unresolved, which is the honest
ceiling because Cursor publishes no non-interactive plugin-loading session
surface. An opt-in session-token qualifier
(`AGENT_BUNDLE_HOST_INSTALL_CLAUDE_SESSION=1`) observes `$ARGUMENTS`,
`${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}` resolving inside one real
`claude -p` turn with the built bundle loaded inline via `--plugin-dir`.

Generated Claude and Codex installation instructions now use
`plugin marketplace add ./`; Claude Code 2.1.257 rejects the previously emitted
bare `.` source.
