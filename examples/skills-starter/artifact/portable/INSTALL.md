# Install skills-starter

A practical engineering operations bundle for incidents, dependency upgrades, and releases.

Version: `1.0.0`

Run these commands from this bundle directory.

## Portable Agent Plugin

Portable is a distribution profile, not a host runtime with one universal install location.
This bundle follows the Agent Plugins open standard (Agent Plugins 1.0.0, https://agent-plugins.org).
Cursor loads this format natively from `~/.cursor/plugins/local/<name>`; restart Cursor or run
`Developer: Reload Window` after copying it. Codex, VS Code, GitHub Copilot, Kiro, and ChatGPT
are also native clients. The bundled installer provides the Cursor local copy:

```sh
node ./install.mjs
```
