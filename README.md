# agent-bundle

Build portable AI-agent plugins from one typed source configuration.

`agent-bundle` is intended to play the same role for agent plugins that Rslib plays for
JavaScript libraries: discover conventional source files, validate their contracts, compile
scripts and servers, and emit native bundles for supported agent hosts.

The initial design targets the portable Agent Plugins layout, Codex, and Claude Code. See
[`docs/plans/2026-08-13-agent-bundle-design.md`](docs/plans/2026-08-13-agent-bundle-design.md)
for the approved architecture.

This repository is currently at the design-foundation stage.
